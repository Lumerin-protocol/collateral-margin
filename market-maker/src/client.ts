import { createPublicClient, createWalletClient, defineChain, http, webSocket } from "viem";
import type { Chain, PublicClient, WalletClient, Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Account, Hex } from "viem";
import { arbitrum, arbitrumSepolia, base, baseSepolia, hardhat as hardhatBase } from "viem/chains";
import { ConfigError } from "./errors.ts";

export const hardhat = defineChain({
  ...hardhatBase,
  contracts: {
    ...hardhatBase.contracts,
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}`,
    },
  },
});

export const chainMapping: Record<string, Chain> = {
  "arbitrum-sepolia": arbitrumSepolia,
  "base-sepolia": baseSepolia,
  arbitrum,
  base,
  hardhat,
};

export function resolveChain(networkName: string): Chain {
  const chain = chainMapping[networkName];
  if (!chain) {
    throw new ConfigError(`Unsupported network: ${networkName}`);
  }
  return chain;
}

export function createTransport(rpcUrl: string): Transport {
  return rpcUrl.startsWith("ws") ? webSocket(rpcUrl) : http(rpcUrl);
}

export interface NetworkClients {
  publicClient: PublicClient;
  chain: Chain;
  transport: Transport;
}

export function createNetworkClients(networkName: string, rpcUrl: string): NetworkClients {
  const chain = resolveChain(networkName);
  const transport = createTransport(rpcUrl);
  const publicClient = createPublicClient({ transport, chain });
  return { publicClient, chain, transport };
}

export interface WalletClients {
  account: Account;
  walletClient: WalletClient;
}

export function createWalletFromKey(
  privateKey: Hex,
  chain: Chain,
  transport: Transport,
): WalletClients {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, transport, chain });
  return { account, walletClient };
}
