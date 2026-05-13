import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";

export interface Chain {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
}

/**
 * Builds the shared viem clients used by every module in the keeper.
 * The PublicClient is the one source of RPC reads (multicalls, event watchers,
 * receipts); the WalletClient is the single signer that broadcasts both perps
 * and futures liquidations — there is no separate validator key any more.
 */
export function createChain(config: Config): Chain {
  const transport = http(config.chain.rpcUrl);
  const publicClient = createPublicClient({ transport });
  const account = privateKeyToAccount(config.keeper.privateKey);
  const walletClient = createWalletClient({ account, transport });

  return { publicClient, walletClient, account };
}
