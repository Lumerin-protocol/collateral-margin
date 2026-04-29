import { encodeFunctionData, getAddress } from "viem";
import hre from "hardhat";
import { requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

async function main() {
  logTitle("CollateralVault Upgrade");

  const { viem } = await hre.network.connect();

  const proxyAddress = requireAddress("VAULT_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  const vault = await viem.getContractAt("CollateralVault", proxyAddress);
  const owner = await vault.read.owner();
  const deployerIsOwner = getAddress(owner) === getAddress(deployer.account.address);
  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Version: await vault.read.VERSION(),
    Owner: owner,
    "Deployer can upgrade": deployerIsOwner ? "yes" : "no (run upgrade via current owner)",
  });

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  // ── 1. Deploy new implementation ────────────────────────────────────────
  logInfo("Deploy new CollateralVault implementation", { contract: "CollateralVault" });
  await logPrompt("Proceed?");
  const newImpl = await viem.deployContract("CollateralVault", [], { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, newImpl.address));
  await verifyContract(newImpl.address, []);
  logStep("Verified", addrUrl(pc, newImpl.address));

  // ── 2. Upgrade proxy ────────────────────────────────────────────────────
  logInfo("Upgrade proxy", {
    Proxy: addrUrl(pc, proxyAddress),
    "New implementation": addrUrl(pc, newImpl.address),
  });

  if (deployerIsOwner) {
    await logPrompt("Proceed with upgradeToAndCall?");
    const sim = await vault.simulate.upgradeToAndCall([newImpl.address, "0x"]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Upgraded", txUrl(pc, receipt.transactionHash));

    logInfo("post-upgrade", { Version: await vault.read.VERSION() });
  } else {
    const calldata = encodeFunctionData({
      abi: vault.abi,
      functionName: "upgradeToAndCall",
      args: [newImpl.address, "0x"],
    });
    logInfo("Upgrade calldata (run as proxy owner)", {
      "Proxy (to)": proxyAddress,
      "Owner (from)": owner,
    });
    logStep(`Vault.upgradeToAndCall(${newImpl.address}, 0x)`, calldata);
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
