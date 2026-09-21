import { keccak256, pad, toHex, type Abi, type Address, type Hex } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { HashPowerPerpsDEXAbi } from "derivatives-marketplace-abi/HashPowerPerpsDEX.ts";
import { sendLiquidate } from "../tx/liquidate.ts";
import { readAccountSnapshot, readMMParams } from "../predict/snapshot.ts";
import { type MMParams, solvePerpCloseToTarget } from "@hashpower/portfolio-margin";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
import { PerpsPositionAbi } from "./perpsPositionAbi.ts";
import type {
  LiquidateOrdersOutcome,
  MarketId,
  ReduceToTargetOutcome,
  Venue,
  VenueOrder,
  VenuePosition,
} from "./types.ts";

/** Local fragment until published perps ABI includes `liquidateOrders(user, ids[])`. */
const LIQUIDATE_ORDERS_ABI = [
  {
    type: "function",
    name: "liquidateOrders",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_user", type: "address" },
      { name: "_orderIds", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

const PERPS_LIQUIDATE_ORDERS_ABI = [
  ...HashPowerPerpsDEXAbi,
  ...LIQUIDATE_ORDERS_ABI,
] as Abi;

/**
 * `Venue` adapter for HashPowerPerpsDEX. Stateless beyond the wiring it
 * receives — no per-instance caches; perps has a single market and the
 * planner re-reads everything per liquidation cycle.
 */
export class PerpsVenue implements Venue {
  readonly name = "perps" as const;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly ethUsdFeed: EthUsdFeed | undefined;
  private mmParams: MMParams | undefined;

  constructor(
    chain: Chain,
    config: Config,
    logger: pino.Logger,
    ethUsdFeed?: EthUsdFeed,
  ) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ venue: "perps" });
    // See note in FuturesVenue — optional ETH/USD feed for `gasCostUsd`
    // enrichment on confirmed-tx logs.
    this.ethUsdFeed = ethUsdFeed;
  }

  marketLabel(_marketId: MarketId): string {
    return "perps";
  }

  async readOpenOrders(user: Address): Promise<VenueOrder[]> {
    const ids = (await this.chain.publicClient.readContract({
      address: this.config.perps.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getUserOrders",
      args: [user],
    })) as readonly Hex[];

    // Each id maps 1:1 to PERPS_MARKET_ID — no per-order metadata needed
    // by the planner today; the id alone is sufficient for `liquidateOrder`.
    return ids.map((id) => ({ id, marketId: PERPS_MARKET_ID }));
  }

  async readPositions(user: Address): Promise<VenuePosition[]> {
    // Single-market netted position. The signed entry value lets us derive PnL
    // directly without reconstructing a rounded average entry price.
    const [position, marketPrice] = await this.chain.publicClient.multicall({
      contracts: [
        {
          address: this.config.perps.address,
          abi: PerpsPositionAbi,
          functionName: "getUserPosition" as const,
          args: [user] as const,
        },
        {
          address: this.config.perps.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "getMarketPrice" as const,
        },
      ] as const,
      allowFailure: false,
    });

    if (position.netQuantity === 0n) return [];

    const absQty = abs(position.netQuantity);
    const isLong = position.netQuantity > 0n;
    // PnL in token decimals: mark value minus the signed entry value.
    const pnl = (marketPrice * position.netQuantity) / QUANTITY_SCALE - position.netEntryValue;
    const unrealizedLoss = pnl < 0n ? -pnl : 0n;
    const notional = (marketPrice * absQty) / QUANTITY_SCALE;

    this.logger.debug(
      {
        user,
        isLong,
        qty: position.netQuantity,
        marketPrice,
        unrealizedLoss,
        notional,
      },
      "perps position read",
    );

    return [
      {
        id: perpsPositionId(user),
        marketId: PERPS_MARKET_ID,
        unrealizedLoss,
        notional,
      },
    ];
  }

  /**
   * Cancels keeper-chosen resting orders via `liquidateOrders(user, ids[])`.
   * On-chain stop-on-failure keeps prior cancels and stops when healthy.
   */
  async liquidateOrders(
    user: Address,
    ids?: readonly Hex[],
  ): Promise<LiquidateOrdersOutcome> {
    let targetIds = ids;
    if (targetIds === undefined) {
      const fetched = (await this.chain.publicClient.readContract({
        address: this.config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getUserOrders",
        args: [user],
      })) as readonly Hex[];
      targetIds = fetched;
    }

    if (targetIds.length === 0) {
      return { skipped: "notLiquidatable" };
    }

    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger: this.logger,
      address: this.config.perps.address,
      abi: PERPS_LIQUIDATE_ORDERS_ABI,
      functionName: "liquidateOrders",
      args: [user, targetIds],
      feeEventName: "OrderLiquidated",
      ethUsdFeed: this.ethUsdFeed,
    });

    return "skipped" in result
      ? { skipped: "notLiquidatable" }
      : { feeEarned: result.feeEarned };
  }

  async reduceToTarget(user: Address): Promise<ReduceToTargetOutcome> {
    // Size the partial close off-chain against a fresh snapshot so the account
    // lands inside the [MM, IM] band (or a full close on a deep crash).
    const [snapshot, params, marketPrice] = await Promise.all([
      readAccountSnapshot(this.chain, this.config, user),
      this.getMMParams(),
      this.chain.publicClient.readContract({
        address: this.config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getMarketPrice",
      }) as Promise<bigint>,
    ]);

    // The contract's liquidation-fee payout is disabled, so the close realizes no
    // fee — pass 0 to the solver so its balance projection matches on-chain reality.
    const closeQty = solvePerpCloseToTarget(snapshot, params, marketPrice, 0n);
    if (closeQty === 0n) {
      return { skipped: "nothingToClose" };
    }

    const absNet = snapshot.perp.netQty < 0n ? -snapshot.perp.netQty : snapshot.perp.netQty;
    this.logger.info(
      { user, closeQty, absNet, fullClose: closeQty >= absNet },
      "Perps reduceToTarget: partial close down to the IM buffer",
    );

    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger: this.logger,
      address: this.config.perps.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "liquidatePosition",
      args: [user, closeQty],
      feeEventName: "PositionLiquidated",
      mapSkip: (errorName) => {
        if (errorName === "OrdersStillOpen") return "ordersStillOpen";
        // `NotLiquidatable` (price race / already healthy) and any other
        // recoverable revert collapse to `notLiquidatable` — the planner's
        // recheck-then-retry loop re-snapshots and re-sizes.
        return "notLiquidatable";
      },
      ethUsdFeed: this.ethUsdFeed,
    });

    return "skipped" in result
      ? { skipped: result.skipped }
      : { feeEarned: result.feeEarned, positionsClosed: 1 };
  }

  /** Read + cache the PME engine params (shocks / decimals). Immutable per epoch. */
  private async getMMParams(): Promise<MMParams> {
    if (this.mmParams !== undefined) return this.mmParams;
    this.mmParams = await readMMParams(this.chain, this.config);
    return this.mmParams;
  }
}

/** Single sentinel marketId — perps is single-market today. */
export const PERPS_MARKET_ID: MarketId = keccak256(toHex("perps"));

/** Perps quantities are scaled by 10^QUANTITY_DECIMALS (=6 in HashPowerPerpsDEX). */
const QUANTITY_SCALE = 1_000_000n;

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * `bytes32(uint160(user))` — perps has at most one position per user (net),
 * so we synthesize a deterministic id from the user address. The contract
 * itself doesn't take a positionId for `liquidatePosition`; this id is only
 * used by the planner for cross-venue ranking and logging.
 */
function perpsPositionId(user: Address): Hex {
  return pad(user, { size: 32 });
}
