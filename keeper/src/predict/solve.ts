import type { AccountSnapshot, AlertThresholds, FuturesCloseLeg, MMParams, PriceThresholds } from "./types.ts";
import { imRequired, imSurplus, mmSurplus } from "./mm.ts";

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** Average entry price for an aggregate (`|netEntryValue| / |netQuantity|`). */
function avgEntry(pos: AccountSnapshot["futures"]["positions"][number]): bigint {
  const absNet = abs(pos.netQuantity);
  if (absNet === 0n) return 0n;
  return abs(pos.netEntryValue) / absNet;
}

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
    if (pos.netQuantity !== 0n) kinks.push(avgEntry(pos));
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

// ───────────────────────────────────────────────────────────────────────────
// Close-to-IM-buffer sizing (the batched-liquidation solvers)
//
// The on-chain `liquidatePositions` (futures) / `liquidatePosition(user,
// closeQty)` (perps) do NOT recompute margin per unit — they close the
// keeper-supplied amount and enforce a single end-of-tx `OverLiquidation`
// guard: with positions remaining and a real IM buffer (`im > mm`), the
// leftover balance must sit at/under IM. These solvers pick, off-chain, the
// deepest close that keeps the account inside the `[MM, IM]` band (healthy but
// not over-liquidated). If no in-band partial exists (deep crash / bad debt)
// they fall back to a full close, which the contract lets through (the guard
// is skipped once no positions remain).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Off-chain replica of the futures batch close: reduce each aggregate toward
 * zero by `closeQty` and debit realized PnL + flat fee per expiry leg.
 * Mirrors `Futures._doPartialLiquidatePosition` / `_doLiquidateFullPosition`.
 */
export function simulateFuturesClose(
  snap: AccountSnapshot,
  closes: readonly FuturesCloseLeg[],
  currentPrice: bigint,
  liquidationFee: bigint,
): AccountSnapshot {
  const closeByExpiry = new Map<bigint, bigint>();
  for (const c of closes) {
    closeByExpiry.set(c.expirationAt, (closeByExpiry.get(c.expirationAt) ?? 0n) + c.closeQty);
  }

  const remaining: AccountSnapshot["futures"]["positions"] = [];
  let balanceDelta = 0n;
  for (const pos of snap.futures.positions) {
    const want = closeByExpiry.get(pos.expirationAt) ?? 0n;
    if (want <= 0n) {
      remaining.push(pos);
      continue;
    }
    const absNet = abs(pos.netQuantity);
    const closeAbs = want < absNet ? want : absNet;
    if (closeAbs <= 0n) {
      remaining.push(pos);
      continue;
    }

    const entry = avgEntry(pos);
    const signedClose = pos.netQuantity > 0n ? closeAbs : -closeAbs;
    const pnl = (currentPrice - entry) * signedClose;
    balanceDelta += pnl - liquidationFee;

    if (closeAbs >= absNet) continue;
    const newAbs = absNet - closeAbs;
    remaining.push({
      expirationAt: pos.expirationAt,
      netQuantity: pos.netQuantity > 0n ? newAbs : -newAbs,
      netEntryValue: (pos.netEntryValue * newAbs) / absNet,
    });
  }

  return {
    ...snap,
    balance: snap.balance + balanceDelta,
    futures: { ...snap.futures, positions: remaining },
  };
}

/**
 * Off-chain replica of the perps partial close: reduce `netQty` toward zero by
 * `min(closeQty, |netQty|)` and debit the realized PnL on that slice plus the
 * single flat fee. Mirrors `HashPowerPerpsDEX._doPartialLiquidatePosition`
 * (`_settleReducedPosition` + one `liquidationFee`). Entry price unchanged.
 */
export function simulatePerpClose(
  snap: AccountSnapshot,
  closeQty: bigint,
  currentPrice: bigint,
  liquidationFee: bigint,
): AccountSnapshot {
  const netQty = snap.perp.netQty;
  const absNet = netQty < 0n ? -netQty : netQty;
  const closeAbs = closeQty < absNet ? closeQty : absNet;
  if (closeAbs <= 0n) return snap;

  const isLong = netQty > 0n;
  const signedClose = isLong ? closeAbs : -closeAbs;
  // Perps quantities are scaled by 10^QUANTITY_DECIMALS (=6 in HashPowerPerpsDEX);
  // matches `perpUnrealizedLoss` in mm.ts and the venue's QUANTITY_SCALE.
  const qtyScale = 10n ** 6n;
  const pnl = ((currentPrice - snap.perp.entryPrice) * signedClose) / qtyScale;
  const newNetQty = isLong ? netQty - closeAbs : netQty + closeAbs;
  return {
    ...snap,
    balance: snap.balance + pnl - liquidationFee,
    perp: { ...snap.perp, netQty: newNetQty },
  };
}

/**
 * Pick per-expiry `closeQty` legs so the account lands inside the `[MM, IM]`
 * band. Unit closes are ranked worst-first and interleaved across expiries
 * (round-robin) so a prefix does not drain one book before touching another.
 * Returns `[]` if already healthy, or a full close of every aggregate when no
 * in-band partial exists (deep crash / bad debt).
 */
export function solveFuturesClosesToTarget(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
): FuturesCloseLeg[] {
  const positions = snap.futures.positions;
  if (positions.length === 0) return [];
  if (mmSurplus(snap, params, currentPrice) >= 0n) return [];

  const hasBuffer = params.imSpotShock > params.mmSpotShock;
  const unitSequence = rankUnitClosesBalancedAcrossExpirations(positions, currentPrice);
  const n = unitSequence.length;
  if (n === 0) return [];

  let bestPrefix = 0;
  let foundInBand = false;
  for (let k = 1; k <= n; k++) {
    const closes = coalesceUnitPrefix(unitSequence, k);
    const after = simulateFuturesClose(snap, closes, currentPrice, liquidationFee);
    const mmS = mmSurplus(after, params, currentPrice);
    const imS = imSurplus(after, params, currentPrice);
    if (!hasBuffer) {
      if (mmS >= 0n) {
        bestPrefix = k;
        foundInBand = true;
        break;
      }
      continue;
    }
    if (mmS >= 0n && imS <= 0n) {
      bestPrefix = k;
      foundInBand = true;
    }
    if (imS > 0n) break;
  }

  if (!foundInBand) {
    // Full close every aggregate.
    return positions.map((p) => ({
      expirationAt: p.expirationAt,
      closeQty: abs(p.netQuantity),
    }));
  }
  return coalesceUnitPrefix(unitSequence, bestPrefix);
}

/**
 * Pick the absolute `closeQty` (scaled by perp quantity decimals) to partially
 * close a perps position down into the `[MM, IM]` band. `mmSurplus` and
 * `imSurplus` are both monotone increasing in the closed quantity, so we
 * bisect: with a real IM buffer we take the deepest close that stays at/under
 * IM (which is automatically ≥ the minimal-healthy amount); degenerate
 * `IM == MM` targets minimal-healthy. Returns `0n` if already healthy, or
 * `|netQty|` (full close) when even closing everything can't reach the band
 * (deep crash / bad debt).
 */
export function solvePerpCloseToTarget(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
): bigint {
  const netQty = snap.perp.netQty;
  const absNet = netQty < 0n ? -netQty : netQty;
  if (absNet === 0n) return 0n;
  if (mmSurplus(snap, params, currentPrice) >= 0n) return 0n;

  const mmS = (q: bigint) =>
    mmSurplus(simulatePerpClose(snap, q, currentPrice, liquidationFee), params, currentPrice);
  const imS = (q: bigint) =>
    imSurplus(simulatePerpClose(snap, q, currentPrice, liquidationFee), params, currentPrice);

  const hasBuffer = params.imSpotShock > params.mmSpotShock;

  if (!hasBuffer) {
    // Minimal healthy close; if even a full close can't heal, full close.
    if (mmS(absNet) < 0n) return absNet;
    const qHealthy = firstQtyWhere(mmS, absNet);
    return qHealthy >= absNet ? absNet : qHealthy;
  }

  // If even a full close leaves the account under MM, it's bad debt — close all.
  if (mmS(absNet) < 0n) return absNet;

  // Deepest close that stays at/under IM = (first q where imSurplus > 0) − 1.
  // If IM surplus never turns positive before a full close, the whole position
  // is bad-debt-adjacent → full close.
  if (imS(absNet) <= 0n) return absNet;
  const qOverIM = firstQtyWhere((q) => (imS(q) > 0n ? 1n : -1n), absNet);
  const qStar = qOverIM - 1n;
  return qStar >= absNet ? absNet : qStar < 0n ? 0n : qStar;
}

/**
 * Smallest `q` in `[0, hi]` at which the monotone-increasing `f(q)` becomes
 * `>= 0`. Assumes `f(0) < 0` and `f(hi) >= 0` (callers guarantee this via the
 * healthy / bad-debt short-circuits). Bisection in scaled quantity units.
 */
function firstQtyWhere(f: (q: bigint) => bigint, hi: bigint): bigint {
  let a = 0n;
  let b = hi;
  if (f(b) < 0n) return hi;
  if (f(a) >= 0n) return 0n;
  while (b - a > 1n) {
    const m = (a + b) / 2n;
    if (f(m) >= 0n) b = m;
    else a = m;
  }
  return b;
}

type FuturesAggregate = AccountSnapshot["futures"]["positions"][number];

/**
 * Expand aggregates into a unit-close sequence interleaved across expiries.
 * Each unit is one whole contract at a `expirationAt`. Groups (expiries) are
 * ordered by total unrealized loss desc; within the sequence we round-robin
 * one unit from each group until books are exhausted.
 */
function rankUnitClosesBalancedAcrossExpirations(
  positions: readonly FuturesAggregate[],
  currentPrice: bigint,
): bigint[] {
  const lossOf = (p: FuturesAggregate) => aggregateUnrealizedLoss(p, currentPrice);
  const ordered = [...positions]
    .filter((p) => p.netQuantity !== 0n)
    .sort((a, b) => {
      const la = lossOf(a);
      const lb = lossOf(b);
      if (la !== lb) return la < lb ? 1 : -1;
      const na = abs(a.netQuantity) * avgEntry(a);
      const nb = abs(b.netQuantity) * avgEntry(b);
      if (na !== nb) return na < nb ? 1 : -1;
      return a.expirationAt < b.expirationAt ? -1 : a.expirationAt > b.expirationAt ? 1 : 0;
    });

  const remaining = ordered.map((p) => abs(p.netQuantity));
  const result: bigint[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < ordered.length; i++) {
      const left = remaining[i] ?? 0n;
      if (left <= 0n) continue;
      remaining[i] = left - 1n;
      result.push(ordered[i]!.expirationAt);
      progress = true;
    }
  }
  return result;
}

function coalesceUnitPrefix(unitSequence: readonly bigint[], prefixLen: number): FuturesCloseLeg[] {
  const counts = new Map<bigint, bigint>();
  for (let i = 0; i < prefixLen && i < unitSequence.length; i++) {
    const d = unitSequence[i]!;
    counts.set(d, (counts.get(d) ?? 0n) + 1n);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([expirationAt, closeQty]) => ({ expirationAt, closeQty }));
}

/** Per-aggregate unrealized loss at `P` (token decimals); 0 when in profit. */
function aggregateUnrealizedLoss(pos: FuturesAggregate, P: bigint): bigint {
  const pnl = P * pos.netQuantity - pos.netEntryValue;
  return pnl < 0n ? -pnl : 0n;
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
