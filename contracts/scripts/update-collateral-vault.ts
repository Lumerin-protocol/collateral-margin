// Upgrades CollateralVault to 1.3.0. This release adds BACKSTOP_ADDR and the two
// global backstop params (both defaulting to 0), so no initializer runs for a proxy
// that is already past 1.2.0. The 1.2.0 upgrade called `initializeV2` (reinitializer 2),
// which copies the insurance-fund balance into insuranceCapital; if the proxy never ran
// it, this script calls it in the same transaction as the upgrade instead of skipping it.
//
// The local account (PRIVATE_KEY) deploys the implementation. The vault owner
// is that same account, or the Safe in SAFE_OWNER_ADDRESS. The owner is who
// calls upgradeToAndCall: the local account sends it, or this script prints
// calldata for the Safe. Any other owner stops the script first.

import {
  type Hex,
  type PublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
} from "viem";
import hre from "hardhat";
import { readOptionalAddress, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import {
  logInfo,
  logPrompt,
  logStep,
  logSuccess,
  logTitle,
} from "../lib/log.ts";

const EXPECTED_VERSION = "1.3.0";

// ERC-7201 namespaced storage slot for OpenZeppelin's `Initializable`.
const INITIALIZABLE_STORAGE_SLOT: Hex =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

async function readInitializedVersion(
  pc: PublicClient,
  proxy: `0x${string}`,
): Promise<bigint> {
  const raw = await pc.getStorageAt({
    address: proxy,
    slot: INITIALIZABLE_STORAGE_SLOT,
  });
  if (!raw || raw === "0x" || raw === "0x0") return 0n;
  return BigInt(raw) & 0xffffffffffffffffn;
}

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
  const ownerIsSafe =
    safeOwner !== undefined && getAddress(owner) === getAddress(safeOwner);

  if (version === EXPECTED_VERSION) {
    throw new Error(`Vault is already ${EXPECTED_VERSION}. Aborting.`);
  }
  if (!localAccountIsOwner && !ownerIsSafe) {
    throw new Error(
      `Vault owner ${owner} is neither the local account ${localAccount} nor SAFE_OWNER_ADDRESS ${safeOwner ?? "(unset)"}.`,
    );
  }

  const initVersion = await readInitializedVersion(pc, proxyAddress);
  const needsInitializeV2 = initVersion < 2n;

  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Chain: chainLabel(chainId),
    Version: version,
    "Init version": initVersion.toString(),
    initializeV2: needsInitializeV2
      ? "yes (proxy is pre-1.2.0)"
      : "skip (already >= 2)",
    "Local account": localAccount,
    "Vault owner": owner,
    "upgradeToAndCall from": localAccountIsOwner
      ? "local account"
      : "Safe calldata",
    "Fund balance": usdc(fund, decimals),
    "Backstop params": "set to 0; change later with setBackstopParams",
  });

  const upgradeCalldata: Hex = needsInitializeV2
    ? encodeFunctionData({
        abi: vault.abi,
        functionName: "initializeV2",
        args: [],
      })
    : "0x";
  const upgradeCall = needsInitializeV2
    ? "upgradeToAndCall(implementation, initializeV2())"
    : "upgradeToAndCall(implementation, 0x)";

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  // ── 1. Deploy new implementation ────────────────────────────────────────
  logInfo("Deploy new CollateralVault implementation", {
    contract: "CollateralVault",
  });
  await logPrompt("Proceed?");
  const newImpl = await viem.deployContract("CollateralVault", [], {
    confirmations: 5,
  });
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
    Call: upgradeCall,
  });

  if (localAccountIsOwner) {
    await logPrompt("Proceed with upgradeToAndCall?");
    const sim = await vault.simulate.upgradeToAndCall([
      newImpl.address,
      upgradeCalldata,
    ]);
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
    args: [newImpl.address, upgradeCalldata],
  });
  logInfo(
    "Safe calldata. The local account does not own the vault, so the proxy stays on the old implementation until the Safe sends this",
    {
      "Proxy (to)": proxyAddress,
      "Owner (from)": owner,
      Value: "0",
    },
  );
  logStep(`Vault.${upgradeCall}`, calldata);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
