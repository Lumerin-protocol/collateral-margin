import {
  encodeFunctionData,
  keccak256,
  pad,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { HashPowerPerpsDEXAbi } from "derivatives-marketplace/HashPowerPerpsDEX.ts";
import { sendLiquidate } from "../tx/liquidate.ts";
import { formatGasCost } from "../tx/gasCost.ts";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
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
  private readonly ethUsdFeed: EthUsdFeed | undefined;

  constructor(chain: Chain, config: Config, logger: pino.Logger, ethUsdFeed?: EthUsdFeed) {
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

  /**
   * Cancels every supplied resting order via a single
   * `multicallStopOnFailure([liquidateOrder(user, id), ...])` transaction.
   *
   * The perps contract retired the dedicated batch entry point
   * `liquidateOrders(user, ids[])`; the canonical replacement is N
   * `liquidateOrder` sub-calls composed through
   * {MulticallStopOnFailureUpgradeable}. The multicall:
   *
   *   - Stops at the first sub-call that reverts (e.g. `NotLiquidatable`
   *     once cancelling earlier orders restored MM mid-batch). Earlier
   *     sub-calls keep their state changes and emit their `OrderLiquidated`
   *     events — we still pocket those fees.
   *   - Does *not* revert the whole tx for clean sub-call reverts, so the
   *     "user is healthy, do nothing" case requires inspecting the
   *     simulation's `successes` array rather than relying on a top-level
   *     throw.
   *   - Reverts the whole batch with `MulticallSubCallOutOfGas` on an
   *     empty-revert sub-call (typically OOG) — we let that bubble up so
   *     the executor re-queues.
   */
  async liquidateOrders(user: Address, ids?: readonly Hex[]): Promise<LiquidateOrdersOutcome> {
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
      // Nothing to cancel — surface as `notLiquidatable` so the planner
      // can bail on this leg without rolling back the wider plan.
      return { skipped: "notLiquidatable" };
    }

    const calls = targetIds.map((orderId) =>
      encodeFunctionData({
        abi: HashPowerPerpsDEXAbi,
        functionName: "liquidateOrder",
        args: [user, orderId],
      }),
    );

    // Simulate first — `multicallStopOnFailure` never propagates a
    // sub-call revert as a top-level revert, so the only way to detect
    // "user is healthy, every sub-call would clean-revert" is to read
    // `successes[0]` from the simulated return.
    const sim = await this.chain.publicClient.simulateContract({
      address: this.config.perps.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "multicallStopOnFailure",
      args: [calls],
      account: this.chain.account,
    });
    const successes = (sim.result as readonly [readonly boolean[], readonly Hex[]])[0];
    if (successes[0] === false) {
      this.logger.debug(
        { user, ordersTargeted: targetIds.length },
        "perps batch liquidate skipped — first sub-call would revert (user healthy)",
      );
      return { skipped: "notLiquidatable" };
    }

    if (this.config.keeper.dryRun) {
      this.logger.info(
        { user, ordersTargeted: targetIds.length },
        "[dryRun] would send perps batch liquidate",
      );
      return { feeEarned: 0n };
    }

    const hash = await this.chain.walletClient.writeContract(sim.request);
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: this.config.coordinator.confirmationBlocks,
    });
    const feeEarned = sumOrderLiquidatedFees(receipt);
    const ordersClosed = countSuccesses(successes);
    this.logger.info(
      { user, hash, ordersClosed, feeEarned, ...formatGasCost(receipt, this.ethUsdFeed) },
      "perps batch liquidate confirmed",
    );
    return { feeEarned };
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
      ethUsdFeed: this.ethUsdFeed,
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

/**
 * Walks a `multicallStopOnFailure` receipt and sums the `fee` field of every
 * `OrderLiquidated` event. The multicall delegatecalls each sub-call into
 * the contract's own storage, so every successful `liquidateOrder` emits
 * one event on the receipt — they accumulate naturally.
 */
function sumOrderLiquidatedFees(receipt: TransactionReceipt): bigint {
  const logs = parseEventLogs({
    abi: HashPowerPerpsDEXAbi,
    logs: receipt.logs,
    eventName: "OrderLiquidated",
  });
  let total = 0n;
  for (const log of logs) {
    const fee = log.args.fee;
    if (typeof fee === "bigint") total += fee;
  }
  return total;
}

/** Counts the truthy entries in the multicall's `successes` array. */
function countSuccesses(successes: readonly boolean[]): number {
  let n = 0;
  for (const s of successes) if (s) n++;
  return n;
}
