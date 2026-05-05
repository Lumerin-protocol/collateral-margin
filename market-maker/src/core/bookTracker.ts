import type pino from "pino";
import type { InstrumentAdapter, OwnOrder, Unsubscribe } from "./adapter.ts";

export interface BookTrackerConfig {
  /** Periodic full resync interval (ms). */
  resyncIntervalMs: number;
  /** Levels per side requested in the snapshot. */
  snapshotDepth?: number;
}

/**
 * Tracks the resting order book and the MM's own orders for a single instrument.
 *
 * Sources state from:
 *   - periodic full snapshot via `instrument.book.snapshot()` and `instrument.ownOrders.list()`
 *   - live updates via `instrument.ownOrders.subscribe()` (own-order delta only)
 *
 * Only `OwnOrderSource` keeps adapter-internal state — BookTracker holds the
 * book/own-order picture for core consumers (Quoter, Executor, Health) and
 * delegates own-order state ownership entirely to the adapter.
 */
export class BookTracker {
  bestBid = 0n;
  bestAsk = 0n;
  midPrice = 0n;

  /** orderId -> own order. Mirrors `instrument.ownOrders` for cheap reads. */
  readonly ownOrders = new Map<`0x${string}`, OwnOrder>();

  private readonly bidDepth = new Map<bigint, bigint>();
  private readonly askDepth = new Map<bigint, bigint>();

  private readonly instrument: InstrumentAdapter;
  private readonly logger: pino.Logger;
  private readonly cfg: BookTrackerConfig;

  private unsubOwn: Unsubscribe | null = null;
  private lastResyncAt = 0;

  constructor(instrument: InstrumentAdapter, cfg: BookTrackerConfig, logger: pino.Logger) {
    this.instrument = instrument;
    this.cfg = cfg;
    this.logger = logger.child({ component: "book", instrument: instrument.id });
  }

  async start(): Promise<void> {
    await this.fullResync();
    this.subscribeOwn();
  }

  stop(): void {
    this.unsubOwn?.();
    this.unsubOwn = null;
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
      this.instrument.book.snapshot({ depth: this.cfg.snapshotDepth ?? 200 }),
      this.instrument.ownOrders.list(),
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

  private subscribeOwn(): void {
    this.unsubOwn = this.instrument.ownOrders.subscribe((evt) => {
      switch (evt.type) {
        case "added":
          if (evt.order) this.ownOrders.set(evt.orderId, evt.order);
          break;
        case "updated":
          if (evt.order) this.ownOrders.set(evt.orderId, evt.order);
          break;
        case "removed":
          this.ownOrders.delete(evt.orderId);
          break;
      }
    });
  }
}
