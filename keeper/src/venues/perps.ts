import { keccak256, pad, toHex, type Address, type Hex } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { HashPowerPerpsDEXAbi } from "derivatives-marketplace/HashPowerPerpsDEX.ts";
import { sendLiquidate } from "../tx/liquidate.ts";
import type {
  LiquidateOrdersOutcome,
  LiquidatePositionOutcome,
  MarketId,
  Venue,
  VenueOrder,
  VenuePosition,
} from "./types.ts";

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

  constructor(chain: Chain, config: Config, logger: pino.Logger) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ venue: "perps" });
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
    // Single-market netted position. We need entryPrice + qty + market price
    // to derive `unrealizedLoss` and `notional`.
    const [position, marketPrice] = await this.chain.publicClient.multicall({
      contracts: [
        {
          address: this.config.perps.address,
          abi: HashPowerPerpsDEXAbi,
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
    // PnL in token decimals: priceDiff * netQty / 10^QUANTITY_DECIMALS
    const priceDiff = marketPrice - position.aggregatedEntryPrice;
    const pnl = (priceDiff * position.netQuantity) / QUANTITY_SCALE;
    const unrealizedLoss = pnl < 0n ? -pnl : 0n;
    const notional = (marketPrice * absQty) / QUANTITY_SCALE;

    this.logger.debug(
      { user, isLong, qty: position.netQuantity, marketPrice, unrealizedLoss, notional },
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

  async liquidateOrders(user: Address, ids?: readonly Hex[]): Promise<LiquidateOrdersOutcome> {
    // Perps is the only venue that takes a calldata id list — futures sweeps
    // FIFO. If the planner doesn't provide ids we fetch them ourselves so the
    // contract has something to chew on (the Multicall3 batching path also
    // benefits from a static id list).
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
      // Nothing to cancel — surface as `notLiquidatable` so the planner can
      // bail on this leg without rolling back the wider plan.
      return { skipped: "notLiquidatable" };
    }

    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger: this.logger,
      address: this.config.perps.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "liquidateOrders",
      args: [user, targetIds],
      feeEventName: "OrderLiquidated",
    });

    return "skipped" in result ? { skipped: "notLiquidatable" } : { feeEarned: result.feeEarned };
  }

  async liquidatePosition(user: Address, _id: Hex): Promise<LiquidatePositionOutcome> {
    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger: this.logger,
      address: this.config.perps.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "liquidatePosition",
      args: [user],
      feeEventName: "PositionLiquidated",
      mapSkip: (errorName) => {
        if (errorName === "OrdersStillOpen") return "ordersStillOpen";
        // Both `NotLiquidatable` and any other recoverable revert collapse to
        // `notLiquidatable` — the planner's recheck-then-retry loop handles
        // it the same way.
        return "notLiquidatable";
      },
    });

    return "skipped" in result ? { skipped: result.skipped } : { feeEarned: result.feeEarned };
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
