/**
 * Options venue adapter — architecture placeholder only.
 *
 * An options venue differs from perps/futures in two ways:
 *
 *  1. Multi-instrument: VenueAdapter.listInstruments() returns one InstrumentAdapter
 *     per strike/expiry pair (e.g. "options:BTC-25DEC-50000-C"). The Quoter and
 *     Executor are already instrument-scoped, so a PortfolioRunner calling them
 *     per-instrument is all that's needed.
 *
 *  2. IV-based pricing: InstrumentContext would expose { strike, expiry, isCall,
 *     underlyingSpot, impliedVol } and a BlackScholesQuoter pricing strategy would
 *     slot in alongside EffectiveSpreadQuoter / ReservationPriceQuoter.
 *
 * This stub registers "options" in the adapter registry so that a config file with
 * `venue.kind: options` produces a clear "not yet implemented" error rather than
 * an opaque "unknown kind" error.
 */

import type {
  CollateralSnapshot,
  InstrumentAdapter,
  Unsubscribe,
  VenueAdapter,
  VenueEvent,
} from "../../adapter.ts";
import { NotImplementedError } from "../../errors.ts";
import { registerAdapter } from "../../registry.ts";

export class OptionsVenueAdapter implements VenueAdapter {
  readonly kind = "options" as const;

  get wallet(): never {
    throw new NotImplementedError("OptionsVenueAdapter.wallet");
  }
  get publicClient(): never {
    throw new NotImplementedError("OptionsVenueAdapter.publicClient");
  }
  get chain(): never {
    throw new NotImplementedError("OptionsVenueAdapter.chain");
  }
  get transport(): never {
    throw new NotImplementedError("OptionsVenueAdapter.transport");
  }
  get address(): never {
    throw new NotImplementedError("OptionsVenueAdapter.address");
  }

  listInstruments(): Promise<InstrumentAdapter[]> {
    throw new NotImplementedError("OptionsVenueAdapter.listInstruments");
  }
  getCollateral(): Promise<CollateralSnapshot> {
    throw new NotImplementedError("OptionsVenueAdapter.getCollateral");
  }
  topUpCollateral(_amount: bigint): Promise<void> {
    throw new NotImplementedError("OptionsVenueAdapter.topUpCollateral");
  }
  multicall(_calls: `0x${string}`[], _opts: { maxFeePerGas?: bigint }): Promise<`0x${string}`> {
    throw new NotImplementedError("OptionsVenueAdapter.multicall");
  }
  subscribeVenueEvents(_handler: (event: VenueEvent) => void): Unsubscribe {
    throw new NotImplementedError("OptionsVenueAdapter.subscribeVenueEvents");
  }
}

let registered = false;
export function registerOptionsAdapter(): void {
  if (registered) return;
  registered = true;
  registerAdapter("options", async () => {
    throw new NotImplementedError(
      'Options adapter is not yet implemented. Set venue.kind to "perps" or "futures".',
    );
  });
}

registerOptionsAdapter();
