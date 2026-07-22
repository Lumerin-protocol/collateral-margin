import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BPS_SCALE,
  RollingBudget,
  RollingWindow,
  applyBps,
  bigAbs,
  calculateNotional,
  notionalToSize,
  QUANTITY_SCALE,
  roundDownToTick,
  roundToTick,
  roundUpToTick,
} from "../../src/core/math.ts";

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

describe("notionalToSize", () => {
  it("perps: inverts calculateNotional with nearest-unit rounding", () => {
    assert.equal(notionalToSize(100_000_000n, 100_000_000n, QUANTITY_SCALE), 1_000_000n);
    // $1 at $95 → ≈ 10526.315 → rounds to 10526
    assert.equal(notionalToSize(95_000_000n, 1_000_000n, QUANTITY_SCALE), 10_526n);
  });
  it("futures: scale 1 rounds USD size allowance to whole contracts", () => {
    // $1 at $95 → 0.0105 → 0 contracts
    assert.equal(notionalToSize(95_000_000n, 1_000_000n, 1n), 0n);
    // $50 at $95 → 0.526 → 1 contract
    assert.equal(notionalToSize(95_000_000n, 50_000_000n, 1n), 1n);
    // $95 at $95 → 1 contract exactly
    assert.equal(notionalToSize(95_000_000n, 95_000_000n, 1n), 1n);
  });
  it("returns 0 for non-positive inputs", () => {
    assert.equal(notionalToSize(0n, 1_000_000n, QUANTITY_SCALE), 0n);
    assert.equal(notionalToSize(95_000_000n, 0n, QUANTITY_SCALE), 0n);
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

describe("RollingWindow per-second volatility", () => {
  // σ_per_sec Fractions can have 1000+ bit numerators/denominators (sqrt at
  // 48-bit precision), which blows up `Number(bigint) / Number(bigint)` to
  // Infinity/Infinity = NaN. `simplify` collapses the magnitude first.
  const fracVal = (f: ReturnType<RollingWindow["volatilityPerSecond"]>): number =>
    f.simplify(1e-12).valueOf();

  it("constant prices → zero per-second vol", () => {
    const w = new RollingWindow(10);
    for (let t = 0; t < 5; t++) w.push(100n, t);
    assert.equal(fracVal(w.volatilityPerSecond()), 0);
  });

  it("uniform Δt: σ_per_sec ≈ σ_per_step / √Δt", () => {
    const w = new RollingWindow(10);
    const prices = [100n, 102n, 98n, 101n, 99n, 103n];
    const dt = 4; // seconds between samples
    for (let i = 0; i < prices.length; i++) w.push(prices[i], i * dt);
    const perStep = w.volatility().simplify(1e-12).valueOf();
    const perSec = fracVal(w.volatilityPerSecond());
    // For uniform Δt the relationship is exact: σ_step = σ_sec · √Δt.
    assert.ok(
      Math.abs(perStep - perSec * Math.sqrt(dt)) < 1e-9,
      `expected σ_step=${perStep} ≈ σ_sec=${perSec} × √${dt}`,
    );
  });

  it("non-uniform Δt: per-second σ rescales with √Δt", () => {
    // Two windows with identical price moves but different sampling intervals.
    // Per-step σ is the same; per-second σ differs by exactly √(slowDt/fastDt).
    const fast = new RollingWindow(20);
    const slow = new RollingWindow(20);
    const moves = [1.005, 0.995, 1.01, 0.99, 1.008, 0.992, 1.003, 0.997];
    let pf = 1_000_000n;
    let ps = 1_000_000n;
    for (let i = 0; i < moves.length; i++) {
      pf = BigInt(Math.round(Number(pf) * moves[i]));
      ps = BigInt(Math.round(Number(ps) * moves[i]));
      fast.push(pf, i * 1); // Δt = 1s
      slow.push(ps, i * 4); // Δt = 4s
    }
    const fastSec = fracVal(fast.volatilityPerSecond());
    const slowSec = fracVal(slow.volatilityPerSecond());
    const ratio = fastSec / slowSec;
    assert.ok(
      Math.abs(ratio - 2) < 1e-9,
      `expected fast/slow ≈ 2 (√4), got ${ratio} (fastSec=${fastSec}, slowSec=${slowSec})`,
    );
  });

  it("returns 0 when timestamps are missing", () => {
    const w = new RollingWindow(10);
    w.push(100n);
    w.push(110n);
    w.push(105n);
    w.push(108n);
    assert.equal(fracVal(w.volatilityPerSecond()), 0);
  });

  it("ignores non-monotonic timestamps", () => {
    const w = new RollingWindow(10);
    // All deltas non-positive → no usable returns → σ = 0.
    w.push(100n, 100);
    w.push(110n, 100);
    w.push(105n, 99);
    w.push(108n, 98);
    assert.equal(fracVal(w.volatilityPerSecond()), 0);
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
