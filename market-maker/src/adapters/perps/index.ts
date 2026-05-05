import type pino from "pino";
import type { NetworkClients } from "../../core/client.ts";
import type { VenueAdapter, WalletContext } from "../../core/adapter.ts";
import { PerpsVenueAdapter } from "./venue.ts";

export interface CreatePerpsVenueOpts {
  network: NetworkClients;
  wallet: WalletContext;
  address: `0x${string}`;
  /** Optional Multicall3 override; defaults to chain.contracts.multicall3.address. */
  multicall3Address?: `0x${string}`;
  logger: pino.Logger;
}

/**
 * Construct a perps venue adapter. Static wiring — no registry lookup.
 *
 * Caller is responsible for providing the wallet and Multicall3 address;
 * `WalletRegistry` and `createNetworkClients` from core handle both.
 *
 * matchingMode = "limit" — orders fill at any price better-or-equal.
 */
export async function createPerpsVenue(opts: CreatePerpsVenueOpts): Promise<VenueAdapter> {
  return new PerpsVenueAdapter(opts);
}

export { PerpsVenueAdapter } from "./venue.ts";
export { PerpsInstrumentAdapter } from "./instrument.ts";
