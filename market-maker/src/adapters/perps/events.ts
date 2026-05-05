import type { Log, PublicClient, WatchContractEventReturnType } from "viem";
import type { Unsubscribe, VenueEvent, VenueEvents } from "../../core/adapter.ts";
import { HashPowerPerpsDEXAbi } from "../../abi/HashPowerPerpsDEX.ts";

const PERPS_INSTRUMENT_ID = "perps";

type PerpsLog = Log<bigint, number, false, undefined, false, typeof HashPowerPerpsDEXAbi>;

/** Multiplexes one viem watcher across many subscribers. Decode-only. */
export class PerpsVenueEvents implements VenueEvents {
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
      abi: HashPowerPerpsDEXAbi,
      onLogs: (logs) => {
        for (const log of logs) {
          const evt = decodeEvent(log as PerpsLog);
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

/** Map a perps contract event into a `VenueEvent`. Returns null for unhandled events. */
export function decodeEvent(log: PerpsLog): VenueEvent | null {
  switch (log.eventName) {
    case "OrderCreated": {
      const { orderId, participant, price, quantity } = log.args;
      if (!orderId || !participant || price === undefined || quantity === undefined) return null;
      return {
        type: "order-created",
        orderId,
        participant,
        price,
        side: quantity > 0n ? "buy" : "sell",
        size: quantity > 0n ? quantity : -quantity,
        instrumentId: PERPS_INSTRUMENT_ID,
      };
    }
    case "OrderCancelled": {
      const { orderId, participant } = log.args;
      if (!orderId || !participant) return null;
      return { type: "order-cancelled", orderId, participant, instrumentId: PERPS_INSTRUMENT_ID };
    }
    case "OrderUpdated": {
      const { orderId, participant, newQuantity } = log.args;
      if (!orderId || !participant || newQuantity === undefined) return null;
      return {
        type: "order-updated",
        orderId,
        participant,
        newSize: newQuantity > 0n ? newQuantity : -newQuantity,
        instrumentId: PERPS_INSTRUMENT_ID,
      };
    }
    case "OrderMatched": {
      const { makerOrderId, maker, taker } = log.args;
      if (!makerOrderId) return null;
      return { type: "order-matched", makerOrderId, maker, taker, instrumentId: PERPS_INSTRUMENT_ID };
    }
    default:
      return null;
  }
}

export const PERPS_INSTRUMENT_ID_CONST = PERPS_INSTRUMENT_ID;
