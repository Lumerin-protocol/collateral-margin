import type pino from "pino";
import type { NetworkClients } from "../../core/client.ts";
import type { VenueAdapter, WalletContext } from "../../core/adapter.ts";
import { FuturesVenueAdapter } from "./venue.ts";

export interface CreateFuturesVenueOpts {
  network: NetworkClients;
  wallet: WalletContext;
  address: `0x${string}`;
  multicall3Address?: `0x${string}`;
  /** Max calls per Multicall3 read batch. Default 100. */
  readBatchSize: number;
  /** Max closeOrder calls per cancellation batch. Default 20. */
  cancelBatchSize: number;
  /** Max orders per createOrders call. Default 10. */
  createBatchSize: number;
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
