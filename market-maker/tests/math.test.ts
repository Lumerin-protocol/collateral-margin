import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BPS_SCALE,
  RollingBudget,
  RollingWindow,
  applyBps,
  bigAbs,
  calculateNotional,
  roundDownToTick,
  roundToTick,
  roundUpToTick,
} from "../src/math.ts";

describe("rounding to tick (bigint)", () => {
  it("roundDownToTick aligned/unaligned", () => {
    assert.equal(roundDownToTick(100n, 10n), 100n);
    assert.equal(roundDownToTick(105n, 10n), 100n);
    assert.equal(roundDownToTick(99n, 10n), 90n);
  });
  it("roundUpToTick aligned/unaligned", () => {
    assert.equal(roundUpToTick(100n, 10n), 100n);
    assert.equal(roundUpToTick(101n, 10n), 110n);
    assert.equal(roundUpToTick(91n, 10n), 100n);
  });
  it("roundToTick ties up", () => {
    assert.equal(roundToTick(105n, 10n), 110n);
    assert.equal(roundToTick(104n, 10n), 100n);
    assert.equal(roundToTick(106n, 10n), 110n);
  });
});

describe("calculateNotional", () => {
  it("price * absQuantity / 1e6", () => {
    assert.equal(calculateNotional(100_000_000n, 1_000_000n), 100_000_000n);
    assert.equal(calculateNotional(50_000_000n, 500_000n), 25_000_000n);
  });
  it("treats negative quantity as absolute", () => {
    assert.equal(calculateNotional(100_000_000n, -1_000_000n), 100_000_000n);
  });
});

describe("applyBps", () => {
  it("adds positive bps", () => {
    assert.equal(applyBps(10_000n, 100n), 10_100n);
  });
  it("subtracts negative bps", () => {
    assert.equal(applyBps(10_000n, -100n), 9_900n);
  });
  it("BPS_SCALE constant is 10000", () => {
    assert.equal(BPS_SCALE, 10_000n);
  });
});

describe("RollingWindow (bigint samples, Fraction volatility)", () => {
  it("constant prices → zero volatility", () => {
    const w = new RollingWindow(10);
    for (let i = 0; i < 5; i++) w.push(100n);
    assert.equal(w.volatility().valueOf(), 0);
  });
  it("varying prices → non-zero volatility", () => {
    const w = new RollingWindow(10);
    for (const p of [100n, 102n, 98n, 101n, 99n]) w.push(p);
    assert.ok(w.volatility().valueOf() > 0);
  });
  it("median (odd count)", () => {
    const w = new RollingWindow(5);
    w.push(5n);
    w.push(1n);
    w.push(3n);
    assert.equal(w.median(), 3n);
  });
  it("median (even count, integer floor of average)", () => {
    const w = new RollingWindow(5);
    for (const v of [1n, 3n, 5n, 7n]) w.push(v);
    assert.equal(w.median(), 4n);
  });
  it("respects max size and exposes latest", () => {
    const w = new RollingWindow(3);
    for (const v of [1n, 2n, 3n, 4n]) w.push(v);
    assert.equal(w.length, 3);
    assert.equal(w.latest(), 4n);
  });
  it("returns 0 vol with < 3 samples", () => {
    const w = new RollingWindow(10);
    w.push(100n);
    w.push(200n);
    assert.equal(w.volatility().valueOf(), 0);
  });
  it("skips log returns when sample is 0 and yields 0 vol", () => {
    const w = new RollingWindow(10);
    w.push(0n);
    w.push(0n);
    w.push(0n);
    w.push(100n);
    assert.equal(w.volatility().valueOf(), 0);
  });
  it("median 0 for empty window, latest undefined", () => {
    const w = new RollingWindow(5);
    assert.equal(w.median(), 0n);
    assert.equal(w.latest(), undefined);
  });
});

describe("RollingBudget", () => {
  it("sums entries within window", () => {
    const b = new RollingBudget(60_000);
    b.add(100n);
    b.add(200n);
    assert.equal(b.total(), 300n);
  });
  it("prunes expired entries", () => {
    const b = new RollingBudget(10);
    b.add(100n, 0);
    b.add(200n, 5);
    assert.equal(b.total(100), 0n);
  });
  it("keeps recent and prunes old", () => {
    const b = new RollingBudget(50);
    b.add(100n, 0);
    b.add(500n, 100);
    assert.equal(b.total(120), 500n);
  });
});

describe("bigAbs", () => {
  it("works for negative, positive, zero", () => {
    assert.equal(bigAbs(-42n), 42n);
    assert.equal(bigAbs(42n), 42n);
    assert.equal(bigAbs(0n), 0n);
  });
});
