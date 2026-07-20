import type { Log, PublicClient, WatchContractEventReturnType } from "viem";
import type {
  Unsubscribe,
  VenueEvent,
  VenueEvents,
} from "../../core/adapter.ts";
import { FuturesAbi } from "futures-contracts/abi/Futures";

/** Instrument id for a futures expiry, e.g. `futures:1893456000`. */
export function futuresInstrumentId(expirationAt: bigint): string {
  return `futures:${expirationAt.toString()}`;
}

type FuturesLog = Log<
  bigint,
  number,
  false,
  undefined,
  false,
  typeof FuturesAbi
>;

/** Multiplexes one viem watcher across many subscribers. Decode-only. */
export class FuturesVenueEvents implements VenueEvents {
  private listeners = new Set<(event: VenueEvent) => void>();
  private unwatch: WatchContractEventReturnType | null = null;

  private readonly publicClient: PublicClient;
  private readonly address: `0x${string}`;

  constructor(publicClient: PublicClient, address: `0x${string}`) {
    this.publicClient = publicClient;
    this.address = address;
  }

  subscribe(cb: (event: VenueEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    if (this.unwatch === null) this.attachWatcher();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.detachWatcher();
    };
  }

  private attachWatcher(): void {
    this.unwatch = this.publicClient.watchContractEvent({
      address: this.address,
      abi: FuturesAbi,
      onLogs: (logs) => {
        for (const log of logs) {
          const evt = decodeEvent(log as FuturesLog);
          if (evt) for (const l of this.listeners) l(evt);
        }
      },
    });
  }

  private detachWatcher(): void {
    this.unwatch?.();
    this.unwatch = null;
  }
}

export function decodeEvent(log: FuturesLog): VenueEvent | null {
  switch (log.eventName) {
    case "OrderCreated": {
      const { orderId, participant, price, quantity, expirationAt } = log.args;
      if (
        !orderId ||
        !participant ||
        price === undefined ||
        quantity === undefined ||
        expirationAt === undefined
      )
        return null;
      const absQty = quantity < 0n ? -quantity : quantity;
      if (absQty === 0n) return null;
      return {
        type: "order-created",
        orderId,
        participant,
        price,
        side: quantity > 0n ? "buy" : "sell",
        size: absQty,
        instrumentId: futuresInstrumentId(expirationAt),
        expirationAt: expirationAt,
      };
    }
    case "OrderUpdated": {
      const { orderId, participant, newQuantity } = log.args;
      if (!orderId || !participant || newQuantity === undefined) return null;
      if (newQuantity === 0n) {
        return { type: "order-cancelled", orderId, participant };
      }
      const absQty = newQuantity < 0n ? -newQuantity : newQuantity;
      return {
        type: "order-updated",
        orderId,
        participant,
        newSize: absQty,
      };
    }
    case "OrderCancelled": {
      const { orderId } = log.args;
      if (!orderId) return null;
      return { type: "order-cancelled", orderId };
    }
    case "OrderMatched": {
      const { maker, taker, expirationAt } = log.args;
      if (!maker || !taker || expirationAt === undefined) return null;
      // Broadcast position-changed for both sides; inventory resyncs via getUserPosition.
      return {
        type: "position-changed",
        participant: maker,
        instrumentId: futuresInstrumentId(expirationAt),
      };
    }
    case "PositionLiquidated":
    case "PositionSettled": {
      const { user, expirationAt } = log.args as {
        user?: `0x${string}`;
        expirationAt?: bigint;
      };
      if (!user || expirationAt === undefined) return null;
      return {
        type: "position-changed",
        participant: user,
        instrumentId: futuresInstrumentId(expirationAt),
      };
    }
    default:
      return null;
  }
}
