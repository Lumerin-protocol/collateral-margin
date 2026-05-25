import type pino from "pino";
import type {
  OwnOrder,
  OwnOrderEvent,
  OwnOrderSource,
  Unsubscribe,
} from "../../core/adapter.ts";
import { FuturesAbi } from "futures-contracts/abi/Futures";
import type { FuturesVenueAdapter } from "./venue.ts";
import { FUTURES_INSTRUMENT_ID } from "./events.ts";

/**
 * Cache-backed own-order source for futures.
 *
 * Why a cache? `Futures.sol` previously had no view returning a participant's
 * orders. The new `getOrderIds` view (added alongside this adapter) lets us
 * skip the historical event-scan path entirely:
 *
 *   1. `bootstrap()` reads `getOrderIds(wallet)` and `getOrderById(id)` for
 *      each in one multicall, populating the cache.
 *   2. `subscribe()` listens to venue events and applies adds/removes to the
 *      cache, then forwards the event to the registered callback.
 *   3. `list()` returns `Array.from(cache.values())`.
 *
 * Idempotency: bootstrap clears the cache before re-populating, so calling
 * it twice is safe.
 */
export class FuturesOwnOrders implements OwnOrderSource {
  private readonly cache = new Map<`0x${string}`, OwnOrder>();
  private readonly listeners = new Set<(event: OwnOrderEvent) => void>();
  private unsubVenue: Unsubscribe | null = null;
  private bootstrapped = false;

  private readonly venue: FuturesVenueAdapter;
  private readonly logger: pino.Logger;
  private readonly multicallBatchSize: number;

  constructor(
    venue: FuturesVenueAdapter,
    logger: pino.Logger,
    multicallBatchSize: number,
  ) {
    this.venue = venue;
    this.logger = logger.child({ component: "futures-own-orders" });
    this.multicallBatchSize = multicallBatchSize;
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
      this.logger.info(
        { orders: 0 },
        "futures own-orders bootstrapped (empty)",
      );
      return;
    }

    const allCalls = orderIds.map((id) => ({
      address: this.venue.address,
      abi: FuturesAbi,
      functionName: "getOrderById" as const,
      args: [id] as const,
    }));

    // Chunk to stay under RPC payload / timeout limits.
    const batchSize = this.multicallBatchSize;
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
        isBuy: boolean;
      };
      if (
        !o.participant ||
        o.participant === "0x0000000000000000000000000000000000000000"
      )
        continue;
      this.cache.set(orderIds[i], {
        orderId: orderIds[i],
        price: o.pricePerDay,
        side: o.isBuy ? "buy" : "sell",
        size: 1n,
        instrumentId: FUTURES_INSTRUMENT_ID,
      });
    }

    this.bootstrapped = true;
    this.logger.info(
      { orders: this.cache.size },
      "futures own-orders bootstrapped",
    );
  }

  private attach(): Unsubscribe {
    const own = this.venue.wallet.account.address.toLowerCase();
    return this.venue.events.subscribe((evt) => {
      if (evt.type === "order-created") {
        if (evt.participant.toLowerCase() !== own) return;
        const order: OwnOrder = {
          orderId: evt.orderId,
          price: evt.price,
          side: evt.side,
          size: 1n,
          instrumentId: FUTURES_INSTRUMENT_ID,
        };
        this.cache.set(evt.orderId, order);
        this.notify({ type: "added", orderId: evt.orderId, order });
        return;
      }
      if (evt.type === "order-cancelled") {
        // OrderClosed no longer carries participant; identify own orders by cache.
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
