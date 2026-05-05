import type { Log, PublicClient, WatchContractEventReturnType } from "viem";
import type { Unsubscribe, VenueEvent, VenueEvents } from "../../core/adapter.ts";
import { FuturesAbi } from "../../abi/Futures.ts";

export const FUTURES_INSTRUMENT_ID = "futures";

type FuturesLog = Log<bigint, number, false, undefined, false, typeof FuturesAbi>;

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
      const { orderId, participant, pricePerDay, isBuy } = log.args;
      if (!orderId || !participant || pricePerDay === undefined || isBuy === undefined) return null;
      return {
        type: "order-created",
        orderId,
        participant,
        price: pricePerDay,
        side: isBuy ? "buy" : "sell",
        size: 1n, // futures orders are always single-contract per OrderCreated event
        instrumentId: FUTURES_INSTRUMENT_ID,
      };
    }
    case "OrderClosed": {
      const { orderId, participant } = log.args;
      if (!orderId || !participant) return null;
      return {
        type: "order-cancelled",
        orderId,
        participant,
        instrumentId: FUTURES_INSTRUMENT_ID,
      };
    }
    case "PositionCreated": {
      const { seller, buyer } = log.args;
      if (!seller || !buyer) return null;
      // Emit a position-changed for both sides; consumers filter by participant.
      return {
        type: "position-changed",
        participant: seller,
        instrumentId: FUTURES_INSTRUMENT_ID,
      };
    }
    case "PositionClosed":
      return { type: "position-changed", participant: "0x0" as `0x${string}`, instrumentId: FUTURES_INSTRUMENT_ID };
    default:
      return null;
  }
}
