import { pad, toHex, type Address, type Hex } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { FuturesAbi } from "futures-marketplace-abi/Futures.ts";
import { sendLiquidate } from "../tx/liquidate.ts";
import { readAccountSnapshot, readMMParams } from "../predict/snapshot.ts";
import { solveFuturesClosesToTarget } from "../predict/solve.ts";
import type { MMParams } from "../predict/types.ts";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
import type {
  LiquidateOrdersOutcome,
  MarketId,
  ReduceToTargetOutcome,
  Venue,
  VenueOrder,
  VenuePosition,
} from "./types.ts";

/**
 * `Venue` adapter for the Futures contract (3.0 aggregate positions).
 *
 * One matched unit settles `pricePerDay` of notional (no duration multiplier).
 * Position PnL is `mark * netQuantity - netEntryValue`, matching on-chain
 * settle/liquidate math.
 */
export class FuturesVenue implements Venue {
  readonly name = "futures" as const;

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
    this.logger = logger.child({ venue: "futures" });
    this.ethUsdFeed = ethUsdFeed;
  }

  marketLabel(marketId: MarketId): string {
    const deliveryAt = marketIdToDeliveryAt(marketId);
    const iso = new Date(Number(deliveryAt) * 1000).toISOString().slice(0, 10);
    return `futures ${iso}`;
  }

  async readOpenOrders(user: Address): Promise<VenueOrder[]> {
    const orderIds = (await this.chain.publicClient.readContract({
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "getUserOrders",
      args: [user],
    })) as readonly Hex[];

    if (orderIds.length === 0) return [];

    const orders = await this.chain.publicClient.multicall({
      contracts: orderIds.map((id) => ({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getOrder" as const,
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
    const [deliveryAts, marketPrice] = await Promise.all([
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getActiveDeliveryDates",
        args: [user],
      }) as Promise<readonly bigint[]>,
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getMarketPrice",
      }) as Promise<bigint>,
    ]);

    if (deliveryAts.length === 0) return [];

    const positions = await this.chain.publicClient.multicall({
      contracts: deliveryAts.map((deliveryAt) => ({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getUserPosition" as const,
        args: [user, deliveryAt] as const,
      })),
      allowFailure: false,
    });

    const out: VenuePosition[] = [];
    for (let i = 0; i < deliveryAts.length; i++) {
      const deliveryAt = deliveryAts[i]!;
      const pos = positions[i]!;
      if (pos.netQuantity === 0n) continue;

      const absQty = pos.netQuantity < 0n ? -pos.netQuantity : pos.netQuantity;
      const pnl = marketPrice * pos.netQuantity - pos.netEntryValue;
      const unrealizedLoss = pnl < 0n ? -pnl : 0n;
      const avgEntry = abs(pos.netEntryValue) / absQty;
      const notional = avgEntry * absQty;

      out.push({
        id: deliveryAtMarketId(deliveryAt),
        marketId: deliveryAtMarketId(deliveryAt),
        unrealizedLoss,
        notional,
      });
    }
    return out;
  }

  async liquidateOrders(
    user: Address,
    _ids?: readonly Hex[],
  ): Promise<LiquidateOrdersOutcome> {
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

    return "skipped" in result
      ? { skipped: "notLiquidatable" }
      : { feeEarned: result.feeEarned };
  }

  async reduceToTarget(user: Address): Promise<ReduceToTargetOutcome> {
    const [snapshot, params, marketPrice] = await Promise.all([
      readAccountSnapshot(this.chain, this.config, user),
      this.getMMParams(),
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getMarketPrice",
      }) as Promise<bigint>,
    ]);

    // Liquidation-fee payout is disabled on-chain — pass 0 so the projection matches.
    const closes = solveFuturesClosesToTarget(snapshot, params, marketPrice, 0n);
    if (closes.length === 0) {
      return { skipped: "nothingToClose" };
    }

    // Gas-bounded chunking: send at most `maxLotsPerLiquidationTx` expiry legs.
    const cap = this.config.futures.maxLotsPerLiquidationTx;
    const chunk = cap > 0 && closes.length > cap ? closes.slice(0, cap) : closes;
    const deliveryAts = chunk.map((c) => c.deliveryAt);
    const closeQtys = chunk.map((c) => c.closeQty);
    const contractsClosed = closeQtys.reduce((s, q) => s + q, 0n);

    this.logger.info(
      {
        user,
        legsInChunk: chunk.length,
        legsToClose: closes.length,
        contractsClosed: contractsClosed.toString(),
        ofExpiries: snapshot.futures.positions.length,
        chunked: chunk.length < closes.length,
      },
      "Futures reduceToTarget: closing worst-first expiry chunk",
    );

    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger: this.logger,
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "liquidatePositions",
      args: [user, deliveryAts, closeQtys],
      feeEventName: "PositionLiquidated",
      mapSkip: (errorName) => {
        if (errorName === "OrdersStillOpen") return "ordersStillOpen";
        return "notLiquidatable";
      },
      ethUsdFeed: this.ethUsdFeed,
    });

    return "skipped" in result
      ? { skipped: result.skipped }
      : { feeEarned: result.feeEarned, positionsClosed: Number(contractsClosed) };
  }

  private async getMMParams(): Promise<MMParams> {
    if (this.mmParams !== undefined) return this.mmParams;
    this.mmParams = await readMMParams(this.chain, this.config);
    return this.mmParams;
  }
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** `bytes32(uint256(deliveryAt))` — same encoding the indexer uses. */
export function deliveryAtMarketId(deliveryAt: bigint): MarketId {
  return pad(toHex(deliveryAt), { size: 32 });
}

/** Inverse of `deliveryAtMarketId` — used by the planner / labels. */
export function marketIdToDeliveryAt(marketId: MarketId): bigint {
  return BigInt(marketId);
}
