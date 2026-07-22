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
  OrderBookSnapshot,
  OrderIntent,
  Position,
  ReduceIntent,
} from "../../core/adapter.ts";
import { FuturesAbi } from "futures-contracts/abi/Futures";
import type { FuturesVenueAdapter } from "./venue.ts";
import { FuturesOwnOrders } from "./ownOrders.ts";
import { futuresInstrumentId } from "./events.ts";

export { futuresInstrumentId } from "./events.ts";

/**
 * One futures market = one delivery date (expiry). The venue creates one
 * adapter per selected expiry; each owns its own book snapshot, own-order
 * cache, and order encoding, all scoped to `expirationAt`.
 *
 * Position and margin reads are per-expiry (client-side), while the shared
 * portfolio collateral/IM/MM lives on the venue's `CollateralAccount`.
 */
export class FuturesInstrumentAdapter implements InstrumentAdapter {
  readonly id: string;
  readonly venue: FuturesVenueAdapter;
  readonly book: FuturesBook;
  readonly ownOrders: FuturesOwnOrders;
  readonly expirationAt: bigint;

  private tickCache: bigint | null = null;
  private marginPercentCache: bigint | null = null;

  constructor(venue: FuturesVenueAdapter, expirationAt: bigint, logger: pino.Logger) {
    this.venue = venue;
    this.expirationAt = expirationAt;
    this.id = futuresInstrumentId(expirationAt);
    this.book = new FuturesBook(this, venue.readBatchSize);
    this.ownOrders = new FuturesOwnOrders(
      venue,
      expirationAt,
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
    const pos = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: FuturesAbi,
      functionName: "getUserPosition",
      args: [this.venue.wallet.account.address, this.expirationAt],
    });
    const netQuantity = pos.netQuantity;
    if (netQuantity === 0n) {
      return { netQuantity: 0n, entryPrice: await this.venue.getRawMarketPrice() };
    }
    const absNet = netQuantity < 0n ? -netQuantity : netQuantity;
    const absEntry = pos.netEntryValue < 0n ? -pos.netEntryValue : pos.netEntryValue;
    return { netQuantity, entryPrice: absEntry / absNet };
  }

  async getContext(): Promise<InstrumentContext> {
    // Eagerly cache marginPct so `estimateOrderMargin` is synchronous.
    const { marginPct } = await this.venue.getMarginInputs();
    this.marginPercentCache = marginPct;
    return {
      expirationAt: Number(this.expirationAt),
    };
  }

  encodeCreate(intent: OrderIntent): `0x${string}` {
    const qty = intent.size;
    if (qty <= 0n) {
      throw new Error(`futures: order size ${qty} must be > 0`);
    }
    const signed = intent.side === "buy" ? qty : -qty;
    return encodeFunctionData({
      abi: FuturesAbi,
      functionName: "createOrder",
      args: [intent.price, this.expirationAt, signed],
    });
  }

  encodeUpdateOrders(
    cancels: CancelIntent[],
    reduces: ReduceIntent[],
    creates: OrderIntent[],
  ): `0x${string}` {
    // Local ABI fragment until published futures-contracts includes the reduces arg.
    const updateOrdersAbi = [
      {
        type: "function",
        name: "updateOrders",
        stateMutability: "nonpayable",
        inputs: [
          { name: "_cancelIds", type: "bytes32[]" },
          {
            name: "_reduces",
            type: "tuple[]",
            components: [
              { name: "orderId", type: "bytes32" },
              { name: "newQuantity", type: "int256" },
            ],
          },
          {
            name: "_intents",
            type: "tuple[]",
            components: [
              { name: "price", type: "uint256" },
              { name: "expirationAt", type: "uint256" },
              { name: "quantity", type: "int256" },
            ],
          },
        ],
        outputs: [],
      },
    ] as const;
    const reduceBatch = reduces.map((r) => {
      if (r.newSize <= 0n) {
        throw new Error(`futures: reduce newSize ${r.newSize} must be > 0`);
      }
      return {
        orderId: r.orderId,
        newQuantity: r.side === "buy" ? r.newSize : -r.newSize,
      };
    });
    const batch = creates.map((intent) => {
      const qty = intent.size;
      if (qty <= 0n) {
        throw new Error(`futures: order size ${qty} must be > 0`);
      }
      return {
        price: intent.price,
        expirationAt: intent.expirationAt ?? this.expirationAt,
        quantity: intent.side === "buy" ? qty : -qty,
      };
    });
    return encodeFunctionData({
      abi: updateOrdersAbi,
      functionName: "updateOrders",
      args: [cancels.map((c) => c.orderId), reduceBatch, batch],
    });
  }

  encodeCancel(intent: CancelIntent): `0x${string}` {
    return encodeFunctionData({
      abi: FuturesAbi,
      functionName: "cancelOrder",
      args: [intent.orderId],
    });
  }

  /**
   * Execute cancels + reduces + creates via `updateOrders` (IM checked once).
   */
  async executeOrders(intent: ExecuteOrdersIntent): Promise<ExecuteOrdersResult> {
    return this.executeOrdersImpl(intent, this.venue.getLogger());
  }

  /** Build the call list for this expiry: one `updateOrders` when there is work. */
  buildCalls(intent: {
    cancels: CancelIntent[];
    reduces?: ReduceIntent[];
    creates: OrderIntent[];
  }): `0x${string}`[] {
    const reduces = intent.reduces ?? [];
    if (intent.cancels.length === 0 && reduces.length === 0 && intent.creates.length === 0) {
      return [];
    }
    return [this.encodeUpdateOrders(intent.cancels, reduces, intent.creates)];
  }

  // ── Private implementation ──────────────────────────────────────────

  private async executeOrdersImpl(
    intent: ExecuteOrdersIntent,
    logger: pino.Logger,
  ): Promise<ExecuteOrdersResult> {
    const reduces = intent.reduces ?? [];
    if (intent.cancels.length === 0 && reduces.length === 0 && intent.creates.length === 0) {
      return { receipts: [], errors: [] };
    }
    const data = this.encodeUpdateOrders(intent.cancels, reduces, intent.creates);

    if (intent.dryRun) {
      logger.info(
        {
          cancels: intent.cancels.length,
          reduces: reduces.length,
          creates: intent.creates.length,
        },
        "DRY RUN: would send updateOrders",
      );
      return { receipts: [], errors: [] };
    }

    try {
      const hash = await this.venue.sendCall(data, {
        maxFeePerGas: intent.maxFeePerGas,
      });
      const receipt = await this.venue.publicClient.waitForTransactionReceipt({
        hash,
      });
      logger.info(
        {
          cancels: intent.cancels.length,
          reduces: reduces.length,
          creates: intent.creates.length,
          gas: receipt.gasUsed.toString(),
        },
        "futures updateOrders executed",
      );
      return {
        receipts: [
          { gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice },
        ],
        errors: [],
      };
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: wrapped }, "futures updateOrders failed");
      return { receipts: [], errors: [wrapped] };
    }
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
        // Futures 3.0: createOrder(price, expirationAt, signedQuantity)
        args: [1_000_000n, this.expirationAt, 1n],
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
    const expirationAt = this.inst.expirationAt;
    const depth = BigInt(opts.depth ?? 200);

    // Same shape as perps `getOrderBookPrices(depth)`, with expirationAt first.
    const [bidPrices, askPrices] = await v.publicClient.readContract({
      address: v.address,
      abi: FuturesAbi,
      functionName: "getOrderBookPrices",
      args: [expirationAt, depth],
    });

    if (bidPrices.length === 0 && askPrices.length === 0) return { bids: [], asks: [] };

    const allCalls = [
      ...bidPrices.map((p) => ({
        address: v.address,
        abi: FuturesAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [expirationAt, p, true] as const,
      })),
      ...askPrices.map((p) => ({
        address: v.address,
        abi: FuturesAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [expirationAt, p, false] as const,
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
