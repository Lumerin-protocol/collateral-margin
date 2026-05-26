import type pino from "pino";
import type { NetworkClients } from "../../core/client.ts";
import type { VenueAdapter, WalletContext } from "../../core/adapter.ts";
import { FuturesVenueAdapter } from "./venue.ts";

export interface CreateFuturesVenueOpts {
  network: NetworkClients;
  wallet: WalletContext;
  address: `0x${string}`;
  multicall3Address?: `0x${string}`;
  readBatchSize: number;
  writeBatchSize: number;
  logger: pino.Logger;
}

/**
 * Construct a futures venue adapter. Static wiring — no registry lookup.
 *
 * matchingMode = "exact" — fills only happen when prices coincide exactly.
 */
export async function createFuturesVenue(
  opts: CreateFuturesVenueOpts,
): Promise<VenueAdapter> {
  return new FuturesVenueAdapter(opts);
}

export { FuturesVenueAdapter } from "./venue.ts";
export { FuturesInstrumentAdapter } from "./instrument.ts";
