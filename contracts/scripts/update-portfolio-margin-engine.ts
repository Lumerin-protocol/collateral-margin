import { encodeFunctionData, getAddress } from "viem";
import hre from "hardhat";
import { readOptionalAddress, readOptionalBigInt, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

const EXPECTED_VERSION = "2.5.0";

async function main() {
  logTitle("PortfolioMarginEngine Upgrade");

  const { viem } = await hre.network.getOrCreate();

  const proxyAddress = requireAddress("PME_ADDRESS");
  // Optional: post-upgrade oracle configuration. The new implementation reverts
  // margin calls with `OracleNotSet` until the PME has its own oracle reference.
  const PRICE_ORACLE_ADDRESS = readOptionalAddress("PRICE_ORACLE_ADDRESS");
  // Optional: stress shocks from config, applied after the upgrade when they differ from the chain.
  const envShocks = ["IM_SPOT_SHOCK", "MM_SPOT_SHOCK", "IM_VOL_SHOCK", "MM_VOL_SHOCK"].map(readOptionalBigInt);
  if (envShocks.some((v) => v === undefined) && envShocks.some((v) => v !== undefined)) {
    throw new Error("Set all four of IM_SPOT_SHOCK, MM_SPOT_SHOCK, IM_VOL_SHOCK, MM_VOL_SHOCK, or none");
  }

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  const pme = await viem.getContractAt("PortfolioMarginEngine", proxyAddress);
  const owner = await pme.read.owner();
  const version = await pme.read.VERSION();
  if (version === EXPECTED_VERSION) {
    throw new Error(`PortfolioMarginEngine is already ${EXPECTED_VERSION}. Aborting.`);
  }
  const deployerIsOwner = getAddress(owner) === getAddress(deployer.account.address);
  const chainShocks = [
    await pme.read.imSpotShock(),
    await pme.read.mmSpotShock(),
    await pme.read.imVolShock(),
    await pme.read.mmVolShock(),
  ] as const;
  const newShocks =
    envShocks[0] !== undefined && envShocks.some((v, i) => v !== chainShocks[i])
      ? (envShocks as [bigint, bigint, bigint, bigint])
      : undefined;
  if (newShocks && newShocks[0] < newShocks[1]) {
    throw new Error("IM_SPOT_SHOCK must be at least MM_SPOT_SHOCK");
  }
  if (newShocks && newShocks[2] < newShocks[3]) {
    throw new Error("IM_VOL_SHOCK must be at least MM_VOL_SHOCK");
  }
  // From 2.2.0 the vault is an immutable of the implementation. Building against anything
  // but the proxy's current vault would point every margin read at another ledger.
  const vaultAddress = getAddress(await pme.read.vault());
  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Version: version,
    Vault: addrUrl(pc, vaultAddress),
    Owner: owner,
    "Deployer can upgrade": deployerIsOwner ? "yes" : "no (run upgrade via current owner)",
    "Shocks (IM/MM spot, IM/MM vol)": chainShocks.join(" / "),
    "New shocks": newShocks ? newShocks.join(" / ") : "unchanged",
  });

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  // ── 1. Deploy new implementation ────────────────────────────────────────
  logInfo("Deploy new PortfolioMarginEngine implementation", {
    contract: "PortfolioMarginEngine",
  });
  await logPrompt("Proceed?");
  const newImpl = await viem.deployContract("PortfolioMarginEngine", [vaultAddress], { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, newImpl.address));
  await verifyContract(newImpl.address, [vaultAddress]);
  logStep("Verified", addrUrl(pc, newImpl.address));
  const implVersion = await newImpl.read.VERSION();
  if (implVersion !== EXPECTED_VERSION) {
    throw new Error(
      `New implementation VERSION is ${String(implVersion)}, expected ${EXPECTED_VERSION}. The proxy was not upgraded.`,
    );
  }
  if (getAddress(await newImpl.read.vault()) !== vaultAddress) {
    throw new Error(`New implementation pins ${await newImpl.read.vault()}, proxy uses ${vaultAddress}`);
  }

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

    const postVersion = await pme.read.VERSION();
    if (postVersion !== EXPECTED_VERSION) {
      throw new Error(
        `Upgrade mined in ${receipt.transactionHash}, but VERSION is ${String(postVersion)}, expected ${EXPECTED_VERSION}.`,
      );
    }
    logInfo("post-upgrade", { Version: postVersion, Vault: await pme.read.vault() });
    if (getAddress(await pme.read.vault()) !== vaultAddress) {
      throw new Error(`Post-upgrade vault ${await pme.read.vault()}, expected ${vaultAddress}`);
    }

    if (PRICE_ORACLE_ADDRESS) {
      logInfo("PME.setOracle", { oracle: PRICE_ORACLE_ADDRESS });
      await logPrompt("Proceed?");
      const oracleSim = await pme.simulate.setOracle([PRICE_ORACLE_ADDRESS]);
      const oracleReceipt = await writeAndWait(deployer, oracleSim);
      logStep("Done", txUrl(pc, oracleReceipt.transactionHash));
    }

    if (newShocks) {
      logInfo("PME.setShocks", { shocks: newShocks.join(" / ") });
      await logPrompt("Proceed?");
      const shocksSim = await pme.simulate.setShocks(newShocks);
      const shocksReceipt = await writeAndWait(deployer, shocksSim);
      logStep("Done", txUrl(pc, shocksReceipt.transactionHash));
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

    if (newShocks) {
      const shocksData = encodeFunctionData({ abi: pme.abi, functionName: "setShocks", args: newShocks });
      logStep(`PME.setShocks(${newShocks.join(", ")})`, shocksData);
    }
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
