import {
  verifyContract as hreVerify,
  type VerifyContractArgs,
} from "@nomicfoundation/hardhat-verify/verify";
import hre from "hardhat";

/// Providers we attempt by default. Independent indexers — verifying on more
/// than one is fine, and a failure on one (e.g. Etherscan being picky about
/// constructor encoding for proxies) shouldn't mask a success on another.
const DEFAULT_PROVIDERS = ["etherscan", "blockscout", "sourcify"] as const;
type Provider = NonNullable<VerifyContractArgs["provider"]>;

/// Verify on each provider in turn. Never throws — failures are logged so the
/// deploy script can keep going.
export async function verifyContract(
  address: string,
  constructorArgs?: readonly unknown[],
  providers: readonly Provider[] = DEFAULT_PROVIDERS,
) {
  const args: Omit<VerifyContractArgs, "provider"> = {
    address,
    constructorArgs: (constructorArgs ?? []) as unknown[],
  };

  for (const provider of providers) {
    console.log(`\nVerifying ${address} on ${provider}...`);
    try {
      await hreVerify({ ...args, provider }, hre);
      console.log(`  ${provider}: verified.`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("Already Verified") || msg.includes("already been verified")) {
        console.log(`  ${provider}: already verified.`);
      } else {
        console.warn(`  ${provider}: verification failed — ${msg}`);
      }
    }
  }
}
