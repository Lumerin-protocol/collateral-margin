import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256 } from "viem";
import { deployPortfolioMarginEngineFixture } from "./fixtures.js";

const { networkHelpers } = await network.connect();

/**
 * X3-D-1: the stress legs cast the summed WAD order delta with a plain `int256(...)`.
 * A delta whose WAD lift lands in [2^255, 2^256) wraps to a tiny negative number and
 * cancels the account's real delta, so a huge book reads IM ≈ MM ≈ 0.
 */
describe("X3-D-1 — order delta must not wrap into the stress legs", () => {
  // The mock reports deltas in token decimals (6); the engine lifts them by 1e12.
  const POISON_DELTA = maxUint256 / 10n ** 12n;

  it("rejects a resting bid delta that does not fit int256", async () => {
    const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
    await perpsMock.write.setOrderDeltas([user, POISON_DELTA, 0n]);

    await assert.rejects(pme.read.computePortfolioIM([user]), /SafeCastOverflowedUintToInt/);
  });

  it("rejects a resting ask delta that does not fit int256", async () => {
    const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
    await perpsMock.write.setOrderDeltas([user, 0n, POISON_DELTA]);

    await assert.rejects(pme.read.computePortfolioIM([user]), /SafeCastOverflowedUintToInt/);
  });
});
