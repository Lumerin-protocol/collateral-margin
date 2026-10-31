import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployPortfolioMarginEngineFixture } from "./fixtures.js";

const { networkHelpers } = await network.connect();

describe("CF-665 step B: account debt is a margin requirement", () => {
  it("adds a flat account's debt to both IM and MM across every engine view", async () => {
    const { owner, pme, vault, user } = await networkHelpers.loadFixture(
      deployPortfolioMarginEngineFixture,
    );
    const insuranceFund = await vault.read.INSURANCE_FUND_ADDR();
    const balance = await vault.read.balanceOf([user]);
    const debt = 10_000_000_000n;

    await vault.write.setAuthorizedCaller([owner.account.address, true]);
    await vault.write.settleTransfer([user, insuranceFund, balance + debt]);

    assert.equal(await vault.read.accountDebt([user]), debt, "fixture books the unpaid loss");
    assert.equal(await pme.read.computePortfolioIM([user]), debt);
    assert.equal(await pme.read.computePortfolioMM([user]), debt);
    assert.deepEqual(await pme.read.computePortfolioMargins([user]), [debt, debt]);
    assert.deepEqual(await pme.read.reduceLimits([user]), [debt, debt]);
    assert.equal(await pme.read.isHealthy([user]), false);
    assert.equal(await pme.read.isLiquidatable([user]), true);
    assert.equal(await pme.read.canPlaceOrder([user, 0n]), false);

  });
});
