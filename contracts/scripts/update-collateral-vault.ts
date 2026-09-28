// Upgrades CollateralVault to 1.2.0 and calls initializeV2 in the same transaction.
// initializeV2 copies the insurance-fund balance into insuranceCapital. It does
// not set the debt cap; that stays 0 until set-insurance-debt-cap.ts.
//
// The local account (PRIVATE_KEY) deploys the implementation. The vault owner
// is that same account, or the Safe in SAFE_OWNER_ADDRESS. The owner is who
// calls upgradeToAndCall: the local account sends it, or this script prints
// calldata for the Safe. Any other owner stops the script first.

import { encodeFunctionData, formatUnits, getAddress } from "viem";
import hre from "hardhat";
import { readOptionalAddress, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

const EXPECTED_VERSION = "1.2.0";

function chainLabel(chainId: number): string {
  if (chainId === 8453) return "base (8453)";
  if (chainId === 84532) return "base-sepolia (84532)";
  return String(chainId);
}

function usdc(amount: bigint, decimals: number): string {
  return `${amount} (${formatUnits(amount, decimals)} USDC)`;
}

async function main() {
  logTitle("CollateralVault Upgrade");

  const { viem } = await hre.network.getOrCreate();

  const proxyAddress = requireAddress("VAULT_ADDRESS");
  const safeOwner = readOptionalAddress("SAFE_OWNER_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const chainId = await pc.getChainId();

  const vault = await viem.getContractAt("CollateralVault", proxyAddress);
  const [owner, version, fund, decimals] = await Promise.all([
    vault.read.owner(),
    vault.read.VERSION(),
    vault.read.insuranceFundBalance(),
    vault.read.decimals(),
  ]);
  const localAccount = deployer.account.address;
  const localAccountIsOwner = getAddress(owner) === getAddress(localAccount);
  const ownerIsSafe = safeOwner !== undefined && getAddress(owner) === getAddress(safeOwner);

  if (version === EXPECTED_VERSION) {
    throw new Error(
      `Vault is already ${EXPECTED_VERSION}. initializeV2 can only run once, so this script will not upgrade it again.`,
    );
  }
  if (!localAccountIsOwner && !ownerIsSafe) {
    throw new Error(
      `Vault owner ${owner} is neither the local account ${localAccount} nor SAFE_OWNER_ADDRESS ${safeOwner ?? "(unset)"}.`,
    );
  }

  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Chain: chainLabel(chainId),
    Version: version,
    "Local account": localAccount,
    "Vault owner": owner,
    "upgradeToAndCall from": localAccountIsOwner ? "local account" : "Safe calldata",
    "Fund balance": usdc(fund, decimals),
    "initializeV2 sets capital to": usdc(fund, decimals),
    "Debt cap": "not changed; stays 0 until set-insurance-debt-cap.ts",
  });

  const initializeV2 = encodeFunctionData({
    abi: vault.abi,
    functionName: "initializeV2",
    args: [],
  });

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  // ── 1. Deploy new implementation ────────────────────────────────────────
  logInfo("Deploy new CollateralVault implementation", { contract: "CollateralVault" });
  await logPrompt("Proceed?");
  const newImpl = await viem.deployContract("CollateralVault", [], { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, newImpl.address));
  await verifyContract(newImpl.address, []);
  logStep("Verified", addrUrl(pc, newImpl.address));

  const implVersion = await pc.readContract({
    address: newImpl.address,
    abi: vault.abi,
    functionName: "VERSION",
  });
  if (implVersion !== EXPECTED_VERSION) {
    throw new Error(
      `New implementation VERSION is ${String(implVersion)}, expected ${EXPECTED_VERSION}. The proxy was not upgraded.`,
    );
  }

  // ── 2. Upgrade proxy ────────────────────────────────────────────────────
  logInfo("Upgrade proxy", {
    Proxy: addrUrl(pc, proxyAddress),
    "New implementation": addrUrl(pc, newImpl.address),
    "Implementation version": implVersion,
    Call: "upgradeToAndCall(implementation, initializeV2())",
  });

  if (localAccountIsOwner) {
    await logPrompt("Proceed with upgradeToAndCall?");
    const sim = await vault.simulate.upgradeToAndCall([newImpl.address, initializeV2]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Upgraded", txUrl(pc, receipt.transactionHash));

    const [postVersion, capital] = await Promise.all([
      pc.readContract({
        address: proxyAddress,
        abi: vault.abi,
        functionName: "VERSION",
        blockNumber: receipt.blockNumber,
      }),
      pc.readContract({
        address: proxyAddress,
        abi: vault.abi,
        functionName: "insuranceCapital",
        blockNumber: receipt.blockNumber,
      }),
    ]);
    if (postVersion !== EXPECTED_VERSION) {
      throw new Error(
        `Upgrade mined in ${receipt.transactionHash}, but VERSION at block ${receipt.blockNumber} is ${String(postVersion)}, expected ${EXPECTED_VERSION}.`,
      );
    }
    logInfo("post-upgrade", {
      Version: postVersion,
      "Insurance capital": usdc(capital, decimals),
    });
    logSuccess(addrUrl(pc, proxyAddress));
    return;
  }

  const calldata = encodeFunctionData({
    abi: vault.abi,
    functionName: "upgradeToAndCall",
    args: [newImpl.address, initializeV2],
  });
  logInfo("Safe calldata. The local account does not own the vault, so the proxy stays on the old implementation until the Safe sends this", {
    "Proxy (to)": proxyAddress,
    "Owner (from)": owner,
    Value: "0",
  });
  logStep(`Vault.upgradeToAndCall(${newImpl.address}, initializeV2)`, calldata);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
