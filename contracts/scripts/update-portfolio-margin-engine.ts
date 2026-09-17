import { encodeFunctionData, getAddress } from "viem";
import hre from "hardhat";
import { readOptionalAddress, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

async function main() {
  logTitle("PortfolioMarginEngine Upgrade");

  const { viem } = await hre.network.getOrCreate();

  const proxyAddress = requireAddress("PME_ADDRESS");
  // Optional: post-upgrade oracle configuration. The new implementation reverts
  // margin calls with `OracleNotSet` until the PME has its own oracle reference.
  const PRICE_ORACLE_ADDRESS = readOptionalAddress("PRICE_ORACLE_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  const pme = await viem.getContractAt("PortfolioMarginEngine", proxyAddress);
  const owner = await pme.read.owner();
  const deployerIsOwner = getAddress(owner) === getAddress(deployer.account.address);
  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Version: await pme.read.VERSION(),
    Owner: owner,
    "Deployer can upgrade": deployerIsOwner ? "yes" : "no (run upgrade via current owner)",
  });

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  // ── 1. Deploy new implementation ────────────────────────────────────────
  logInfo("Deploy new PortfolioMarginEngine implementation", {
    contract: "PortfolioMarginEngine",
  });
  await logPrompt("Proceed?");
  const newImpl = await viem.deployContract("PortfolioMarginEngine", [], { confirmations: 5 });
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
    const sim = await pme.simulate.upgradeToAndCall([newImpl.address, "0x"]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Upgraded", txUrl(pc, receipt.transactionHash));

    logInfo("post-upgrade", { Version: await pme.read.VERSION() });

    if (PRICE_ORACLE_ADDRESS) {
      logInfo("PME.setOracle", { oracle: PRICE_ORACLE_ADDRESS });
      await logPrompt("Proceed?");
      const oracleSim = await pme.simulate.setOracle([PRICE_ORACLE_ADDRESS]);
      const oracleReceipt = await writeAndWait(deployer, oracleSim);
      logStep("Done", txUrl(pc, oracleReceipt.transactionHash));
    }
  } else {
    const calldata = encodeFunctionData({
      abi: pme.abi,
      functionName: "upgradeToAndCall",
      args: [newImpl.address, "0x"],
    });
    logInfo("Upgrade calldata (run as proxy owner)", {
      "Proxy (to)": proxyAddress,
      "Owner (from)": owner,
    });
    logStep(`PME.upgradeToAndCall(${newImpl.address}, 0x)`, calldata);

    if (PRICE_ORACLE_ADDRESS) {
      const oracleData = encodeFunctionData({
        abi: pme.abi,
        functionName: "setOracle",
        args: [PRICE_ORACLE_ADDRESS],
      });
      logStep(`PME.setOracle(${PRICE_ORACLE_ADDRESS})`, oracleData);
    }
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
