import type pino from "pino";
import type { InstrumentAdapter, OwnOrder, Unsubscribe, VenueEvent } from "./adapter.ts";

export interface BookTrackerConfig {
  /** Periodic full resync interval (ms). Live events keep state fresh in between. */
  resyncIntervalMs: number;
  /** Levels per side requested in the snapshot. */
  snapshotDepth?: number;
}

/**
 * Tracks the resting order book and the MM's own orders for a single instrument.
 *
 * Sources state from:
 *  - periodic full snapshot via `instrument.getOrderBookSnapshot()` and `getOwnOrders()`
 *  - live updates via the venue's `subscribeVenueEvents` (filtered to this instrument)
 *
 * The adapter is responsible for filtering events by `isOwn` (the MM's wallet).
 */
export class BookTracker {
  bestBid = 0n;
  bestAsk = 0n;
  midPrice = 0n;

  /** orderId -> own order resting on the venue. */
  readonly ownOrders = new Map<`0x${string}`, OwnOrder>();

  private readonly bidDepth = new Map<bigint, bigint>();
  private readonly askDepth = new Map<bigint, bigint>();

  private readonly instrument: InstrumentAdapter;
  private readonly logger: pino.Logger;
  private readonly cfg: BookTrackerConfig;

  private unsubscribe: Unsubscribe | null = null;
  private lastResyncAt = 0;

  constructor(instrument: InstrumentAdapter, cfg: BookTrackerConfig, logger: pino.Logger) {
    this.instrument = instrument;
    this.cfg = cfg;
    this.logger = logger.child({ component: "book", instrument: instrument.id });
  }

  async start(): Promise<void> {
    await this.fullResync();
    this.subscribe();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Periodic resync if interval elapsed. Called each tick. */
  async refresh(): Promise<void> {
    if (Date.now() - this.lastResyncAt > this.cfg.resyncIntervalMs) {
      await this.fullResync();
    }
  }

  depthAtPrice(price: bigint, isBid: boolean): bigint {
    return (isBid ? this.bidDepth : this.askDepth).get(price) ?? 0n;
  }

  private async fullResync(): Promise<void> {
    const [snapshot, ownOrders] = await Promise.all([
      this.instrument.getOrderBookSnapshot({ depth: this.cfg.snapshotDepth ?? 200 }),
      this.instrument.getOwnOrders(),
    ]);

    this.bidDepth.clear();
    this.askDepth.clear();
    for (const lvl of snapshot.bids) this.bidDepth.set(lvl.price, lvl.quantity);
    for (const lvl of snapshot.asks) this.askDepth.set(lvl.price, lvl.quantity);

    this.bestBid = snapshot.bids.length > 0 ? snapshot.bids[0].price : 0n;
    this.bestAsk = snapshot.asks.length > 0 ? snapshot.asks[0].price : 0n;
    this.midPrice = this.bestBid > 0n && this.bestAsk > 0n ? (this.bestBid + this.bestAsk) / 2n : 0n;

    this.ownOrders.clear();
    for (const order of ownOrders) {
      this.ownOrders.set(order.orderId, order);
    }

    this.lastResyncAt = Date.now();
    this.logger.info(
      {
        bestBid: this.bestBid.toString(),
        bestAsk: this.bestAsk.toString(),
        ownOrders: this.ownOrders.size,
      },
      "book resync",
    );
  }

  private subscribe(): void {
    this.unsubscribe = this.instrument.venue.subscribeVenueEvents((evt) => this.handleEvent(evt));
  }

  private handleEvent(evt: VenueEvent): void {
    if ("instrumentId" in evt && evt.instrumentId !== undefined && evt.instrumentId !== this.instrument.id) {
      return;
    }
    switch (evt.type) {
      case "order-created":
        if (evt.isOwn) this.ownOrders.set(evt.order.orderId, evt.order);
        break;
      case "order-cancelled":
        if (evt.isOwn) this.ownOrders.delete(evt.orderId);
        break;
      case "order-updated":
        if (evt.isOwn) {
          const existing = this.ownOrders.get(evt.orderId);
          if (existing) {
            if (evt.newQuantity === 0n) this.ownOrders.delete(evt.orderId);
            else existing.quantity = evt.newQuantity;
          }
        }
        break;
      case "order-matched":
        if (evt.isOwn) {
          this.logger.info({ makerOrderId: evt.makerOrderId }, "own order matched");
        }
        break;
      case "depth-changed": {
        const map = evt.isBid ? this.bidDepth : this.askDepth;
        if (evt.newQuantity === 0n) map.delete(evt.price);
        else map.set(evt.price, evt.newQuantity);
        break;
      }
      default:
        break;
    }
  }
}
