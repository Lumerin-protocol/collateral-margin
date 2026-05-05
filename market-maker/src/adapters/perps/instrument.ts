import { encodeFunctionData } from "viem";
import type {
  BookSource,
  CancelIntent,
  DepthLevel,
  InstrumentAdapter,
  InstrumentContext,
  MatchingMode,
  OrderBookSnapshot,
  OrderIntent,
  OwnOrder,
  OwnOrderEvent,
  OwnOrderSource,
  Position,
  Unsubscribe,
} from "../../core/adapter.ts";
import { HashPowerPerpsDEXAbi } from "perps-contracts/abi/HashPowerPerpsDEX.ts";
import { calculateNotional } from "../../core/math.ts";
import type { PerpsVenueAdapter } from "./venue.ts";

const PERPS_INSTRUMENT_ID = "perps";

export class PerpsInstrumentAdapter implements InstrumentAdapter {
  readonly id = PERPS_INSTRUMENT_ID;
  readonly venue: PerpsVenueAdapter;
  readonly book: BookSource;
  readonly ownOrders: OwnOrderSource;

  private tickCache: bigint | null = null;

  constructor(venue: PerpsVenueAdapter) {
    this.venue = venue;
    this.book = new PerpsBook(this);
    this.ownOrders = new PerpsOwnOrders(this);
  }

  async getIndexPrice(): Promise<bigint> {
    // Read the raw oracle answer rebased to token decimals — `HashPowerPerpsDEX.getMarketPrice`
    // would round to the nearest tick, which collapses our reservation-price
    // shift onto a tick boundary and forces a 2-tick min spread. The unrounded
    // mid lets `roundDownToTick(r) → bidMid` and `roundUpToTick(r) → askMid`
    // produce a 1-tick spread naturally.
    return await this.venue.getRawMarketPrice();
  }

  async getPosition(): Promise<Position> {
    const owner = this.venue.wallet.account.address;
    const pos = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getUserPosition",
      args: [owner],
    });
    return { netQuantity: pos.netQuantity, entryPrice: pos.aggregatedEntryPrice };
  }

  async getContext(): Promise<InstrumentContext> {
    // Eagerly cache the IM spot shock so `estimateOrderMargin` is synchronous.
    await this.venue.fetchImSpotShock();
    return {};
  }

  encodeCreate(intent: OrderIntent): `0x${string}` {
    // Perps' createOrder takes a SIGNED quantity (positive = buy, negative = sell).
    const signed = intent.side === "buy" ? intent.size : -intent.size;
    return encodeFunctionData({
      abi: HashPowerPerpsDEXAbi,
      functionName: "createOrder",
      args: [intent.price, signed],
    });
  }

  encodeCancel(intent: CancelIntent): `0x${string}` {
    return encodeFunctionData({
      abi: HashPowerPerpsDEXAbi,
      functionName: "cancelOrder",
      args: [intent.orderId],
    });
  }

  /**
   * Mirrors `HashPowerPerpsDEX._getMargin` for a single new resting order:
   *   IM_added = imSpotShock × notional / 1e18
   *
   * The on-chain formula reduces this by any "risk-reducing" overlap with
   * an existing position, but the MM is conservative on the high side here:
   * we estimate ignoring the reducer (worst-case more IM, never less),
   * so the engine.canPlaceOrder gate has slack rather than slop.
   *
   * Returns 0n if `imSpotShock` hasn't been cached yet — caller treats
   * "0 additional" as "no information; proceed", which is fine on first
   * tick because the engine itself enforces the floor.
   */
  estimateOrderMargin(intent: OrderIntent): bigint {
    // Ensure the venue has a cached spot shock; if not, fall back to the
    // no-op estimate. The first canPlace call is allowed through optimistically.
    // The cached value is fetched lazily by `account.imSpotShock()` and cached.
    const cached = (this.venue as unknown as { imSpotShockCache?: bigint }).imSpotShockCache;
    if (!cached) return 0n;
    const notional = calculateNotional(intent.price, intent.size);
    return (notional * cached) / 10n ** 18n;
  }

  async estimateCreateGas(account: `0x${string}`): Promise<bigint> {
    try {
      return await this.venue.publicClient.estimateContractGas({
        address: this.venue.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "createOrder",
        args: [1_000_000n, 1_000_000n],
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
      abi: HashPowerPerpsDEXAbi,
      functionName: "minimumPriceIncrement",
    });
    this.tickCache = tick;
    return tick;
  }
}

class PerpsBook implements BookSource {
  readonly matchingMode: MatchingMode = "limit";
  private readonly inst: PerpsInstrumentAdapter;
  constructor(inst: PerpsInstrumentAdapter) {
    this.inst = inst;
  }

  tick(): Promise<bigint> {
    return this.inst.getMinTick();
  }

  async snapshot(opts: { depth?: number } = {}): Promise<OrderBookSnapshot> {
    const v = this.inst.venue;
    const depth = BigInt(opts.depth ?? 200);
    const [bidPrices, askPrices] = await v.publicClient.readContract({
      address: v.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getOrderBookPrices",
      args: [depth],
    });
    if (bidPrices.length === 0 && askPrices.length === 0) return { bids: [], asks: [] };

    const depthCalls = [
      ...bidPrices.map((p) => ({
        address: v.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, true] as const,
      })),
      ...askPrices.map((p) => ({
        address: v.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, false] as const,
      })),
    ];
    const results = await v.publicClient.multicall({ allowFailure: false, contracts: depthCalls });
    const bids: DepthLevel[] = bidPrices.map((p, i) => ({ price: p, quantity: results[i] }));
    const asks: DepthLevel[] = askPrices.map((p, i) => ({
      price: p,
      quantity: results[bidPrices.length + i],
    }));
    return { bids, asks };
  }
}

/**
 * Stateless on-chain own-order source: every `list()` call hits the chain.
 * Subscribe filters venue events to the wallet and forwards them as
 * `OwnOrderEvent`s; no internal cache is required because `list()` is the
 * source of truth.
 */
class PerpsOwnOrders implements OwnOrderSource {
  private readonly inst: PerpsInstrumentAdapter;
  constructor(inst: PerpsInstrumentAdapter) {
    this.inst = inst;
  }

  async list(): Promise<OwnOrder[]> {
    const v = this.inst.venue;
    const owner = v.wallet.account.address;
    const orderIds = await v.publicClient.readContract({
      address: v.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getUserOrders",
      args: [owner],
    });
    if (orderIds.length === 0) return [];
    const calls = orderIds.map((id) => ({
      address: v.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getOrder" as const,
      args: [id] as const,
    }));
    const results = await v.publicClient.multicall({ allowFailure: false, contracts: calls });
    return orderIds.map((orderId, i) => {
      const q = results[i].quantity;
      return {
        orderId,
        price: results[i].price,
        side: q > 0n ? "buy" : "sell",
        size: q > 0n ? q : -q,
        instrumentId: PERPS_INSTRUMENT_ID,
      } satisfies OwnOrder;
    });
  }

  subscribe(cb: (event: OwnOrderEvent) => void): Unsubscribe {
    const own = this.inst.venue.wallet.account.address.toLowerCase();
    return this.inst.venue.events.subscribe((evt) => {
      switch (evt.type) {
        case "order-created": {
          if (evt.participant.toLowerCase() !== own) return;
          cb({
            type: "added",
            orderId: evt.orderId,
            order: {
              orderId: evt.orderId,
              price: evt.price,
              side: evt.side,
              size: evt.size,
              instrumentId: PERPS_INSTRUMENT_ID,
            },
          });
          return;
        }
        case "order-cancelled": {
          if (evt.participant.toLowerCase() !== own) return;
          cb({ type: "removed", orderId: evt.orderId });
          return;
        }
        case "order-updated": {
          if (evt.participant.toLowerCase() !== own) return;
          // We don't have side/price from the update event; signal a refresh
          // is needed by emitting "removed". The next BookTracker resync will
          // re-pick it up via list() if it still exists.
          if (evt.newSize === 0n) {
            cb({ type: "removed", orderId: evt.orderId });
          } else {
            cb({ type: "updated", orderId: evt.orderId });
          }
          return;
        }
      }
    });
  }

  async bootstrap(_opts?: { fromBlock?: bigint }): Promise<void> {
    // No-op: list() is the source of truth and reads from chain on demand.
  }
}
