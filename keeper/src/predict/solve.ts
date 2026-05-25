import type { AccountSnapshot, AlertThresholds, MMParams, PriceThresholds } from "./types.ts";
import { imRequired, mmSurplus } from "./mm.ts";

/**
 * Find the price thresholds where `mmSurplus(P)` crosses zero.
 *
 * `mmRequired(P)` is piecewise-linear in P with kinks at each leg's
 * break-even price (perp entry, each futures position's entry-per-day).
 * Stress is `|delta| × shock × P / WAD` after rescaling — strictly
 * non-decreasing in P for fixed |delta|.
 *
 * For a typical net-long portfolio, `mmSurplus(P)` is therefore a tent shape:
 *   - Climbs as P rises (PnL recovers faster than stress grows) until the
 *     last losing leg breaks even.
 *   - Above all break-even prices, only stress contributes — `mmSurplus(P)`
 *     declines linearly to negative infinity as P → ∞.
 * Net-short portfolios mirror this around an inverted apex.
 *
 * We don't try to derive a single closed form for the general piecewise
 * landscape — between leg counts, sign mixes, and stress magnitude vs.
 * leverage, the case analysis is fragile. Instead we:
 *
 *   1. Enumerate the kink prices (perp entry + each futures entry).
 *   2. Bisect on each side of the current price (down and up) on intervals
 *      bounded by adjacent kinks. `mmSurplus(P)` is monotone within each
 *      interval, so a standard bisection converges in O(log) per interval.
 *   3. Return the closest crossings on either side of `currentPrice`.
 *
 * O(K · log(2^60)) per user where K is the number of kinks (≤ #futures
 * positions + 1). At keeper scale (≤ a few positions per user), this is a
 * handful of µs of pure CPU work — negligible vs the RPC the snapshot read
 * already cost.
 */
export function solveLiquidationThresholds(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
): PriceThresholds {
  // Already underwater → no useful threshold; the caller should liquidate
  // immediately rather than wait for a future price tick.
  if (mmSurplus(snap, params, currentPrice) < 0n) {
    return { user: snap.user, liqDown: undefined, liqUp: undefined };
  }
  const result = findClosestCrossings(snap, currentPrice, (P) => mmSurplus(snap, params, P));
  return { user: snap.user, liqDown: result.down, liqUp: result.up };
}

/**
 * Find the prices at which the user's IM utilization (`imRequired / balance`)
 * crosses the warn and critical thresholds. Used by the predictive
 * coordinator to fire alerts *before* the next sweep tick discovers them.
 *
 * For each level we solve `imRequired(P) - level * balance = 0`. Returns
 * `undefined` for any side that's never crossed (e.g. a flat user can't be
 * pushed into IM-warn by price moves). Already past the threshold at
 * `currentPrice` → returns `undefined` for that level (the sweep-driven
 * alert path will catch it on the next tick).
 */
export function solveAlertThresholds(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  warnUtilizationPpm: bigint,
  criticalUtilizationPpm: bigint,
): AlertThresholds {
  // No collateral → no IM utilization is well-defined; sweep handles it.
  if (snap.balance <= 0n) {
    return {
      user: snap.user,
      warnDown: undefined,
      warnUp: undefined,
      critDown: undefined,
      critUp: undefined,
    };
  }
  // Target ppm scaling: imRequired - util * balance = imRequired - (utilPpm * balance) / 1e6
  const PPM = 1_000_000n;
  const warnTarget = (warnUtilizationPpm * snap.balance) / PPM;
  const critTarget = (criticalUtilizationPpm * snap.balance) / PPM;
  const f = (target: bigint) => (P: bigint) => imRequired(snap, params, P) - target;

  // For an alert level we want price points where `imRequired(P) = target`.
  // Already at-or-over the target at currentPrice → that level isn't a
  // forward-looking trigger; the sweep alert path will fire it.
  const warn =
    imRequired(snap, params, currentPrice) >= warnTarget
      ? { down: undefined, up: undefined }
      : findClosestCrossings(snap, currentPrice, f(warnTarget));
  const crit =
    imRequired(snap, params, currentPrice) >= critTarget
      ? { down: undefined, up: undefined }
      : findClosestCrossings(snap, currentPrice, f(critTarget));
  return {
    user: snap.user,
    warnDown: warn.down,
    warnUp: warn.up,
    critDown: crit.down,
    critUp: crit.up,
  };
}

/**
 * Generic: find the closest prices on either side of `currentPrice` where
 * the supplied `f` function crosses zero. Uses the same kink-driven
 * piecewise-monotone bisection as `solveLiquidationThresholds`, parameterised
 * so multiple solvers (liq, im-warn, im-crit) can share the engine.
 *
 * Sign-convention agnostic: detects crossings regardless of which sign
 * means "safe". Callers are responsible for short-circuiting when
 * currentPrice is already past the threshold of interest.
 */
function findClosestCrossings(
  snap: AccountSnapshot,
  currentPrice: bigint,
  f: (P: bigint) => bigint,
): { down: bigint | undefined; up: bigint | undefined } {
  const kinks: bigint[] = [];
  if (snap.perp.netQty !== 0n) kinks.push(snap.perp.entryPrice);
  for (const pos of snap.futures.positions) {
    kinks.push(pos.entryPricePerDay);
  }
  kinks.push(currentPrice);
  kinks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const dedup: bigint[] = [];
  for (const k of kinks) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== k) dedup.push(k);
  }

  const lastDedup = dedup[dedup.length - 1] ?? currentPrice;
  const upperCap = lastDedup * 1024n + 1n;
  const lowerCap = 1n;

  const intervals: Array<[bigint, bigint]> = [];
  let prev = lowerCap;
  for (const k of dedup) {
    if (k > prev) intervals.push([prev, k]);
    prev = k;
  }
  if (upperCap > prev) intervals.push([prev, upperCap]);

  let down: bigint | undefined;
  let up: bigint | undefined;

  for (const [lo, hi] of intervals) {
    const sLo = f(lo);
    const sHi = f(hi);
    if ((sLo > 0n && sHi > 0n) || (sLo < 0n && sHi < 0n)) continue;
    if (sLo === 0n) {
      registerCrossing(lo, currentPrice, (isDown) => {
        if (isDown) down = closer(down, lo, currentPrice, true);
        else up = closer(up, lo, currentPrice, false);
      });
      continue;
    }
    if (sHi === 0n) {
      registerCrossing(hi, currentPrice, (isDown) => {
        if (isDown) down = closer(down, hi, currentPrice, true);
        else up = closer(up, hi, currentPrice, false);
      });
      continue;
    }
    const root = bisect(lo, hi, sLo, f);
    if (root < currentPrice) down = closer(down, root, currentPrice, true);
    else if (root > currentPrice) up = closer(up, root, currentPrice, false);
  }

  return { down, up };
}

/** Bisect within [lo, hi] until the interval shrinks to 1 wei. Assumes a sign change. */
function bisect(
  lo: bigint,
  hi: bigint,
  sLo: bigint,
  f: (P: bigint) => bigint,
): bigint {
  let a = lo;
  let b = hi;
  let sa = sLo;
  // Conservative iteration cap: for any 256-bit price the interval halves
  // 256 times before becoming 1 wei. We never actually reach that — we exit
  // on the (b - a) <= 1 condition first.
  for (let i = 0; i < 256; i++) {
    if (b - a <= 1n) return sa < 0n ? b : a;
    const mid = (a + b) / 2n;
    const sm = f(mid);
    if (sm === 0n) return mid;
    // Maintain invariant: sa and sb have opposite signs.
    if ((sa < 0n && sm < 0n) || (sa > 0n && sm > 0n)) {
      a = mid;
      sa = sm;
    } else {
      b = mid;
    }
  }
  return a;
}

function registerCrossing(at: bigint, currentPrice: bigint, sink: (down: boolean) => void): void {
  if (at < currentPrice) sink(true);
  else if (at > currentPrice) sink(false);
}

/**
 * Pick whichever candidate threshold is *closer* to `currentPrice`. For the
 * downside ("liquidatable when spot falls below"), closer means the one
 * with the higher price; for the upside, the one with the lower price.
 */
function closer(
  prev: bigint | undefined,
  candidate: bigint,
  _currentPrice: bigint,
  isDown: boolean,
): bigint {
  if (prev === undefined) return candidate;
  if (isDown) return candidate > prev ? candidate : prev;
  return candidate < prev ? candidate : prev;
}
