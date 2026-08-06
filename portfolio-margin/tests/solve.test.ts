import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  solveAlertThresholds,
  solveLiquidationThresholds,
} from "../src/solve.ts";
import {
  imRequired,
  mmRequired,
  mmSurplus,
  unrealizedLoss,
} from "../src/mm.ts";
import type {
  AccountSnapshot,
  Address,
  MMParams,
  RestingOrders,
} from "../src/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;
const QTY_SCALE = 10n ** 6n;

const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;

/** An empty book on one venue. */
const NO_ORDERS: RestingOrders = {
  buyDelta: 0n,
  sellDelta: 0n,
  buyValue: 0n,
  sellValue: 0n,
};

const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n, // 10%
  mmSpotShock: 5n * 10n ** 16n, // 5%
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

function emptySnapshot(
  overrides: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    user: USER,
    balance: 0n,
    perp: { netQty: 0n, entryPrice: 0n, orders: NO_ORDERS, fundingOwed: 0n },
    futures: { positions: [], orders: NO_ORDERS },
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
  assert.ok(
    sAt >= 0n,
    `expected surplus(${threshold}) ≥ 0 (safe side), got ${sAt}`,
  );
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

/**
 * Walk a grid from `threshold` to `currentPrice` and require the account to be
 * healthy the whole way. This is the property a missing kink actually violates: the
 * bisector does not usually return a slightly wrong threshold, it skips a crossing
 * and reports a further one, leaving liquidatable prices between here and there.
 */
function assertNoCrossingBetween(
  snap: AccountSnapshot,
  params: MMParams,
  threshold: bigint,
  currentPrice: bigint,
): void {
  const lo = threshold < currentPrice ? threshold : currentPrice;
  const hi = threshold < currentPrice ? currentPrice : threshold;
  const step = (hi - lo) / 64n;
  if (step <= 0n) return;
  for (let p = lo; p <= hi; p += step) {
    const s = mmSurplus(snap, params, p);
    assert.ok(
      s >= 0n,
      `expected surplus(${p}) >= 0 between ${threshold} and ${currentPrice}, got ${s}`,
    );
  }
}

describe("predict/solve: solveLiquidationThresholds", () => {
  it("returns no thresholds when the user is currently underwater", () => {
    // Long with no balance → already underwater at any reasonable price.
    const snap = emptySnapshot({
      balance: 0n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const out = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    assert.equal(out.liqDown, undefined);
    assert.equal(out.liqUp, undefined);
  });

  it("finds a threshold hidden behind a fill-loss breakeven kink", () => {
    // A flat account whose only exposure is a resting bid *is* liquidatable now, and
    // its requirement is non-monotone in price: it drops through the bid's breakeven
    // (the fill loss vanishes) before resuming its climb with stress. The bisector only
    // finds the down-side crossing if the breakeven is in its kink set — without it,
    // the interval containing the crossing is not monotone and bisection walks past it.
    const snap = emptySnapshot({
      balance: 8_000_000n,
      perp: {
        netQty: 0n,
        entryPrice: 0n,
        // 1 contract bid at $101; at $100 the requirement is $5 stress + $1 fill loss.
        orders: {
          buyDelta: 1_000_000n,
          sellDelta: 0n,
          buyValue: 101_000_000n,
          sellValue: 0n,
        },
        fundingOwed: 0n,
      },
    });
    assert.ok(mmSurplus(snap, PARAMS, 100_000_000n) > 0n, "starts healthy");
    const out = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    // Falling price grows the bid's fill loss dollar-for-dollar, so there is a
    // down-side crossing even though the position is flat.
    assert.notEqual(
      out.liqDown,
      undefined,
      "a resting bid alone can be liquidated on a drop",
    );
    if (out.liqDown !== undefined) {
      assert.ok(mmSurplus(snap, PARAMS, out.liqDown) >= 0n);
      assert.ok(
        mmSurplus(snap, PARAMS, out.liqDown - 1n) < 0n,
        "one tick lower is unsafe",
      );
    }
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
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
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
      perp: {
        netQty: -1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
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
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
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
          {
            expirationAt: 1_756_416_000n,
            netQuantity: 1n,
            netEntryValue: 50_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    const out = solveLiquidationThresholds(snap, PARAMS, 50_000_000n);
    assert.notEqual(out.liqDown, undefined);
    if (out.liqDown !== undefined) {
      assertCrossing(snap, PARAMS, out.liqDown, "down");
    }
  });

  it("finds the threshold when the aggregate breakeven is at neither leg's entry", () => {
    // Perp long 2 @ $100 against a futures short 1 @ $50. MM clamps the two venues'
    // signed sum once, and that sum — 2(P − 100) − (P − 50) = P − 150 — breaks even
    // at $150. Not $100, not $50: the only price where the MM PnL term turns is one
    // no individual leg knows about, and it is the apex of the surplus tent.
    const snap = emptySnapshot({
      balance: 30_000_000n,
      perp: {
        netQty: 2n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: -1n,
            netEntryValue: -50_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    // At $150 the perp's +$100 and the futures' −$100 cancel: MM charges nothing,
    // while IM (clamping per market) still charges the futures leg's loss in full.
    assert.equal(unrealizedLoss(snap, PARAMS, 150_000_000n, "mm"), 0n);
    assert.equal(
      unrealizedLoss(snap, PARAMS, 150_000_000n, "im"),
      100_000_000n,
    );

    const currentPrice = 200_000_000n;
    assert.ok(mmSurplus(snap, PARAMS, currentPrice) > 0n, "starts healthy");
    const out = solveLiquidationThresholds(snap, PARAMS, currentPrice);

    // Below the apex the netted loss grows $1 per $1 of price while stress shrinks
    // by 5c: surplus = 30 − (150 − 0.95P), zero at 120 / 0.95 ≈ $126.32.
    assert.notEqual(out.liqDown, undefined);
    if (out.liqDown !== undefined) {
      assert.ok(
        out.liqDown > 126_000_000n && out.liqDown < 127_000_000n,
        `expected liqDown ≈ $126.32, got ${out.liqDown}`,
      );
      assertCrossing(snap, PARAMS, out.liqDown, "down");
      assertNoCrossingBetween(snap, PARAMS, out.liqDown, currentPrice);
    }
    // Above the apex only stress remains: 30 / 0.05 = $600.
    assert.notEqual(out.liqUp, undefined);
    if (out.liqUp !== undefined) {
      assert.ok(
        out.liqUp > 599_000_000n && out.liqUp < 601_000_000n,
        `expected liqUp ≈ $600, got ${out.liqUp}`,
      );
      assertNoCrossingBetween(snap, PARAMS, out.liqUp, currentPrice);
    }
  });

  it("turns MM once at the aggregate breakeven and IM once per venue", () => {
    // The kink sets the two solvers must enumerate, read straight off the
    // requirements. Same portfolio as above: perp long 2 @ $100, futures short 1 @ $50.
    const snap = emptySnapshot({
      balance: 30_000_000n,
      perp: {
        netQty: 2n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: -1n,
            netEntryValue: -50_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    const turningPoints = (f: (P: bigint) => bigint): bigint[] => {
      const step = 1_000_000n;
      const turns: bigint[] = [];
      let prevSlope: bigint | undefined;
      for (let P = 20_000_000n; P <= 260_000_000n; P += step) {
        const slope = f(P + step) - f(P);
        if (prevSlope !== undefined && slope !== prevSlope) turns.push(P);
        prevSlope = slope;
      }
      return turns;
    };
    // MM clamps the venues' sum once, so it turns once — and at a price that is
    // neither leg's entry.
    assert.deepEqual(
      turningPoints((P) => mmRequired(snap, PARAMS, P)),
      [150_000_000n],
    );
    // IM clamps each venue separately, so it turns at each venue's own breakeven and
    // not at the aggregate one.
    assert.deepEqual(
      turningPoints((P) => imRequired(snap, PARAMS, P)),
      [50_000_000n, 100_000_000n],
    );
  });

  it("nets a futures calendar spread across expiries when placing the threshold", () => {
    // Long 2 @ $60 and short 1 @ $30 in the same venue. The venue reports one signed
    // number, P·1 − 90, so the requirement turns at $90 and the spread's own entries
    // ($60, $30) are not kinks at all. Clamping per expiry would charge the losing
    // expiry in full and put the threshold too high — a false liquidation call.
    const snap = emptySnapshot({
      balance: 20_000_000n,
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 2n,
            netEntryValue: 120_000_000n,
            settlementPrice: 0n,
          },
          {
            expirationAt: EXPIRY_B,
            netQuantity: -1n,
            netEntryValue: -30_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    // At a $75 mark the long leg is +$30 and the short leg is −$45; netted, the venue
    // reports −$15 and that is what both requirements charge. Per-expiry clamping
    // would charge the short leg's $45 in full and ignore the long leg entirely.
    assert.equal(unrealizedLoss(snap, PARAMS, 75_000_000n, "mm"), 15_000_000n);
    assert.equal(unrealizedLoss(snap, PARAMS, 75_000_000n, "im"), 15_000_000n);

    const currentPrice = 100_000_000n;
    assert.ok(mmSurplus(snap, PARAMS, currentPrice) > 0n, "starts healthy");
    const out = solveLiquidationThresholds(snap, PARAMS, currentPrice);
    // surplus(P) = 20 − (0.05P + max(0, 90 − P)); below the apex that is 0.95P − 70,
    // zero at ≈ $73.68.
    assert.notEqual(out.liqDown, undefined);
    if (out.liqDown !== undefined) {
      assert.ok(
        out.liqDown > 73_000_000n && out.liqDown < 74_000_000n,
        `expected liqDown ≈ $73.68, got ${out.liqDown}`,
      );
      assertCrossing(snap, PARAMS, out.liqDown, "down");
      assertNoCrossingBetween(snap, PARAMS, out.liqDown, currentPrice);
    }
  });

  it("threshold tightens when resting orders and fundingOwed eat balance headroom", () => {
    const base = emptySnapshot({
      balance: 20_000_000n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const withDrag = emptySnapshot({
      balance: 20_000_000n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        // A second contract bid at the mark: doubles the buy-leg delta and so the
        // stress term, with no fill loss of its own at $100.
        orders: {
          buyDelta: 1_000_000n,
          sellDelta: 0n,
          buyValue: 100_000_000n,
          sellValue: 0n,
        },
        fundingOwed: 1_000_000n,
      },
    });
    const baseLiq = solveLiquidationThresholds(
      base,
      PARAMS,
      100_000_000n,
    ).liqDown;
    const dragLiq = solveLiquidationThresholds(
      withDrag,
      PARAMS,
      100_000_000n,
    ).liqDown;
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
    const out = solveAlertThresholds(
      snap,
      PARAMS,
      100_000_000n,
      WARN_PPM,
      CRIT_PPM,
    );
    assert.equal(out.warnDown, undefined);
    assert.equal(out.warnUp, undefined);
    assert.equal(out.critDown, undefined);
    assert.equal(out.critUp, undefined);
  });

  it("returns all-undefined when balance is zero (utilization undefined)", () => {
    const snap = emptySnapshot({
      balance: 0n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const out = solveAlertThresholds(
      snap,
      PARAMS,
      100_000_000n,
      WARN_PPM,
      CRIT_PPM,
    );
    assert.equal(out.warnDown, undefined);
    assert.equal(out.critDown, undefined);
  });

  it("warn threshold sits ABOVE liquidation threshold for a long going underwater", () => {
    // Long with $50 of collateral, $100 entry — both alert and liq
    // crossings exist on the downside (user is liquidatable around $52.6).
    const snap = emptySnapshot({
      balance: 50_000_000n, // $50 collateral
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const liq = solveLiquidationThresholds(snap, PARAMS, 100_000_000n);
    const alerts = solveAlertThresholds(
      snap,
      PARAMS,
      100_000_000n,
      WARN_PPM,
      CRIT_PPM,
    );
    assert.notEqual(liq.liqDown, undefined);
    assert.notEqual(alerts.warnDown, undefined);
    assert.notEqual(alerts.critDown, undefined);
    if (
      liq.liqDown !== undefined &&
      alerts.warnDown !== undefined &&
      alerts.critDown !== undefined
    ) {
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
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const alerts = solveAlertThresholds(
      snap,
      PARAMS,
      100_000_000n,
      WARN_PPM,
      CRIT_PPM,
    );
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

  it("kinks the IM path at the futures venue's netted breakeven, not at each entry", () => {
    // Same calendar spread as above: long 2 @ $60, short 1 @ $30, netting to P − 90.
    // IM clamps per *market*, and the futures market is already netted across its
    // expiries by `getRiskView`, so the IM requirement turns at $90 and nowhere else.
    const snap = emptySnapshot({
      balance: 20_000_000n,
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 2n,
            netEntryValue: 120_000_000n,
            settlementPrice: 0n,
          },
          {
            expirationAt: EXPIRY_B,
            netQuantity: -1n,
            netEntryValue: -30_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    // V-shaped around $90 — the clamp turning over is the only kink in the term.
    assert.ok(
      imRequired(snap, PARAMS, 89_000_000n) >
        imRequired(snap, PARAMS, 90_000_000n),
    );
    assert.ok(
      imRequired(snap, PARAMS, 91_000_000n) >
        imRequired(snap, PARAMS, 90_000_000n),
    );
    // Neither leg's own entry turns it: the requirement falls straight through both.
    assert.ok(
      imRequired(snap, PARAMS, 29_000_000n) >
        imRequired(snap, PARAMS, 31_000_000n),
    );
    assert.ok(
      imRequired(snap, PARAMS, 59_000_000n) >
        imRequired(snap, PARAMS, 61_000_000n),
    );

    const alerts = solveAlertThresholds(
      snap,
      PARAMS,
      100_000_000n,
      WARN_PPM,
      CRIT_PPM,
    );
    // Both sides are reachable: down through the netted loss, up through stress.
    for (const threshold of [alerts.warnDown, alerts.warnUp]) {
      assert.notEqual(threshold, undefined);
      if (threshold === undefined) continue;
      const target = (WARN_PPM * snap.balance) / 1_000_000n;
      const im = imRequired(snap, PARAMS, threshold);
      const slop = im > target ? im - target : target - im;
      assert.ok(
        slop < target / 1_000n,
        `imRequired(${threshold}) = ${im}, target = ${target}`,
      );
    }
    // The down-side warn sits where 90 − 0.9P = 17, i.e. ≈ $81.11.
    if (alerts.warnDown !== undefined) {
      assert.ok(
        alerts.warnDown > 81_000_000n && alerts.warnDown < 81_200_000n,
        `expected warnDown ≈ $81.11, got ${alerts.warnDown}`,
      );
    }
  });

  it("returns undefined for a level the user is already past at currentPrice", () => {
    // Long with tiny balance — already over both warn and crit at current.
    const snap = emptySnapshot({
      balance: 1_000n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const out = solveAlertThresholds(
      snap,
      PARAMS,
      100_000_000n,
      WARN_PPM,
      CRIT_PPM,
    );
    assert.equal(out.warnDown, undefined);
    assert.equal(out.critDown, undefined);
  });
});
