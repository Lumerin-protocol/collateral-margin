import type { Account, Chain, Hex, Transport, WalletClient } from "viem";
import { ConfigError } from "./errors.ts";
import { createWalletFromKey } from "./client.ts";

export interface WalletContext {
  name: string;
  account: Account;
  walletClient: WalletClient;
}

/**
 * Resolves named wallets declared in config into live viem wallet contexts.
 * One `privateKeyToAccount` call per name — shared when multiple venues reference
 * the same wallet name.
 */
export class WalletRegistry {
  private readonly contexts = new Map<string, WalletContext>();

  constructor(
    walletConfigs: Record<string, { privateKey: Hex }>,
    chain: Chain,
    transport: Transport,
  ) {
    for (const [name, cfg] of Object.entries(walletConfigs)) {
      const { account, walletClient } = createWalletFromKey(cfg.privateKey, chain, transport);
      this.contexts.set(name, { name, account, walletClient });
    }
  }

  get(name: string): WalletContext {
    const ctx = this.contexts.get(name);
    if (!ctx) {
      const known = [...this.contexts.keys()].join(", ") || "<none>";
      throw new ConfigError(`Unknown wallet "${name}". Declared wallets: ${known}`);
    }
    return ctx;
  }

  has(name: string): boolean {
    return this.contexts.has(name);
  }

  names(): string[] {
    return [...this.contexts.keys()];
  }
}
