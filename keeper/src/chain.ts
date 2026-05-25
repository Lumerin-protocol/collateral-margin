import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain as ViemChain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, hardhat } from "viem/chains";
import type { Config, NetworkName } from "./config.ts";

export interface Chain {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
}

/**
 * Mapping from our config-level network names to the matching viem chain
 * descriptor. Centralised here so transport/client wiring stays in one place.
 */
const VIEM_CHAINS: Record<NetworkName, ViemChain> = {
  hardhat,
  "base-sepolia": baseSepolia,
  "base-mainnet": base,
};

/**
 * Builds the shared viem clients used by every module in the keeper.
 * The PublicClient is the one source of RPC reads (multicalls, event watchers,
 * receipts); the WalletClient is the single signer that broadcasts both perps
 * and futures liquidations — there is no separate validator key any more.
 */
export function createChain(config: Config): Chain {
  const chain = VIEM_CHAINS[config.chain.network];
  const transport = http(config.chain.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(config.keeper.privateKey);
  const walletClient = createWalletClient({ account, chain, transport });

  return { publicClient, walletClient, account };
}
