import { encodeFunctionData } from "viem";
import type pino from "pino";
import type {
  BookSource,
  CancelIntent,
  DepthLevel,
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

const FUTURES_INSTRUMENT_ID = "futures";

export class FuturesInstrumentAdapter implements InstrumentAdapter {
  readonly id = FUTURES_INSTRUMENT_ID;
  readonly venue: FuturesVenueAdapter;
  readonly book: FuturesBook;
  readonly ownOrders: FuturesOwnOrders;

  private tickCache: bigint | null = null;
  private deliveryDateCache: bigint | null = null;
  private deliveryDurationDaysCache: bigint | null = null;

  constructor(venue: FuturesVenueAdapter, logger: pino.Logger) {
    this.venue = venue;
    this.book = new FuturesBook(this);
    this.ownOrders = new FuturesOwnOrders(venue, logger);
  }

  async getIndexPrice(): Promise<bigint> {
    // Read the raw oracle answer rebased to token decimals — `Futures.getMarketPrice`
    // would round to the nearest tick, which collapses our reservation-price
    // shift onto a tick boundary and forces a 2-tick min spread. The unrounded
    // mid lets `roundDownToTick(r) → bidMid` and `roundUpToTick(r) → askMid`
    // produce a 1-tick spread naturally.
    return await this.venue.getRawMarketPrice();
  }

  async getPosition(): Promise<Position> {
    // Futures' net position is summed from all open positions. We use the
    // engine view exposed for this purpose: getNetPositionDelta returns
    // `Σ qty_i * deliveryDurationDays` × 1e18 in WAD. Convert back to
    // contracts by dividing by `deliveryDurationDays * 1e18`.
    const [netDeltaWad, durationDays, marketPrice] = await Promise.all([
      this.venue.publicClient.readContract({
        address: this.venue.address,
        abi: FuturesAbi,
        functionName: "getNetPositionDelta",
        args: [this.venue.wallet.account.address],
      }),
      this.venue.publicClient.readContract({
        address: this.venue.address,
        abi: FuturesAbi,
        functionName: "deliveryDurationDays",
      }),
      this.venue.getRawMarketPrice(),
    ]);
    const days = BigInt(durationDays);
    const denom = days * 10n ** 18n;
    const netQuantity = denom === 0n ? 0n : netDeltaWad / denom;
    return { netQuantity, entryPrice: marketPrice };
  }

  async getContext(): Promise<InstrumentContext> {
    const deliveryDates = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: FuturesAbi,
      functionName: "getDeliveryDates",
    });
    if (deliveryDates.length === 0) throw new Error("futures contract returned no delivery dates");
    this.deliveryDateCache = deliveryDates[0];

    // Eagerly cache margin inputs so `estimateOrderMargin` can be synchronous.
    const { deliveryDurationDays } = await this.venue.getMarginInputs();
    this.deliveryDurationDaysCache = deliveryDurationDays;

    return {
      deliveryDate: Number(deliveryDates[0]),
      contractMultiplier: deliveryDurationDays,
    };
  }

  encodeCreate(intent: OrderIntent): `0x${string}` {
    if (this.deliveryDateCache === null) {
      throw new Error("futures: getContext() must be called before encodeCreate()");
    }
    const qty = Number(intent.size);
    if (qty <= 0 || qty > 127) {
      throw new Error(`futures: order size ${qty} must be in (0, 127]`);
    }
    const signed = (intent.side === "buy" ? qty : -qty) as number & { readonly __int8__: true };
    return encodeFunctionData({
      abi: FuturesAbi,
      functionName: "createOrder",
      args: [intent.price, this.deliveryDateCache, "", signed],
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
   * Mirrors `Futures.getMaintenanceMarginForPosition` for a single new order:
   *   IM_added = pricePerDay × deliveryDurationDays × |qty| × marginPct / 100
   *
   * `getFuturesOrderMargin` clamps each order's marginal contribution at 0
   * when its mark-to-market PnL exceeds maintenance (a profitable order
   * locks no extra margin). We don't mirror that branch here: it would
   * make the estimate sign-dependent on the live oracle, and the
   * conservative "always charge full maintenance" estimate is fine because
   * `engine.canPlaceOrder` is the real authority. We err on the high side
   * by O(few percent), which only costs us a tiny slice of quoting capacity.
   */
  estimateOrderMargin(intent: OrderIntent): bigint {
    if (this.deliveryDurationDaysCache === null) return 0n;
    // marginPct is loaded lazily at first canPlace call; if we don't have it
    // yet, return 0 and let the engine gate sort it out on the first tx.
    const cachedMarginPct = (this.venue as unknown as { marginPercentCache?: bigint })
      .marginPercentCache;
    if (!cachedMarginPct) return 0n;
    return (intent.price * this.deliveryDurationDaysCache * intent.size * cachedMarginPct) / 100n;
  }

  async estimateCreateGas(account: `0x${string}`): Promise<bigint> {
    if (this.deliveryDateCache === null) return 0n;
    try {
      return await this.venue.publicClient.estimateContractGas({
        address: this.venue.address,
        abi: FuturesAbi,
        functionName: "createOrder",
        args: [1_000_000n, this.deliveryDateCache, "", 1 as number & { readonly __int8__: true }],
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

  /** Internal: nearest delivery date, populated after `getContext()`. */
  getDeliveryDate(): bigint | null {
    return this.deliveryDateCache;
  }
}

/**
 * Per-(deliveryDate) book source. The MM is locked to the nearest delivery
 * date — see venue header for rationale.
 */
class FuturesBook implements BookSource {
  readonly matchingMode: MatchingMode = "exact";
  private readonly inst: FuturesInstrumentAdapter;
  constructor(inst: FuturesInstrumentAdapter) {
    this.inst = inst;
  }

  async tick(): Promise<bigint> {
    return this.inst.getMinTick();
  }

  async snapshot(opts: { depth?: number } = {}): Promise<OrderBookSnapshot> {
    const v = this.inst.venue;
    const dd = this.inst.getDeliveryDate();
    if (dd === null) {
      throw new Error("futures: getContext() must be called before book.snapshot()");
    }
    const depth = BigInt(opts.depth ?? 200);

    const [bidPrices, askPrices] = await v.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: v.address, abi: FuturesAbi, functionName: "getBidPrices", args: [dd, depth] },
        { address: v.address, abi: FuturesAbi, functionName: "getAskPrices", args: [dd, depth] },
      ],
    });

    if (bidPrices.length === 0 && askPrices.length === 0) return { bids: [], asks: [] };

    const calls = [
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
    const results = await v.publicClient.multicall({ allowFailure: false, contracts: calls });

    const bidsRaw: DepthLevel[] = bidPrices.map((p, i) => ({ price: p, quantity: results[i] }));
    const asksRaw: DepthLevel[] = askPrices.map((p, i) => ({
      price: p,
      quantity: results[bidPrices.length + i],
    }));
    // EnumerableSet returns prices in unspecified order; sort for the consumer.
    const bids = bidsRaw.sort((a, b) => (a.price < b.price ? 1 : a.price > b.price ? -1 : 0));
    const asks = asksRaw.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    return { bids, asks };
  }
}
