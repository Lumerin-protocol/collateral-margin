import fs from "node:fs";
import hre from "hardhat";
import { readOptionalAddress, readOptionalBigInt } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

/** 1.5 POINTS per notional unit (maker), biasing toward liquidity. */
const DEFAULT_W_MAKER = 1_500_000_000_000_000_000n;
/** 1 POINT per notional unit (taker). */
const DEFAULT_W_TAKER = 1_000_000_000_000_000_000n;
/** 5 POINTS (6 decimals) per liquidation. */
const DEFAULT_KEEPER_POINTS = 5_000_000n;

async function main() {
  logTitle("Points System Deployment");

  const { viem } = await hre.network.getOrCreate();

  const wMaker = readOptionalBigInt("POINTS_W_MAKER") ?? DEFAULT_W_MAKER;
  const wTaker = readOptionalBigInt("POINTS_W_TAKER") ?? DEFAULT_W_TAKER;
  const keeperPoints = readOptionalBigInt("POINTS_KEEPER") ?? DEFAULT_KEEPER_POINTS;
  const minFee = readOptionalBigInt("POINTS_MIN_FEE");

  const PERPS_DEX_ADDRESS = readOptionalAddress("PERPS_DEX_ADDRESS");
  const FUTURES_ADDRESS = readOptionalAddress("FUTURES_ADDRESS");
  const GOV_TOKEN_ADDRESS = readOptionalAddress("GOV_TOKEN_ADDRESS");
  const VESTING_ESCROW_ADDRESS = readOptionalAddress("VESTING_ESCROW_ADDRESS");
  const SAFE_OWNER_ADDRESS = readOptionalAddress("SAFE_OWNER_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const admin = deployer.account.address;
  logInfo("deployer", { Address: addrUrl(pc, admin) });

  logInfo("hook parameters", {
    wMaker: wMaker.toString(),
    wTaker: wTaker.toString(),
    keeperPoints: keeperPoints.toString(),
    minFee: minFee?.toString() ?? "(0)",
  });
  logInfo("venues (granted HOOK_CALLER_ROLE if set)", {
    Perps: PERPS_DEX_ADDRESS ?? "(none)",
    Futures: FUTURES_ADDRESS ?? "(none)",
  });
  logInfo("redeemer (deployed if both set)", {
    GOV: GOV_TOKEN_ADDRESS ?? "(none)",
    VestingEscrow: VESTING_ESCROW_ADDRESS ?? "(none)",
  });
  if (SAFE_OWNER_ADDRESS) logInfo("ownership", { willTransferTo: SAFE_OWNER_ADDRESS });

  await logPrompt("Review the configuration above. Proceed with deployment?");

  // ── 1. POINTS token ───────────────────────────────────────────────────────
  logInfo("Deploy Points", { admin });
  await logPrompt("Proceed?");
  const points = await viem.deployContract("Points", [admin], { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, points.address));
  await verifyContract(points.address, [admin]);

  // ── 2. PointsHook ─────────────────────────────────────────────────────────
  logInfo("Deploy PointsHook", { points: points.address });
  await logPrompt("Proceed?");
  const hookArgs = [points.address, admin, wMaker, wTaker, keeperPoints] as const;
  const hook = await viem.deployContract("PointsHook", hookArgs, { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, hook.address));
  await verifyContract(hook.address, [...hookArgs]);

  // ── 3. Grant MINTER_ROLE to the hook ────────────────────────────────────────
  const MINTER_ROLE = await points.read.MINTER_ROLE();
  logInfo("Points.grantRole(MINTER_ROLE, hook)", { hook: hook.address });
  await logPrompt("Proceed?");
  {
    const sim = await points.simulate.grantRole([MINTER_ROLE, hook.address]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }

  // ── 4. Optional hook parameter tuning ───────────────────────────────────────
  if (minFee !== undefined) {
    const sim = await hook.simulate.setMinFee([minFee]);
    const receipt = await writeAndWait(deployer, sim);
    logStep(`hook.setMinFee(${minFee})`, txUrl(pc, receipt.transactionHash));
  }
  // ── 5. Grant HOOK_CALLER_ROLE to the venues ─────────────────────────────────
  const HOOK_CALLER_ROLE = await hook.read.HOOK_CALLER_ROLE();
  for (const [label, addr] of [
    ["perps", PERPS_DEX_ADDRESS],
    ["futures", FUTURES_ADDRESS],
  ] as const) {
    if (!addr) continue;
    logInfo(`hook.grantRole(HOOK_CALLER_ROLE, ${label})`, { venue: addr });
    await logPrompt("Proceed?");
    const sim = await hook.simulate.grantRole([HOOK_CALLER_ROLE, addr]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }

  // ── 6. Optional PointsRedeemer ──────────────────────────────────────────────
  let redeemerAddress: string | undefined;
  if (GOV_TOKEN_ADDRESS && VESTING_ESCROW_ADDRESS) {
    const redeemerOwner = SAFE_OWNER_ADDRESS ?? admin;
    logInfo("Deploy PointsRedeemer", {
      gov: GOV_TOKEN_ADDRESS,
      escrow: VESTING_ESCROW_ADDRESS,
      owner: redeemerOwner,
    });
    await logPrompt("Proceed?");
    const redeemerArgs = [points.address, GOV_TOKEN_ADDRESS, VESTING_ESCROW_ADDRESS, redeemerOwner] as const;
    const redeemer = await viem.deployContract("PointsRedeemer", redeemerArgs, { confirmations: 5 });
    redeemerAddress = redeemer.address;
    logStep("Deployed", addrUrl(pc, redeemer.address));
    await verifyContract(redeemer.address, [...redeemerArgs]);

    const BURNER_ROLE = await points.read.BURNER_ROLE();
    logInfo("Points.grantRole(BURNER_ROLE, redeemer)", { redeemer: redeemer.address });
    await logPrompt("Proceed?");
    const sim = await points.simulate.grantRole([BURNER_ROLE, redeemer.address]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }

  // ── 7. Transfer POINTS admin to the Safe (optional) ─────────────────────────
  if (SAFE_OWNER_ADDRESS) {
    const ADMIN_ROLE = await points.read.DEFAULT_ADMIN_ROLE();
    logInfo("Points: grant admin to Safe, then renounce deployer admin", {
      safe: SAFE_OWNER_ADDRESS,
    });
    await logPrompt("Proceed?");
    let sim = await points.simulate.grantRole([ADMIN_ROLE, SAFE_OWNER_ADDRESS]);
    let receipt = await writeAndWait(deployer, sim);
    logStep("granted admin to Safe", txUrl(pc, receipt.transactionHash));

    sim = await hook.simulate.grantRole([ADMIN_ROLE, SAFE_OWNER_ADDRESS]);
    receipt = await writeAndWait(deployer, sim);
    logStep("granted hook admin to Safe", txUrl(pc, receipt.transactionHash));
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  logInfo("addresses", {
    Points: points.address,
    PointsHook: hook.address,
    PointsRedeemer: redeemerAddress ?? "(not deployed)",
  });
  logSuccess(`Points ${points.address} / Hook ${hook.address}`);

  fs.writeFileSync(
    "points-addr.tmp",
    JSON.stringify(
      { points: points.address, hook: hook.address, redeemer: redeemerAddress ?? null },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
