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
  /** Max calls per Multicall3 read batch. Default 100. */
  readBatchSize: number;
  /** Max cancelOrder calls per batch. Default 30. */
  cancelBatchSize: number;
  /** Max createOrder calls per batch. Default 30. */
  createBatchSize: number;
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
export async function createPerpsVenue(
  opts: CreatePerpsVenueOpts,
): Promise<VenueAdapter> {
  const venue = new PerpsVenueAdapter(opts);
  // Fail fast if the compiled quantity scale drifts from the deployed venue.
  await venue.validateQuantityDecimals();
  return venue;
}

export { PerpsVenueAdapter } from "./venue.ts";
export { PerpsInstrumentAdapter } from "./instrument.ts";
