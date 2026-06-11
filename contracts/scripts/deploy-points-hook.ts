import fs from "node:fs";
import hre from "hardhat";
import { readOptionalAddress, readOptionalBigInt, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

/**
 * Redeploy ONLY the `PointsHook` against an EXISTING `Points` token, then rewire roles.
 *
 * Unlike `deploy-points.ts` (which deploys a fresh Points token), this preserves all
 * existing balances and the leaderboard. Use it whenever the hook formula/code changes
 * (the hook is designed to be replaced, not upgraded).
 *
 * Steps (deployer must hold DEFAULT_ADMIN_ROLE on Points):
 *   1. Deploy the new PointsHook against POINTS_ADDRESS.
 *   2. Grant it MINTER_ROLE on the existing Points token.
 *   3. Optionally set minFee and the maker price-improvement multiplier.
 *   4. Grant HOOK_CALLER_ROLE to the venues (perps / futures).
 *
 * AFTER this, point each venue at the new hook (which already holds the roles) by running
 * the venue upgrade scripts with HOOK_ADDRESS = <new hook>. Because `onFill` changed shape,
 * the venue MUST be upgraded to the matching implementation in the same operation as setHook.
 */

/** Fixed-point scale: 1e18 == 1x for weights and the multiplier. */
const WEIGHT_SCALE = 1_000_000_000_000_000_000n;
/** 1.5 POINTS per notional unit (maker), biasing toward liquidity. */
const DEFAULT_W_MAKER = 1_500_000_000_000_000_000n;
/** 1 POINT per notional unit (taker). */
const DEFAULT_W_TAKER = 1_000_000_000_000_000_000n;
/** 5 POINTS (6 decimals) per liquidation. */
const DEFAULT_KEEPER_POINTS = 5_000_000n;
/** 3x maker multiplier at zero spread. */
const DEFAULT_MAX_MAKER_MULT = 3_000_000_000_000_000_000n;
/** 1% spread (WAD fraction) at/above which the multiplier returns to 1x. */
const DEFAULT_MAX_SPREAD = 10_000_000_000_000_000n;

async function main() {
  logTitle("PointsHook Redeploy (existing Points token)");

  const { viem } = await hre.network.getOrCreate();

  const pointsAddress = requireAddress("POINTS_ADDRESS");
  const wMaker = readOptionalBigInt("POINTS_W_MAKER") ?? DEFAULT_W_MAKER;
  const wTaker = readOptionalBigInt("POINTS_W_TAKER") ?? DEFAULT_W_TAKER;
  const keeperPoints = readOptionalBigInt("POINTS_KEEPER") ?? DEFAULT_KEEPER_POINTS;
  const minFee = readOptionalBigInt("POINTS_MIN_FEE");
  const maxMakerMult = readOptionalBigInt("POINTS_MAX_MAKER_MULT") ?? DEFAULT_MAX_MAKER_MULT;
  const maxSpread = readOptionalBigInt("POINTS_MAX_SPREAD") ?? DEFAULT_MAX_SPREAD;

  const PERPS_ADDRESS = readOptionalAddress("PERPS_ADDRESS");
  const FUTURES_ADDRESS = readOptionalAddress("FUTURES_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const admin = deployer.account.address;
  logInfo("deployer", { Address: addrUrl(pc, admin) });

  // The multiplier is only active when maxMakerMult > 1x AND maxSpread > 0 (mirrors the
  // hook's own enable condition); otherwise the hook stays on the plain linear path.
  const multiplierEnabled = maxMakerMult > WEIGHT_SCALE && maxSpread > 0n;

  const points = await viem.getContractAt("Points", pointsAddress);

  // Fail fast if the deployer cannot grant MINTER_ROLE (admin == EOA assumption).
  const ADMIN_ROLE = await points.read.DEFAULT_ADMIN_ROLE();
  const deployerIsAdmin = await points.read.hasRole([ADMIN_ROLE, admin]);
  if (!deployerIsAdmin) {
    throw new Error(
      `Deployer ${admin} does not hold DEFAULT_ADMIN_ROLE on Points ${pointsAddress}. ` +
        "Grant MINTER_ROLE to the new hook via the admin (e.g. Safe) instead.",
    );
  }

  logInfo("existing Points token", {
    Address: addrUrl(pc, pointsAddress),
    finalized: (await points.read.finalized()).toString(),
    totalSupply: (await points.read.totalSupply()).toString(),
  });
  logInfo("hook parameters", {
    wMaker: wMaker.toString(),
    wTaker: wTaker.toString(),
    keeperPoints: keeperPoints.toString(),
    minFee: minFee?.toString() ?? "(0)",
    priceImprovement: multiplierEnabled
      ? `maxMakerMult=${maxMakerMult} maxSpread=${maxSpread}`
      : "(disabled)",
  });
  logInfo("venues (granted HOOK_CALLER_ROLE if set)", {
    Perps: PERPS_ADDRESS ?? "(none)",
    Futures: FUTURES_ADDRESS ?? "(none)",
  });

  await logPrompt("Review the configuration above. Proceed with deployment?");

  // ── 1. Deploy the new PointsHook against the existing Points token ───────────
  logInfo("Deploy PointsHook", { points: pointsAddress });
  await logPrompt("Proceed?");
  const hookArgs = [pointsAddress, admin, wMaker, wTaker, keeperPoints] as const;
  const hook = await viem.deployContract("PointsHook", hookArgs, { confirmations: 5 });
  logStep("Deployed", addrUrl(pc, hook.address));
  await verifyContract(hook.address, [...hookArgs]);

  // ── 2. Grant MINTER_ROLE to the new hook ────────────────────────────────────
  const MINTER_ROLE = await points.read.MINTER_ROLE();
  logInfo("Points.grantRole(MINTER_ROLE, hook)", { hook: hook.address });
  await logPrompt("Proceed?");
  {
    const sim = await points.simulate.grantRole([MINTER_ROLE, hook.address]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }

  // ── 3. Optional parameter tuning ────────────────────────────────────────────
  if (minFee !== undefined) {
    const sim = await hook.simulate.setMinFee([minFee]);
    const receipt = await writeAndWait(deployer, sim);
    logStep(`hook.setMinFee(${minFee})`, txUrl(pc, receipt.transactionHash));
  }
  if (multiplierEnabled) {
    logInfo("hook.setPriceImprovement", { maxMakerMult, maxSpread });
    await logPrompt("Proceed?");
    const sim = await hook.simulate.setPriceImprovement([maxMakerMult, maxSpread]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("setPriceImprovement", txUrl(pc, receipt.transactionHash));
  }

  // ── 4. Grant HOOK_CALLER_ROLE to the venues ─────────────────────────────────
  const HOOK_CALLER_ROLE = await hook.read.HOOK_CALLER_ROLE();
  for (const [label, addr] of [
    ["perps", PERPS_ADDRESS],
    ["futures", FUTURES_ADDRESS],
  ] as const) {
    if (!addr) continue;
    logInfo(`hook.grantRole(HOOK_CALLER_ROLE, ${label})`, { venue: addr });
    await logPrompt("Proceed?");
    const sim = await hook.simulate.grantRole([HOOK_CALLER_ROLE, addr]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("Done", txUrl(pc, receipt.transactionHash));
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  logInfo("addresses", { Points: pointsAddress, PointsHook: hook.address });
  logSuccess(`New PointsHook ${hook.address} (Points ${pointsAddress})`);
  logInfo("next steps", {
    "1": `Upgrade perps with HOOK_ADDRESS=${hook.address} (deploys new impl + setHook)`,
    "2": `Upgrade futures with HOOK_ADDRESS=${hook.address} (deploys new impl + setHook)`,
    "3": "Optionally revoke MINTER_ROLE from the old hook once both venues point here",
  });

  fs.writeFileSync(
    "points-hook-addr.tmp",
    JSON.stringify({ points: pointsAddress, hook: hook.address }, null, 2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
