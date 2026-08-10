import type pino from "pino";
import type {
  OwnOrder,
  OwnOrderEvent,
  OwnOrderSource,
  Unsubscribe,
} from "../../core/adapter.ts";
import { HashPowerFuturesAbi } from "../../abi/HashPowerFutures.ts";
import type { FuturesVenueAdapter } from "./venue.ts";
import { futuresInstrumentId } from "./events.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FUTURES_USER_ORDERS_AT_EXPIRATION_ABI = [
  {
    type: "function",
    name: "getUserOrdersAtExpiration",
    stateMutability: "view",
    inputs: [
      { name: "_user", type: "address" },
      { name: "_expirationAt", type: "uint256" },
    ],
    outputs: [{ name: "orderIds", type: "bytes32[]" }],
  },
] as const;

/**
 * Cache-backed own-order source for a single futures expiry.
 *
 * The contract exposes a participant-order view scoped by delivery date:
 *
 *   1. `bootstrap()` reads `getUserOrdersAtExpiration(wallet, expirationAt)`
 *      plus `getOrder(id)`.
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
  private readonly expirationAt: bigint;
  private readonly instrumentId: string;
  private readonly logger: pino.Logger;
  private readonly readBatchSize: number;

  constructor(
    venue: FuturesVenueAdapter,
    expirationAt: bigint,
    logger: pino.Logger,
    readBatchSize: number,
  ) {
    this.venue = venue;
    this.expirationAt = expirationAt;
    this.instrumentId = futuresInstrumentId(expirationAt);
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
      abi: FUTURES_USER_ORDERS_AT_EXPIRATION_ABI,
      functionName: "getUserOrdersAtExpiration",
      args: [owner, this.expirationAt],
    });

    if (orderIds.length === 0) {
      this.bootstrapped = true;
      this.logger.info({ orders: 0 }, "futures own-orders bootstrapped (empty)");
      return;
    }

    const allCalls = orderIds.map((id) => ({
      address: this.venue.address,
      abi: HashPowerFuturesAbi,
      functionName: "getOrder" as const,
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
        price: bigint;
        quantity: bigint;
        expirationAt: bigint;
      };
      if (!o.participant || o.participant === ZERO_ADDRESS) continue;
      // Defensive against an inconsistent RPC response.
      if (o.expirationAt !== this.expirationAt) continue;
      if (o.quantity === 0n) continue;
      const absQty = o.quantity < 0n ? -o.quantity : o.quantity;
      this.cache.set(orderIds[i], {
        orderId: orderIds[i],
        price: o.price,
        side: o.quantity > 0n ? "buy" : "sell",
        size: absQty,
        instrumentId: this.instrumentId,
      });
    }

    this.bootstrapped = true;
    this.logger.info(
      { orders: this.cache.size, expirationAt: this.expirationAt.toString() },
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
          size: evt.size,
          instrumentId: this.instrumentId,
        };
        this.cache.set(evt.orderId, order);
        this.notify({ type: "added", orderId: evt.orderId, order });
        return;
      }
      if (evt.type === "order-updated") {
        const existing = this.cache.get(evt.orderId);
        if (!existing) return;
        if (evt.newSize === 0n) {
          this.cache.delete(evt.orderId);
          this.notify({ type: "removed", orderId: evt.orderId });
          return;
        }
        const order: OwnOrder = { ...existing, size: evt.newSize };
        this.cache.set(evt.orderId, order);
        this.notify({ type: "updated", orderId: evt.orderId, order });
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
