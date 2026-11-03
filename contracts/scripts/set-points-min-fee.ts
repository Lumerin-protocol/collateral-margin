import { encodeFunctionData, getAddress, parseAbi } from "viem";
import hre from "hardhat";
import { readOptionalBigInt, requireAddress } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";

/**
 * Set `PointsHook.minFee` to `POINTS_MIN_FEE` on the hook both venues call.
 * A fill side earns points only when the fee it paid is at least `minFee`; the
 * backstop's unwind fills pay none, so any value above 0 also keeps it out.
 */
async function main() {
  logTitle("Set points min fee");

  const { viem } = await hre.network.getOrCreate();
  const minFee = readOptionalBigInt("POINTS_MIN_FEE");
  if (minFee === undefined || minFee === 0n) throw new Error("POINTS_MIN_FEE must be set above 0");

  const venueAbi = parseAbi(["function hook() view returns (address)"]);
  const pc = await viem.getPublicClient();
  const [futuresHook, perpsHook] = await Promise.all(
    [requireAddress("FUTURES_ADDRESS"), requireAddress("PERPS_ADDRESS")].map((address) =>
      pc.readContract({ address, abi: venueAbi, functionName: "hook" }),
    ),
  );
  if (getAddress(futuresHook) !== getAddress(perpsHook)) {
    throw new Error(`venues use different hooks: futures ${futuresHook}, perps ${perpsHook}`);
  }

  const [deployer] = await viem.getWalletClients();
  const hook = await viem.getContractAt("PointsHook", futuresHook);
  const adminRole = await hook.read.DEFAULT_ADMIN_ROLE();
  const deployerIsAdmin = await hook.read.hasRole([adminRole, deployer.account.address]);

  logInfo("hook", {
    Address: addrUrl(pc, futuresHook),
    "Deployer can set": deployerIsAdmin ? "yes" : "no (Safe calldata below)",
    "On-chain minFee": (await hook.read.minFee()).toString(),
    "New minFee": minFee.toString(),
  });

  await logPrompt("Review the configuration above. Proceed?");

  if (deployerIsAdmin) {
    const sim = await hook.simulate.setMinFee([minFee]);
    const receipt = await writeAndWait(deployer, sim);
    logStep("minFee set", txUrl(pc, receipt.transactionHash));
    logInfo("post-update", { minFee: (await hook.read.minFee()).toString() });
  } else {
    const calldata = encodeFunctionData({ abi: hook.abi, functionName: "setMinFee", args: [minFee] });
    logInfo("Safe calldata (run as hook admin)", { "Hook (to)": futuresHook });
    logStep(`PointsHook.setMinFee(${minFee})`, calldata);
  }

  logSuccess(addrUrl(pc, futuresHook));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
