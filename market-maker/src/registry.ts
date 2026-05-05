import type pino from "pino";
import { ConfigError } from "./errors.ts";
import type { VenueAdapter, VenueKind } from "./adapter.ts";
import type { MakerConfig } from "./config.ts";
import type { WalletRegistry } from "./wallet.ts";
import type { NetworkClients } from "./client.ts";

export interface AdapterFactoryContext {
  config: MakerConfig;
  wallets: WalletRegistry;
  network: NetworkClients;
  logger: pino.Logger;
}

export type AdapterFactory = (ctx: AdapterFactoryContext) => Promise<VenueAdapter>;

const factories = new Map<VenueKind, AdapterFactory>();

export function registerAdapter(kind: VenueKind, factory: AdapterFactory): void {
  factories.set(kind, factory);
}

export async function createAdapter(
  kind: VenueKind,
  ctx: AdapterFactoryContext,
): Promise<VenueAdapter> {
  const factory = factories.get(kind);
  if (!factory) {
    const known = [...factories.keys()].join(", ") || "<none>";
    throw new ConfigError(`No adapter registered for kind "${kind}". Registered: ${known}`);
  }
  return factory(ctx);
}

/** Test helper: clear the registry. */
export function _clearRegistry(): void {
  factories.clear();
}
