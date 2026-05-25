import { getAddress, pad, toHex, type Address, type Hex } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { FuturesAbi } from "futures-marketplace/Futures.ts";
import { sendLiquidate } from "../tx/liquidate.ts";
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
 * `Venue` adapter for the Futures contract.
 *
 * Caches `deliveryDurationDays` lazily on first use: the contract setting
 * is immutable within an epoch and only ever ratchets on admin action, so
 * we read it once per process and re-read after restart. Position PnL math
 * uses this value as a multiplier (`priceDiffPerDay * deliveryDurationDays`)
 * — caching it keeps `readPositions` to one RPC + one multicall.
 */
export class FuturesVenue implements Venue {
  readonly name = "futures" as const;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly ethUsdFeed: EthUsdFeed | undefined;
  private deliveryDurationDays: bigint | undefined;

  constructor(chain: Chain, config: Config, logger: pino.Logger, ethUsdFeed?: EthUsdFeed) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ venue: "futures" });
    // Optional — when present every confirmed-tx log gets `gasCostUsd`
    // alongside `gasCostEth`. Wiring keeps the field absent (rather than
    // zero) when the feed is unset so log search can distinguish "feed
    // off" from a literal zero-cost tx.
    this.ethUsdFeed = ethUsdFeed;
  }

  marketLabel(marketId: MarketId): string {
    const deliveryAt = marketIdToDeliveryAt(marketId);
    // Render as ISO date so on-call alerts read naturally.
    const iso = new Date(Number(deliveryAt) * 1000).toISOString().slice(0, 10);
    return `futures ${iso}`;
  }

  async readOpenOrders(user: Address): Promise<VenueOrder[]> {
    const orderIds = (await this.chain.publicClient.readContract({
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "getOrderIds",
      args: [user],
    })) as readonly Hex[];

    if (orderIds.length === 0) return [];

    // Hydrate each order so we know its `deliveryAt` (== marketId). The
    // contract sweeps FIFO regardless, but the planner wants per-market
    // labelling for alerts and ranking.
    const orders = await this.chain.publicClient.multicall({
      contracts: orderIds.map((id) => ({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getOrderById" as const,
        args: [id] as const,
      })),
      allowFailure: false,
    });

    return orderIds.map((id, i) => ({
      id,
      marketId: deliveryAtMarketId(orders[i].deliveryAt),
    }));
  }

  async readPositions(user: Address): Promise<VenuePosition[]> {
    const [positionIds, marketPrice, deliveryDurationDays] = await Promise.all([
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getPositionIds",
        args: [user],
      }) as Promise<readonly Hex[]>,
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getMarketPrice",
      }) as Promise<bigint>,
      this.getDeliveryDurationDays(),
    ]);

    if (positionIds.length === 0) return [];

    const positions = await this.chain.publicClient.multicall({
      contracts: positionIds.map((id) => ({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getPositionById" as const,
        args: [id] as const,
      })),
      allowFailure: false,
    });

    const userAddr = getAddress(user);
    return positionIds.map((id, i) => {
      const pos = positions[i];
      // Each position is a single contract; PnL accrues per day across the
      // full delivery window (matches `getFuturesUnrealizedPnl` on-chain).
      const isBuyer = getAddress(pos.buyer) === userAddr;
      const entryPricePerDay = isBuyer ? pos.buyPricePerDay : pos.sellPricePerDay;
      const priceDiffPerDay = isBuyer
        ? marketPrice - entryPricePerDay // long: lose when market drops
        : entryPricePerDay - marketPrice; // short: lose when market rises
      const pnl = priceDiffPerDay * deliveryDurationDays;
      const unrealizedLoss = pnl < 0n ? -pnl : 0n;
      const notional = entryPricePerDay * deliveryDurationDays;

      return {
        id,
        marketId: deliveryAtMarketId(pos.deliveryAt),
        unrealizedLoss,
        notional,
      };
    });
  }

  async liquidateOrders(user: Address, _ids?: readonly Hex[]): Promise<LiquidateOrdersOutcome> {
    // Futures sweeps FIFO until the participant is healthy — no calldata id
    // list needed. We deliberately ignore `ids` rather than asserting on it
    // so the venue surface stays uniform across perps/futures.
    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger: this.logger,
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "liquidateOrders",
      args: [user],
      feeEventName: "OrderLiquidated",
      ethUsdFeed: this.ethUsdFeed,
    });

    return "skipped" in result ? { skipped: "notLiquidatable" } : { feeEarned: result.feeEarned };
  }

  async liquidatePosition(user: Address, id: Hex): Promise<LiquidatePositionOutcome> {
    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger: this.logger,
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "liquidatePosition",
      args: [user, id],
      feeEventName: "PositionLiquidated",
      mapSkip: (errorName) => {
        if (errorName === "OrdersStillOpen") return "ordersStillOpen";
        return "notLiquidatable";
      },
      ethUsdFeed: this.ethUsdFeed,
    });

    return "skipped" in result ? { skipped: result.skipped } : { feeEarned: result.feeEarned };
  }

  /**
   * Read `deliveryDurationDays` lazily and cache it. The contract returns
   * `uint8` (decoded as `number`); we widen to `bigint` so downstream
   * arithmetic stays in bigint land.
   */
  private async getDeliveryDurationDays(): Promise<bigint> {
    if (this.deliveryDurationDays !== undefined) return this.deliveryDurationDays;
    const days = (await this.chain.publicClient.readContract({
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "deliveryDurationDays",
    })) as number;
    this.deliveryDurationDays = BigInt(days);
    return this.deliveryDurationDays;
  }
}

/** `bytes32(uint256(deliveryAt))` — same encoding the indexer uses. */
export function deliveryAtMarketId(deliveryAt: bigint): MarketId {
  return pad(toHex(deliveryAt), { size: 32 });
}

/** Inverse of `deliveryAtMarketId` — used by the planner / labels. */
export function marketIdToDeliveryAt(marketId: MarketId): bigint {
  return BigInt(marketId);
}
