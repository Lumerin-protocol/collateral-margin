import type pino from "pino";
import type {
  OwnOrder,
  OwnOrderEvent,
  OwnOrderSource,
  Unsubscribe,
} from "../../core/adapter.ts";
import { FuturesAbi } from "futures-contracts/abi/Futures";
import type { FuturesVenueAdapter } from "./venue.ts";
import { futuresInstrumentId } from "./events.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Cache-backed own-order source for a single futures expiry.
 *
 * The contract has no per-participant order view scoped by delivery date, so
 * we read all of the wallet's orders and keep only those matching this
 * instrument's `deliveryDate`:
 *
 *   1. `bootstrap()` reads `getOrderIds(wallet)` + `getOrderById(id)` and
 *      caches the orders whose `deliveryAt === deliveryDate`.
 *   2. `subscribe()` listens to venue events. `order-created` is filtered by
 *      participant AND instrumentId (which encodes the expiry). `order-cancelled`
 *      carries no expiry, so we apply it only if the id is in *this* cache —
 *      that both identifies ownership and routes to the right expiry.
 *   3. `list()` returns the cache contents.
 */
export class FuturesOwnOrders implements OwnOrderSource {
  private readonly cache = new Map<`0x${string}`, OwnOrder>();
  private readonly listeners = new Set<(event: OwnOrderEvent) => void>();
  private unsubVenue: Unsubscribe | null = null;
  private bootstrapped = false;

  private readonly venue: FuturesVenueAdapter;
  private readonly deliveryDate: bigint;
  private readonly instrumentId: string;
  private readonly logger: pino.Logger;
  private readonly readBatchSize: number;

  constructor(
    venue: FuturesVenueAdapter,
    deliveryDate: bigint,
    logger: pino.Logger,
    readBatchSize: number,
  ) {
    this.venue = venue;
    this.deliveryDate = deliveryDate;
    this.instrumentId = futuresInstrumentId(deliveryDate);
    this.logger = logger.child({ component: "futures-own-orders" });
    this.readBatchSize = readBatchSize;
  }

  async list(): Promise<OwnOrder[]> {
    return Array.from(this.cache.values());
  }

  subscribe(cb: (event: OwnOrderEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    if (this.unsubVenue === null) this.unsubVenue = this.attach();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) {
        this.unsubVenue?.();
        this.unsubVenue = null;
      }
    };
  }

  async bootstrap(_opts: { fromBlock?: bigint } = {}): Promise<void> {
    const owner = this.venue.wallet.account.address;
    this.cache.clear();

    const orderIds = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: FuturesAbi,
      functionName: "getOrderIds",
      args: [owner],
    });

    if (orderIds.length === 0) {
      this.bootstrapped = true;
      this.logger.info({ orders: 0 }, "futures own-orders bootstrapped (empty)");
      return;
    }

    const allCalls = orderIds.map((id) => ({
      address: this.venue.address,
      abi: FuturesAbi,
      functionName: "getOrderById" as const,
      args: [id] as const,
    }));

    const batchSize = this.readBatchSize;
    const allOrders: unknown[] = [];
    for (let i = 0; i < allCalls.length; i += batchSize) {
      const chunk = allCalls.slice(i, i + batchSize);
      const chunkResults = await this.venue.publicClient.multicall({
        allowFailure: false,
        contracts: chunk,
      });
      allOrders.push(...chunkResults);
    }

    for (let i = 0; i < orderIds.length; i++) {
      const o = allOrders[i] as {
        participant: string;
        pricePerDay: bigint;
        deliveryAt: bigint;
        isBuy: boolean;
      };
      if (!o.participant || o.participant === ZERO_ADDRESS) continue;
      // Keep only orders belonging to this expiry.
      if (o.deliveryAt !== this.deliveryDate) continue;
      this.cache.set(orderIds[i], {
        orderId: orderIds[i],
        price: o.pricePerDay,
        side: o.isBuy ? "buy" : "sell",
        size: 1n,
        instrumentId: this.instrumentId,
      });
    }

    this.bootstrapped = true;
    this.logger.info(
      { orders: this.cache.size, deliveryDate: this.deliveryDate.toString() },
      "futures own-orders bootstrapped",
    );
  }

  private attach(): Unsubscribe {
    const own = this.venue.wallet.account.address.toLowerCase();
    return this.venue.events.subscribe((evt) => {
      if (evt.type === "order-created") {
        if (evt.participant.toLowerCase() !== own) return;
        // Route by expiry: the created event carries the instrumentId.
        if (evt.instrumentId !== this.instrumentId) return;
        const order: OwnOrder = {
          orderId: evt.orderId,
          price: evt.price,
          side: evt.side,
          size: 1n,
          instrumentId: this.instrumentId,
        };
        this.cache.set(evt.orderId, order);
        this.notify({ type: "added", orderId: evt.orderId, order });
        return;
      }
      if (evt.type === "order-cancelled") {
        // No expiry on the close event: apply only if this cache owns the id.
        if (!this.cache.has(evt.orderId)) return;
        this.cache.delete(evt.orderId);
        this.notify({ type: "removed", orderId: evt.orderId });
        return;
      }
    });
  }

  private notify(event: OwnOrderEvent): void {
    for (const cb of this.listeners) cb(event);
  }

  isBootstrapped(): boolean {
    return this.bootstrapped;
  }
}
