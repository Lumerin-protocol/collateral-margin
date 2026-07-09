import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { solveAlertThresholds, solveLiquidationThresholds } from "../../src/predict/solve.ts";
import { imRequired, mmSurplus } from "../../src/predict/mm.ts";
import type { AccountSnapshot, MMParams } from "../../src/predict/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;
const QTY_SCALE = 10n ** 6n;

const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n, // 10%
  mmSpotShock: 5n * 10n ** 16n, // 5%
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

function emptySnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    user: USER,
    balance: 0n,
    perp: { netQty: 0n, entryPrice: 0n, orderMargin: 0n, fundingOwed: 0n },
    futures: { positions: [], orderMargin: 0n },
    ...overrides,
  };
}

/**
 * Sanity-check helper: a crossing threshold should sit on the boundary of
 * the safe region. We don't require `mmSurplus(threshold) === 0` exactly
 * (the bisector rounds to integer wei, and `mmRequired` is a sum of
 * floor-divided terms, so a few wei of slop is structural), but we do
 * require the threshold to be a true crossing — surplus is ≥ 0 on the
 * safe side at-or-near the threshold and surplus moves further negative
 * as the price moves toward the unsafe side.
 */
function assertCrossing(
  snap: AccountSnapshot,
  params: MMParams,
  threshold: bigint,
  side: "down" | "up",
): void {
  const sAt = mmSurplus(snap, params, threshold);
  assert.ok(sAt >= 0n, `expected surplus(${threshold}) ≥ 0 (safe side), got ${sAt}`);
  if (side === "down") {
    // Going further down should not increase surplus.
    const sFurther = mmSurplus(snap, params, threshold - 1n);
    assert.ok(
      sFurther <= sAt,
      `expected surplus(${threshold - 1n}) ≤ surplus(${threshold}) on down-side`,
    );
  } else {
    const sFurther = mmSurplus(snap, params, threshold + 1n);
    assert.ok(
      sFurther <= sAt,
      `expected surplus(${threshold + 1n}) ≤ surplus(${threshold}) on up-side`,
    );
  }
}

describe("predict/solve: solveLiquidationThresholds", () => {
  it("returns no thresholds when the user is currently underwater", () => {
    // Long with no balance → already underwater at any reasonable price.
    const snap = emptySnapshot({
      balance: 0n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const out = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    assert.equal(out.liqDown, undefined);
    assert.equal(out.liqUp, undefined);
  });

  it("returns no thresholds for a flat user — they're never liquidatable", () => {
    const snap = emptySnapshot({ balance: 1_000_000_000n });
    const out = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    assert.equal(out.liqDown, undefined);
    assert.equal(out.liqUp, undefined);
  });

  it("finds a downside threshold for a leveraged net-long perp position", () => {
    // 1 contract long @ $100, balance $20. Stress 5%, so at entry stress = $5.
    // Below entry, every $1 drop adds $1 PnL loss. Net mmRequired below entry:
    //   stress(P) + (entry - P) = 0.05 * P + (100 - P) = 100 - 0.95 P
    //   surplus(P) = 20 - (100 - 0.95 P) = -80 + 0.95 P
    //   crosses 0 at P = 80 / 0.95 ≈ 84.21
    const snap = emptySnapshot({
      balance: 20_000_000n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const out = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    assert.notEqual(out.liqDown, undefined);
    if (out.liqDown !== undefined) {
      // ~$84.21M (token decimals → 84_210_526n give-or-take).
      assert.ok(
        out.liqDown > 84_000_000n && out.liqDown < 85_000_000n,
        `expected liqDown ≈ 84.2 * 10^6, got ${out.liqDown}`,
      );
      assertCrossing(snap, PARAMS, out.liqDown, "down");
    }
  });

  it("finds an upside threshold for a leveraged net-short perp position", () => {
    const snap = emptySnapshot({
      balance: 20_000_000n,
      perp: { netQty: -1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const out = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    assert.notEqual(out.liqUp, undefined);
    if (out.liqUp !== undefined) {
      // Mirror of the long case: ~$117.65 ((entry + balance) / (1 - mmShock)).
      // Above entry: stress(P) + (P - entry) = 0.05P + P - 100 = 1.05P - 100
      // surplus(P) = 20 - (1.05P - 100) = 120 - 1.05P. Zero at 120/1.05 ≈ 114.29.
      assert.ok(
        out.liqUp > 113_000_000n && out.liqUp < 116_000_000n,
        `expected liqUp ≈ 114.3 * 10^6, got ${out.liqUp}`,
      );
      assertCrossing(snap, PARAMS, out.liqUp, "up");
    }
  });

  it("returns BOTH thresholds when balance is small relative to stress + position", () => {
    // Net-long, but balance high enough that stress alone (no PnL) eventually
    // eats it on the way up too. Above entry: surplus(P) = balance - stress(P)
    // = balance - 0.05P. Crosses zero at P = balance / 0.05 = 20*$1M / 0.05 = $400M.
    const snap = emptySnapshot({
      balance: 20_000_000n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const out = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    assert.notEqual(out.liqUp, undefined);
    if (out.liqUp !== undefined) {
      assert.ok(
        out.liqUp > 390_000_000n && out.liqUp < 410_000_000n,
        `expected liqUp ≈ $400M, got ${out.liqUp}`,
      );
      assertCrossing(snap, PARAMS, out.liqUp, "up");
    }
  });

  it("handles a futures buyer position the same way as a long perp", () => {
    // Buyer of 1 contract @ $50/day (delta = 1 * WAD; no duration factor),
    // collateral $30. Below entry: mmRequired(P) = stress(P) + (entry - P)
    //   = 0.05 P + (50 - P) = 50 - 0.95 P (token decimals).
    //   surplus(P) = 30 - (50 - 0.95 P) = -20 + 0.95 P → crosses 0 ≈ $21.05.
    const snap = emptySnapshot({
      balance: 30_000_000n,
      futures: {
        positions: [
          { id: "0xaa", isBuyer: true, entryPricePerDay: 50_000_000n, deliveryAt: 1_756_416_000n },
        ],
        orderMargin: 0n,
      },
    });
    const out = solveLiquidationThresholds(snap, PARAMS, 50_000_000n);
    assert.notEqual(out.liqDown, undefined);
    if (out.liqDown !== undefined) {
      assertCrossing(snap, PARAMS, out.liqDown, "down");
    }
  });

  it("threshold tightens when orderMargin and fundingOwed eat balance headroom", () => {
    const base = emptySnapshot({
      balance: 20_000_000n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const withDrag = emptySnapshot({
      balance: 20_000_000n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orderMargin: 5_000_000n,
        fundingOwed: 1_000_000n,
      },
    });
    const baseLiq = solveLiquidationThresholds(base, PARAMS, 100_000_000n).liqDown;
    const dragLiq = solveLiquidationThresholds(withDrag, PARAMS, 100_000_000n).liqDown;
    assert.notEqual(baseLiq, undefined);
    assert.notEqual(dragLiq, undefined);
    if (baseLiq !== undefined && dragLiq !== undefined) {
      // Less headroom → liquidation triggers at a higher price.
      assert.ok(
        dragLiq > baseLiq,
        `expected drag liqDown (${dragLiq}) > base liqDown (${baseLiq})`,
      );
    }
  });
});

describe("predict/solve: solveAlertThresholds", () => {
  // ppm scaling matches `computeUtilization`.
  const WARN_PPM = 850_000n; // 85%
  const CRIT_PPM = 950_000n; // 95%

  it("returns all-undefined for a flat user (no IM utilization possible)", () => {
    const snap = emptySnapshot({ balance: 1_000_000_000n });
    const out = solveAlertThresholds(snap, PARAMS, 100_000_000n, WARN_PPM, CRIT_PPM);
    assert.equal(out.warnDown, undefined);
    assert.equal(out.warnUp, undefined);
    assert.equal(out.critDown, undefined);
    assert.equal(out.critUp, undefined);
  });

  it("returns all-undefined when balance is zero (utilization undefined)", () => {
    const snap = emptySnapshot({
      balance: 0n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const out = solveAlertThresholds(snap, PARAMS, 100_000_000n, WARN_PPM, CRIT_PPM);
    assert.equal(out.warnDown, undefined);
    assert.equal(out.critDown, undefined);
  });

  it("warn threshold sits ABOVE liquidation threshold for a long going underwater", () => {
    // Long with $50 of collateral, $100 entry — both alert and liq
    // crossings exist on the downside (user is liquidatable around $52.6).
    const snap = emptySnapshot({
      balance: 50_000_000n, // $50 collateral
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const liq = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    const alerts = solveAlertThresholds(snap, PARAMS, 100_000_000n, WARN_PPM, CRIT_PPM);
    assert.notEqual(liq.liqDown, undefined);
    assert.notEqual(alerts.warnDown, undefined);
    assert.notEqual(alerts.critDown, undefined);
    if (liq.liqDown !== undefined && alerts.warnDown !== undefined && alerts.critDown !== undefined) {
      // warn should fire first (higher price), then crit, then liquidation.
      assert.ok(
        alerts.warnDown > alerts.critDown,
        `warn (${alerts.warnDown}) should be above crit (${alerts.critDown})`,
      );
      assert.ok(
        alerts.critDown > liq.liqDown,
        `crit (${alerts.critDown}) should be above liq (${liq.liqDown})`,
      );
    }
  });

  it("at the warn threshold, imRequired ≈ warnUtil * balance", () => {
    const snap = emptySnapshot({
      balance: 50_000_000n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const alerts = solveAlertThresholds(snap, PARAMS, 100_000_000n, WARN_PPM, CRIT_PPM);
    if (alerts.warnDown !== undefined) {
      const target = (WARN_PPM * snap.balance) / 1_000_000n;
      const im = imRequired(snap, PARAMS, alerts.warnDown);
      const slop = im > target ? im - target : target - im;
      // 0.1% of target — bisection on integer wei rounds; this gives a
      // generous tolerance without hiding real solver bugs.
      assert.ok(
        slop < target / 1_000n,
        `imRequired(${alerts.warnDown}) = ${im}, target = ${target}, slop = ${slop}`,
      );
    }
  });

  it("returns undefined for a level the user is already past at currentPrice", () => {
    // Long with tiny balance — already over both warn and crit at current.
    const snap = emptySnapshot({
      balance: 1_000n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const out = solveAlertThresholds(snap, PARAMS, 100_000_000n, WARN_PPM, CRIT_PPM);
    assert.equal(out.warnDown, undefined);
    assert.equal(out.critDown, undefined);
  });
});
