import { encodeFunctionData, getAddress } from "viem";
import hre from "hardhat";
import { requireAddress } from "../lib/env.ts";
import { readInsuranceDebtState } from "../lib/insuranceDebt.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

async function main() {
  const action = process.argv.find((arg) => arg === "halt" || arg === "resume");
  if (action !== "halt" && action !== "resume") {
    throw new Error("Usage: hardhat run scripts/vault-halt.ts -- halt|resume");
  }

  logTitle(action === "halt" ? "Halt vault" : "Resume vault");

  const { viem } = await hre.network.getOrCreate();
  const proxyAddress = requireAddress("VAULT_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const vault = await viem.getContractAt("CollateralVault", proxyAddress);
  const owner = await vault.read.owner();
  const deployerIsOwner = getAddress(owner) === getAddress(deployer.account.address);
  const state = await readInsuranceDebtState(vault);

  logInfo("vault", {
    Address: addrUrl(pc, proxyAddress),
    Owner: owner,
    "Deployer can call": deployerIsOwner ? "yes" : "no (Safe calldata below)",
    Cap: state.cap.toString(),
    "Effective cap": state.effectiveCap.toString(),
    Debt: state.debt.toString(),
    "Uncovered loss": state.uncovered.toString(),
    "Timing debt": state.timing.toString(),
    "Fund balance": state.fund.toString(),
    Halted: state.halted ? "yes" : "no",
    "Margin engine": state.engineUnset ? "unset" : state.marginEngine,
  });

  if (action === "resume") {
    if (state.debt > state.effectiveCap) {
      throw new Error(
        `Refusing resume: debt ${state.debt} is above the effective cap ${state.effectiveCap}. Raise the cap or repay first.`,
      );
    }
    if (!state.halted) {
      throw new Error("Refusing resume: the vault is not halted.");
    }
    if (state.uncovered > 0n) {
      logStep(
        "Warning",
        `uncovered loss is ${state.uncovered}. Top that up before resuming; do not raise the cap to hide it.`,
      );
    }
  }

  await logPrompt(`Proceed to ${action}?`);

  const functionName = action === "halt" ? "halt" : "resume";
  if (deployerIsOwner) {
    const sim = action === "halt" ? await vault.simulate.halt() : await vault.simulate.resume();
    const receipt = await writeAndWait(deployer, sim);
    logStep(action, txUrl(pc, receipt.transactionHash));
    logInfo("post-update", { Halted: (await vault.read.halted()) ? "yes" : "no" });
  } else {
    const calldata = encodeFunctionData({
      abi: vault.abi,
      functionName,
      args: [],
    });
    logInfo("Safe calldata (run as proxy owner)", {
      "Proxy (to)": proxyAddress,
      "Owner (from)": owner,
    });
    logStep(`Vault.${functionName}()`, calldata);
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
