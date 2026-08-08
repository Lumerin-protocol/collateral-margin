import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { DEFAULT_MARKET_PRICE, deployPortfolioMarginEngineFixture } from "./fixtures.js";

const { networkHelpers, viem } = await network.connect();

describe("Gas: PortfolioMarginEngine", () => {
  it("computePortfolioIM representative portfolio", async () => {
    const { pme, perpsMock, optionsMock, user } = await networkHelpers.loadFixture(
      deployPortfolioMarginEngineFixture,
    );

    await perpsMock.write.setUserPosition([user, 1_000_000n, DEFAULT_MARKET_PRICE]);
    await perpsMock.write.setOrderDeltas([user, 500_000n, 250_000n]);
    await optionsMock.write.setNetGreeks([user, 100_000_000_000_000_000n, 0n, 0n]);

    const publicClient = await viem.getPublicClient();
    const gas = await publicClient.estimateGas({
      account: user,
      to: pme.address,
      data: encodeFunctionData({
        abi: pme.abi,
        functionName: "computePortfolioIM",
        args: [user],
      }),
    });
    console.log(`  computePortfolioIM representative: ${gas.toLocaleString()} gas`);
    assert.ok(gas > 0n);
  });
});
