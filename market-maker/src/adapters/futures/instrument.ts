import { encodeFunctionData } from "viem";
import type pino from "pino";
import type {
  BookSource,
  CancelIntent,
  DepthLevel,
  ExecuteOrdersIntent,
  ExecuteOrdersResult,
  InstrumentAdapter,
  InstrumentContext,
  MatchingMode,
  OrderBookSnapshot,
  OrderIntent,
  Position,
} from "../../core/adapter.ts";
import { FuturesAbi } from "futures-contracts/abi/Futures";
import type { FuturesVenueAdapter } from "./venue.ts";
import { FuturesOwnOrders } from "./ownOrders.ts";
import { futuresInstrumentId } from "./events.ts";

export { futuresInstrumentId } from "./events.ts";

/**
 * One futures market = one delivery date (expiry). The venue creates one
 * adapter per selected expiry; each owns its own book snapshot, own-order
 * cache, and order encoding, all scoped to `deliveryDate`.
 *
 * Position and margin reads are per-expiry (client-side), while the shared
 * portfolio collateral/IM/MM lives on the venue's `CollateralAccount`.
 */
export class FuturesInstrumentAdapter implements InstrumentAdapter {
  readonly id: string;
  readonly venue: FuturesVenueAdapter;
  readonly book: FuturesBook;
  readonly ownOrders: FuturesOwnOrders;
  readonly deliveryDate: bigint;

  private tickCache: bigint | null = null;
  private marginPercentCache: bigint | null = null;

  constructor(venue: FuturesVenueAdapter, deliveryDate: bigint, logger: pino.Logger) {
    this.venue = venue;
    this.deliveryDate = deliveryDate;
    this.id = futuresInstrumentId(deliveryDate);
    this.book = new FuturesBook(this, venue.readBatchSize);
    this.ownOrders = new FuturesOwnOrders(
      venue,
      deliveryDate,
      logger.child({ instrument: this.id }),
      venue.readBatchSize,
    );
  }

  async getIndexPrice(): Promise<bigint> {
    // Raw oracle answer rebased to token decimals (no tick rounding). All
    // futures expiries share the same per-day hashprice oracle, so the index
    // is identical across markets; only time-to-expiry (T) differs downstream.
    return await this.venue.getRawMarketPrice();
  }

  async getPosition(): Promise<Position> {
    // Per-expiry net position, computed client-side. The engine's
    // `getNetPositionDelta` is portfolio-wide (sums all expiries), so we walk
    // this expiry's positions instead. Each position is a single matched unit
    // (qty=1): buyer is long (+1), seller is short (-1).
    const owner = this.venue.wallet.account.address.toLowerCase();
    const positionIds = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: FuturesAbi,
      functionName: "getPositionsByParticipantDeliveryDate",
      args: [this.venue.wallet.account.address, this.deliveryDate],
    });

    if (positionIds.length === 0) {
      return { netQuantity: 0n, entryPrice: await this.venue.getRawMarketPrice() };
    }

    const batchSize = this.venue.readBatchSize;
    const positions: {
      seller: string;
      buyer: string;
      sellPricePerDay: bigint;
      buyPricePerDay: bigint;
    }[] = [];
    for (let i = 0; i < positionIds.length; i += batchSize) {
      const chunk = positionIds.slice(i, i + batchSize);
      const results = await this.venue.publicClient.multicall({
        allowFailure: false,
        contracts: chunk.map((id) => ({
          address: this.venue.address,
          abi: FuturesAbi,
          functionName: "getPositionById" as const,
          args: [id] as const,
        })),
      });
      positions.push(
        ...(results as {
          seller: string;
          buyer: string;
          sellPricePerDay: bigint;
          buyPricePerDay: bigint;
        }[]),
      );
    }

    let net = 0n;
    let entrySum = 0n;
    let entryCount = 0n;
    for (const p of positions) {
      if (p.buyer.toLowerCase() === owner) {
        net += 1n;
        entrySum += p.buyPricePerDay;
        entryCount += 1n;
      }
      if (p.seller.toLowerCase() === owner) {
        net -= 1n;
        entrySum += p.sellPricePerDay;
        entryCount += 1n;
      }
    }
    const entryPrice =
      entryCount > 0n ? entrySum / entryCount : await this.venue.getRawMarketPrice();
    return { netQuantity: net, entryPrice };
  }

  async getContext(): Promise<InstrumentContext> {
    // Eagerly cache marginPct so `estimateOrderMargin` is synchronous.
    const { marginPct } = await this.venue.getMarginInputs();
    this.marginPercentCache = marginPct;
    return {
      deliveryDate: Number(this.deliveryDate),
    };
  }

  encodeCreate(intent: OrderIntent): `0x${string}` {
    const qty = Number(intent.size);
    if (qty <= 0 || qty > 127) {
      throw new Error(`futures: order size ${qty} must be in (0, 127]`);
    }
    const signed = (intent.side === "buy" ? qty : -qty) as number & {
      readonly __int8__: true;
    };
    return encodeFunctionData({
      abi: FuturesAbi,
      functionName: "createOrder",
      args: [intent.price, this.deliveryDate, "", signed],
    });
  }

  encodeCancel(intent: CancelIntent): `0x${string}` {
    return encodeFunctionData({
      abi: FuturesAbi,
      functionName: "closeOrder",
      args: [intent.orderId],
    });
  }

  /**
   * Cost units = qty. A futures `createOrder(…, int8 qty)` does one unit of
   * work per contract, so its gas scales with qty (a qty=1 create ≈ one
   * cancel). This lets the shared TxCoordinator budget futures batches by total
   * qty rather than call count — the same weighting `chunkCalls` uses below.
   */
  createCallWeight(intent: OrderIntent): number {
    return Number(intent.size);
  }

  /**
   * Execute cancels then creates for this expiry. Kept for single-market
   * callers and tests; the portfolio runner routes through the shared
   * `TxCoordinator` instead, which batches this expiry's calls with the other
   * expiries' into one `Futures.multicall`.
   */
  async executeOrders(intent: ExecuteOrdersIntent): Promise<ExecuteOrdersResult> {
    return this.executeOrdersImpl(intent, this.venue.getLogger());
  }

  /** Build the ordered call list for this expiry: cancels then creates. */
  buildCalls(intent: { cancels: CancelIntent[]; creates: OrderIntent[] }): `0x${string}`[] {
    const calls: `0x${string}`[] = [];
    for (const c of intent.cancels) calls.push(this.encodeCancel(c));
    for (const c of intent.creates) calls.push(this.encodeCreate(c));
    return calls;
  }

  // ── Private implementation ──────────────────────────────────────────

  private async executeOrdersImpl(
    intent: ExecuteOrdersIntent,
    logger: pino.Logger,
  ): Promise<ExecuteOrdersResult> {
    const batches = this.chunkCalls(intent);

    if (intent.dryRun) {
      logger.info(
        { cancels: intent.cancels.length, creates: intent.creates.length },
        "DRY RUN: would send multicall batches",
      );
      return { receipts: [], errors: [] };
    }

    const receipts: { gasUsed: bigint; effectiveGasPrice: bigint }[] = [];
    const errors: Error[] = [];
    for (let batchNum = 0; batchNum < batches.length; batchNum++) {
      const chunk = batches[batchNum];
      try {
        const hash = await this.venue.multicall(chunk, {
          maxFeePerGas: intent.maxFeePerGas,
        });
        const receipt = await this.venue.publicClient.waitForTransactionReceipt({
          hash,
        });
        receipts.push({
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
        });
        logger.info(
          {
            calls: chunk.length,
            batch: `${batchNum}/${batches.length}`,
            gas: receipt.gasUsed.toString(),
          },
          "futures multicall chunk executed",
        );
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        errors.push(wrapped);
        logger.error(
          { err: wrapped, calls: chunk.length, batch: `${batchNum}/${batches.length}` },
          "futures multicall chunk failed — continuing with next chunk",
        );
      }
    }
    return { receipts, errors };
  }

  /**
   * Split cancels+creates into tx-sized chunks. Batch size is measured in qty
   * count since one cancel costs roughly one qty=1 create.
   */
  private chunkCalls(intent: {
    cancels: CancelIntent[];
    creates: OrderIntent[];
  }): `0x${string}`[][] {
    const batchSize = this.venue.writeBatchSize;
    const batches: `0x${string}`[][] = [];
    let current: `0x${string}`[] = [];
    let qtyCount = 0;
    const push = (tx: `0x${string}`, qty: number) => {
      current.push(tx);
      qtyCount += qty;
      if (current.length >= batchSize || qtyCount >= batchSize) {
        batches.push(current);
        current = [];
        qtyCount = 0;
      }
    };
    for (const c of intent.cancels) push(this.encodeCancel(c), 1);
    for (const c of intent.creates) push(this.encodeCreate(c), Number(c.size));
    if (current.length > 0) batches.push(current);
    return batches;
  }

  /**
   * IM added by a new order:
   *   pricePerDay × |qty| × marginPct / 100   (one unit, no duration multiplier)
   * Conservative (ignores the profitable-order clamp); the engine's
   * `canPlaceOrder` is the real authority.
   */
  estimateOrderMargin(intent: OrderIntent): bigint {
    if (this.marginPercentCache === null) return 0n;
    return (intent.price * intent.size * this.marginPercentCache) / 100n;
  }

  async estimateCreateGas(account: `0x${string}`): Promise<bigint> {
    try {
      return await this.venue.publicClient.estimateContractGas({
        address: this.venue.address,
        abi: FuturesAbi,
        functionName: "createOrder",
        args: [
          1_000_000n,
          this.deliveryDate,
          "",
          1 as number & { readonly __int8__: true },
        ],
        account,
      });
    } catch {
      return 0n;
    }
  }

  async getMinTick(): Promise<bigint> {
    if (this.tickCache !== null) return this.tickCache;
    const tick = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: FuturesAbi,
      functionName: "minimumPriceIncrement",
    });
    this.tickCache = tick;
    return tick;
  }
}

/** Per-expiry book source. Reads the ladders for this instrument's delivery date. */
class FuturesBook implements BookSource {
  readonly matchingMode: MatchingMode = "exact";
  private readonly inst: FuturesInstrumentAdapter;
  private readonly readBatchSize: number;
  constructor(inst: FuturesInstrumentAdapter, readBatchSize: number) {
    this.inst = inst;
    this.readBatchSize = readBatchSize;
  }

  async tick(): Promise<bigint> {
    return this.inst.getMinTick();
  }

  async snapshot(opts: { depth?: number } = {}): Promise<OrderBookSnapshot> {
    const v = this.inst.venue;
    const dd = this.inst.deliveryDate;
    const depth = BigInt(opts.depth ?? 200);

    const [bidPrices, askPrices] = await v.publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: v.address,
          abi: FuturesAbi,
          functionName: "getBidPrices",
          args: [dd, depth],
        },
        {
          address: v.address,
          abi: FuturesAbi,
          functionName: "getAskPrices",
          args: [dd, depth],
        },
      ],
    });

    if (bidPrices.length === 0 && askPrices.length === 0) return { bids: [], asks: [] };

    const allCalls = [
      ...bidPrices.map((p) => ({
        address: v.address,
        abi: FuturesAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [dd, p, true] as const,
      })),
      ...askPrices.map((p) => ({
        address: v.address,
        abi: FuturesAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [dd, p, false] as const,
      })),
    ];

    const batchSize = this.readBatchSize;
    const allResults: bigint[] = [];
    for (let i = 0; i < allCalls.length; i += batchSize) {
      const chunk = allCalls.slice(i, i + batchSize);
      const chunkResults = await v.publicClient.multicall({
        allowFailure: false,
        contracts: chunk,
      });
      allResults.push(...chunkResults);
    }

    const bidsRaw: DepthLevel[] = bidPrices.map((p, i) => ({
      price: p,
      quantity: allResults[i],
    }));
    const asksRaw: DepthLevel[] = askPrices.map((p, i) => ({
      price: p,
      quantity: allResults[bidPrices.length + i],
    }));
    const bids = bidsRaw.sort((a, b) => (a.price < b.price ? 1 : a.price > b.price ? -1 : 0));
    const asks = asksRaw.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    return { bids, asks };
  }
}
