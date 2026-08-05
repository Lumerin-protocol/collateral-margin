import fs from "node:fs";
import { type Address, encodeFunctionData, getAddress } from "viem";
import hre from "hardhat";
import { readOptionalAddress, readOptionalBigInt, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

async function main() {
  logTitle("PortfolioMarginEngine Deployment");

  const { viem } = await hre.network.getOrCreate();

  const vaultAddress = requireAddress("VAULT_ADDRESS");
  const SAFE_OWNER_ADDRESS = readOptionalAddress("SAFE_OWNER_ADDRESS");
  const PERPS_ADDRESS = readOptionalAddress("PERPS_ADDRESS");
  const OPTIONS_ENGINE_ADDRESS = readOptionalAddress("OPTIONS_ENGINE_ADDRESS");
  const FUTURES_ADDRESS = readOptionalAddress("FUTURES_ADDRESS");
  const PRICE_ORACLE_ADDRESS = readOptionalAddress("PRICE_ORACLE_ADDRESS");

  const imSpotShock = readOptionalBigInt("IM_SPOT_SHOCK");
  const mmSpotShock = readOptionalBigInt("MM_SPOT_SHOCK");
  const imVolShock = readOptionalBigInt("IM_VOL_SHOCK");
  const mmVolShock = readOptionalBigInt("MM_VOL_SHOCK");
  const overrideShocks =
    imSpotShock !== undefined ||
    mmSpotShock !== undefined ||
    imVolShock !== undefined ||
    mmVolShock !== undefined;

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  // ── Verify vault & whether deployer can wire it ─────────────────────────
  const vault = await viem.getContractAt("CollateralVault", vaultAddress);
  const vaultOwner = await vault.read.owner();
  const deployerIsVaultOwner = getAddress(vaultOwner) === getAddress(deployer.account.address);
  logInfo("vault", {
    Address: addrUrl(pc, vault.address),
    Version: await vault.read.VERSION(),
    Owner: vaultOwner,
    "Deployer can wire vault": deployerIsVaultOwner ? "yes" : "no (wire via current owner)",
  });

  logInfo("optional engines (will be registered if set)", {
    Perps: PERPS_ADDRESS ?? "(none)",
    Options: OPTIONS_ENGINE_ADDRESS ?? "(none)",
    Futures: FUTURES_ADDRESS ?? "(none)",
    PriceOracle: PRICE_ORACLE_ADDRESS ?? "(none)",
  });

  if (overrideShocks) {
    logInfo("shock overrides (WAD)", {
      imSpotShock: imSpotShock?.toString() ?? "(default)",
      mmSpotShock: mmSpotShock?.toString() ?? "(default)",
      imVolShock: imVolShock?.toString() ?? "(default)",
      mmVolShock: mmVolShock?.toString() ?? "(default)",
    });
  }

  if (SAFE_OWNER_ADDRESS) {
    logInfo("ownership", { willTransferTo: SAFE_OWNER_ADDRESS });
  }

  await logPrompt("Review the configuration above. Proceed with deployment?");

  // ── 1. Deploy implementation ────────────────────────────────────────────
  logInfo("Deploy PortfolioMarginEngine implementation", { contract: "PortfolioMarginEngine" });
  await logPrompt("Proceed?");
  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", [], { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, pmeImpl.address));
  await verifyContract(pmeImpl.address, []);
  logStep("Verified", addrUrl(pc, pmeImpl.address));

  // ── 2. Deploy proxy ─────────────────────────────────────────────────────
  logInfo("Deploy PortfolioMarginEngine proxy", {
    implementation: pmeImpl.address,
    vault: vault.address,
  });
  await logPrompt("Proceed?");
  const pmeInitData = encodeFunctionData({
    abi: pmeImpl.abi,
    functionName: "initialize",
    args: [vault.address],
  });
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [pmeImpl.address, pmeInitData], {
    confirmations: 5,
  });
  logStep("Deployed", addrUrl(pc, pmeProxy.address));
  await verifyContract(pmeProxy.address, [pmeImpl.address, pmeInitData]);
  logStep("Verified", addrUrl(pc, pmeProxy.address));

  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);
  logInfo("pme", {
    Address: addrUrl(pc, pme.address),
    Version: await pme.read.VERSION(),
    Owner: await pme.read.owner(),
    imSpotShock: await pme.read.imSpotShock(),
    mmSpotShock: await pme.read.mmSpotShock(),
    imVolShock: await pme.read.imVolShock(),
    mmVolShock: await pme.read.mmVolShock(),
  });

  // ── 3. Override stress shocks (optional) ────────────────────────────────
  if (overrideShocks) {
    const currentImSpot = await pme.read.imSpotShock();
    const currentMmSpot = await pme.read.mmSpotShock();
    const currentImVol = await pme.read.imVolShock();
    const currentMmVol = await pme.read.mmVolShock();
    const newShocks = [
      imSpotShock ?? currentImSpot,
      mmSpotShock ?? currentMmSpot,
      imVolShock ?? currentImVol,
      mmVolShock ?? currentMmVol,
    ] as const;
    logInfo("Set stress shocks", {
      imSpotShock: newShocks[0].toString(),
      mmSpotShock: newShocks[1].toString(),
      imVolShock: newShocks[2].toString(),
      mmVolShock: newShocks[3].toString(),
    });
    await logPrompt("Proceed?");
    const sim = await pme.simulate.setShocks(newShocks);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }

  // ── 4. Register product engines on PME (optional) ───────────────────────
  if (PERPS_ADDRESS) {
    logInfo("PME.addLinearMarket (perps)", { market: PERPS_ADDRESS });
    await logPrompt("Proceed?");
    const sim = await pme.simulate.addLinearMarket([PERPS_ADDRESS]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }
  if (OPTIONS_ENGINE_ADDRESS) {
    logInfo("PME.setOptions", { optionsEngine: OPTIONS_ENGINE_ADDRESS });
    await logPrompt("Proceed?");
    const sim = await pme.simulate.setOptions([OPTIONS_ENGINE_ADDRESS]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }
  if (FUTURES_ADDRESS) {
    logInfo("PME.addLinearMarket (futures)", { market: FUTURES_ADDRESS });
    await logPrompt("Proceed?");
    const sim = await pme.simulate.addLinearMarket([FUTURES_ADDRESS]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }
  if (PRICE_ORACLE_ADDRESS) {
    logInfo("PME.setOracle", { oracle: PRICE_ORACLE_ADDRESS });
    await logPrompt("Proceed?");
    const sim = await pme.simulate.setOracle([PRICE_ORACLE_ADDRESS]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }

  // ── 5. Wire the vault (owner only) ──────────────────────────────────────
  // The deployer can do this only when it is still the vault owner. Otherwise
  // we surface the calldata that the current owner (typically a Safe) must
  // execute manually.
  const engines: { label: string; addr: Address }[] = [];
  if (PERPS_ADDRESS) engines.push({ label: "perps", addr: PERPS_ADDRESS });
  if (OPTIONS_ENGINE_ADDRESS) engines.push({ label: "options", addr: OPTIONS_ENGINE_ADDRESS });
  if (FUTURES_ADDRESS) engines.push({ label: "futures", addr: FUTURES_ADDRESS });

  if (deployerIsVaultOwner) {
    for (const { label, addr } of engines) {
      logInfo(`Vault.setAuthorizedCaller(${label})`, { caller: addr });
      await logPrompt("Proceed?");
      const sim = await vault.simulate.setAuthorizedCaller([addr, true]);
      const receipt = await writeAndWait(deployer, sim);
      logStep("Done", txUrl(pc, receipt.transactionHash));
    }

    logInfo("Vault.setMarginEngine", { marginEngine: pme.address });
    await logPrompt("Proceed?");
    const sim = await vault.simulate.setMarginEngine([pme.address]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  } else {
    const calls: { label: string; data: `0x${string}` }[] = [];
    for (const { label, addr } of engines) {
      calls.push({
        label: `Vault.setAuthorizedCaller(${label}, ${addr}, true)`,
        data: encodeFunctionData({
          abi: vault.abi,
          functionName: "setAuthorizedCaller",
          args: [addr, true],
        }),
      });
    }
    calls.push({
      label: `Vault.setMarginEngine(${pme.address})`,
      data: encodeFunctionData({
        abi: vault.abi,
        functionName: "setMarginEngine",
        args: [pme.address],
      }),
    });
    logInfo("Vault wiring (run as vault owner)", {
      "Vault address": vault.address,
      "Vault owner": vaultOwner,
    });
    for (const { label, data } of calls) {
      logStep(label, data);
    }
  }

  // ── 6. Transfer ownership of the PME (optional) ─────────────────────────
  if (SAFE_OWNER_ADDRESS) {
    logInfo("Transfer PME ownership", { owner: SAFE_OWNER_ADDRESS });
    await logPrompt("Proceed?");
    const sim = await pme.simulate.transferOwnership([SAFE_OWNER_ADDRESS]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("PME ownership", txUrl(pc, receipt.transactionHash));
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  logInfo("addresses", {
    PortfolioMarginEngine: pme.address,
    "  pme impl": pmeImpl.address,
    "wired vault": vault.address,
  });

  logSuccess(`PME ${pme.address}`);

  fs.writeFileSync("portfolio-margin-engine-addr.tmp", pme.address);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
