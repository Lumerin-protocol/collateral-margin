import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AccountExposure, projectRetarget, retargetRisk } from "../src/retarget.ts";

/** Bitcoin's target timespan for one 2,016-block epoch, measured over its 2,015 intervals. */
const TARGET_TIMESPAN = 2016 * 600;
const EPOCH_START = 1_044_288;

const near = (actual: number | undefined, expected: number, label: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);

describe("N62: projectRetarget", () => {
  const tipAt = (blocks: number, blockSeconds: number) => ({
    height: EPOCH_START + blocks,
    time: 1_900_000_000,
    epochStartTime: 1_900_000_000 - blocks * blockSeconds,
  });

  it("projects a difficulty rise and an index drop when blocks come fast", () => {
    const projection = projectRetarget(tipAt(1_712, 570));
    const ratio = (570 * 2015) / TARGET_TIMESPAN;
    assert.equal(projection?.blocksLeft, 304);
    near(projection?.difficultyChange, 1 / ratio - 1, "difficulty");
    near(projection?.indexStep, ratio - 1, "index step");
    assert.ok((projection?.indexStep ?? 0) < 0);
  });

  it("projects a difficulty drop and an index rise when blocks come slow", () => {
    const projection = projectRetarget(tipAt(1_000, 660));
    const ratio = (660 * 2015) / TARGET_TIMESPAN;
    assert.equal(projection?.blocksLeft, 1_016);
    near(projection?.difficultyChange, 1 / ratio - 1, "difficulty");
    near(projection?.indexStep, ratio - 1, "index step");
  });

  it("caps the adjustment at four times either way, as Bitcoin does", () => {
    const fast = projectRetarget(tipAt(500, 100));
    near(fast?.difficultyChange, 3, "fast difficulty");
    near(fast?.indexStep, -0.75, "fast index step");
    const slow = projectRetarget(tipAt(500, 3_000));
    near(slow?.difficultyChange, -0.75, "slow difficulty");
    near(slow?.indexStep, 3, "slow index step");
  });

  it("projects nothing on the epoch's first block", () => {
    assert.equal(projectRetarget(tipAt(0, 600)), null);
  });
});

describe("N62: retargetRisk", () => {
  const flat: AccountExposure = {
    balance: 0,
    maintenance: 0,
    netExposure: 0,
    buyOrderExposure: 0,
    sellOrderExposure: 0,
    unrealizedPnl: 0,
    fundingOwed: 0,
  };
  /** Backstop unwind band 200 + fee 25 bps. */
  const UNWIND_BPS = 225;
  const STEP = -0.082;

  it("flags a long whose cushion is smaller than the down-step on its exposure", () => {
    const long = { ...flat, balance: 120, maintenance: 100, netExposure: 1_000 };
    assert.deepEqual(retargetRisk([long], STEP, UNWIND_BPS), { atRisk: 1, potentialBadDebt: 0 });
  });

  it("leaves a long whose cushion covers the step", () => {
    const long = { ...flat, balance: 200, maintenance: 100, netExposure: 1_000 };
    assert.deepEqual(retargetRisk([long], STEP, UNWIND_BPS), { atRisk: 0, potentialBadDebt: 0 });
  });

  it("leaves a short on a down-step and flags it on an up-step", () => {
    const short = { ...flat, balance: 120, maintenance: 100, netExposure: -1_000 };
    assert.equal(retargetRisk([short], STEP, UNWIND_BPS).atRisk, 0);
    assert.equal(retargetRisk([short], 0.082, UNWIND_BPS).atRisk, 1);
  });

  it("counts resting orders on the losing side as filled into the step", () => {
    const bids = { ...flat, balance: 120, maintenance: 100, buyOrderExposure: 1_000 };
    assert.equal(retargetRisk([bids], STEP, UNWIND_BPS).atRisk, 1);
    const asks = { ...flat, balance: 120, maintenance: 100, sellOrderExposure: 1_000 };
    assert.equal(retargetRisk([asks], STEP, UNWIND_BPS).atRisk, 0);
    assert.equal(retargetRisk([asks], 0.082, UNWIND_BPS).atRisk, 1);
  });

  it("sums the equity that goes negative after the step and the backstop unwind", () => {
    const deep = {
      ...flat,
      balance: 250,
      maintenance: 400,
      netExposure: 4_000,
      unrealizedPnl: -10,
      fundingOwed: 2,
    };
    const covered = { ...flat, balance: 500, maintenance: 100, netExposure: 1_000 };
    const equityAfter = 250 - 10 - 2 + 4_000 * STEP - 4_000 * (1 + STEP) * (UNWIND_BPS / 10_000);
    const { atRisk, potentialBadDebt } = retargetRisk([deep, covered], STEP, UNWIND_BPS);
    assert.equal(atRisk, 1);
    near(potentialBadDebt, -equityAfter, "bad debt");
  });
});
