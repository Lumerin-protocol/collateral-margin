import { encodeFunctionData, getAddress } from "viem";
import hre from "hardhat";
import { readOptionalBigInt, requireAddress } from "../lib/env.ts";
import { readInsuranceDebtState } from "../lib/insuranceDebt.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

async function main() {
  logTitle("Set insurance debt cap");

  const { viem } = await hre.network.getOrCreate();
  const proxyAddress = requireAddress("VAULT_ADDRESS");
  const newCap = readOptionalBigInt("INSURANCE_DEBT_CAP") ?? 0n;

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const vault = await viem.getContractAt("CollateralVault", proxyAddress);
  const owner = await vault.read.owner();
  const deployerIsOwner = getAddress(owner) === getAddress(deployer.account.address);
  const state = await readInsuranceDebtState(vault);

  logInfo("vault", {
    Address: addrUrl(pc, proxyAddress),
    Owner: owner,
    "Deployer can set cap": deployerIsOwner ? "yes" : "no (Safe calldata below)",
    "On-chain cap": state.cap.toString(),
    "Effective cap": state.effectiveCap.toString(),
    Debt: state.debt.toString(),
    "Uncovered loss": state.uncovered.toString(),
    "Timing debt": state.timing.toString(),
    "Fund balance": state.fund.toString(),
    Halted: state.halted ? "yes" : "no",
    "New cap": newCap.toString(),
  });

  if (newCap < state.debt) {
    logStep(
      "Warning",
      `new cap ${newCap} is below current debt ${state.debt}. This does not halt by itself; the next borrow will.`,
    );
  }

  await logPrompt("Review the configuration above. Proceed?");

  if (deployerIsOwner) {
    const sim = await vault.simulate.setInsuranceDebtCap([newCap]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Cap set", txUrl(pc, receipt.transactionHash));
    logInfo("post-update", { Cap: (await vault.read.insuranceDebtCap()).toString() });
  } else {
    const calldata = encodeFunctionData({
      abi: vault.abi,
      functionName: "setInsuranceDebtCap",
      args: [newCap],
    });
    logInfo("Safe calldata (run as proxy owner)", {
      "Proxy (to)": proxyAddress,
      "Owner (from)": owner,
    });
    logStep(`Vault.setInsuranceDebtCap(${newCap})`, calldata);
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
