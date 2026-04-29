import fs from "node:fs";
import { encodeFunctionData } from "viem";
import hre from "hardhat";
import { readOptionalAddress, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

async function main() {
  logTitle("CollateralVault Deployment");

  const { viem } = await hre.network.connect();

  const collateralTokenAddress = requireAddress("COLLATERAL_TOKEN_ADDRESS");
  const SAFE_OWNER_ADDRESS = readOptionalAddress("SAFE_OWNER_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  // ── Verify collateral token ─────────────────────────────────────────────
  const collateralToken = await viem.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    collateralTokenAddress,
  );
  logInfo("collateral", {
    Address: collateralToken.address,
    Symbol: await collateralToken.read.symbol(),
    Name: await collateralToken.read.name(),
    Decimals: await collateralToken.read.decimals(),
  });

  if (SAFE_OWNER_ADDRESS) {
    logInfo("ownership", { willTransferTo: SAFE_OWNER_ADDRESS });
  }

  await logPrompt("Review the configuration above. Proceed with deployment?");

  // ── 1. Deploy implementation ────────────────────────────────────────────
  logInfo("Deploy CollateralVault implementation", { contract: "CollateralVault" });
  await logPrompt("Proceed?");
  const vaultImpl = await viem.deployContract("CollateralVault", [], { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, vaultImpl.address));
  await verifyContract(vaultImpl.address, []);
  logStep("Verified", addrUrl(pc, vaultImpl.address));

  // ── 2. Deploy proxy ─────────────────────────────────────────────────────
  logInfo("Deploy CollateralVault proxy", {
    implementation: vaultImpl.address,
    collateralToken: collateralTokenAddress,
  });
  await logPrompt("Proceed?");
  const vaultInitData = encodeFunctionData({
    abi: vaultImpl.abi,
    functionName: "initialize",
    args: [collateralTokenAddress],
  });
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [vaultImpl.address, vaultInitData], {
    confirmations: 5,
  });
  logStep("Deployed", addrUrl(pc, vaultProxy.address));
  await verifyContract(vaultProxy.address, [vaultImpl.address, vaultInitData]);
  logStep("Verified", addrUrl(pc, vaultProxy.address));

  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);
  logInfo("vault", {
    Address: addrUrl(pc, vault.address),
    Version: await vault.read.VERSION(),
    Symbol: await vault.read.symbol(),
    Owner: await vault.read.owner(),
  });

  // ── 3. Transfer ownership (optional) ────────────────────────────────────
  if (SAFE_OWNER_ADDRESS) {
    logInfo("Transfer ownership", { owner: SAFE_OWNER_ADDRESS });
    await logPrompt("Proceed?");
    const sim = await vault.simulate.transferOwnership([SAFE_OWNER_ADDRESS]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Vault ownership", txUrl(pc, receipt.transactionHash));
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  logInfo("addresses", {
    CollateralVault: vault.address,
    "  vault impl": vaultImpl.address,
  });

  logSuccess(`Vault ${vault.address}`);

  fs.writeFileSync("collateral-vault-addr.tmp", vault.address);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
