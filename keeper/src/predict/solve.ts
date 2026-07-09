import type { Hex } from "viem";
import type { AccountSnapshot, AlertThresholds, MMParams, PriceThresholds } from "./types.ts";
import { imRequired, imSurplus, mmSurplus } from "./mm.ts";

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

// ───────────────────────────────────────────────────────────────────────────
// Close-to-IM-buffer sizing (the batched-liquidation solvers)
//
// The on-chain `liquidatePositions` (futures) / `liquidatePosition(user,
// closeQty)` (perps) do NOT recompute margin per lot — they close the
// keeper-supplied amount and enforce a single end-of-tx `OverLiquidation`
// guard: with positions remaining and a real IM buffer (`im > mm`), the
// leftover balance must sit at/under IM. These solvers pick, off-chain, the
// deepest close that keeps the account inside the `[MM, IM]` band (healthy but
// not over-liquidated) — so one batched tx replaces the old one-lot-per-tx
// churn. If no in-band partial exists (deep crash / bad debt) they fall back
// to a full close, which the contract lets through (the guard is skipped once
// no positions remain).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Off-chain replica of the futures batch close: remove `closeIds` from the
 * snapshot and debit the realized PnL + flat fee of each closed lot from the
 * balance. Mirrors `Futures._forceLiquidatePosition` (loss/profit routed
 * through the insurance fund) + the per-lot `liquidationFee`. Entry prices of
 * the surviving lots are untouched. Shared by the solver and its tests so the
 * band predicate they assert is the exact one the solver optimises against.
 */
export function simulateFuturesClose(
  snap: AccountSnapshot,
  closeIds: readonly Hex[],
  currentPrice: bigint,
  liquidationFee: bigint,
): AccountSnapshot {
  const closeSet = new Set(closeIds);
  const remaining: AccountSnapshot["futures"]["positions"] = [];
  let balanceDelta = 0n;
  for (const pos of snap.futures.positions) {
    if (!closeSet.has(pos.id)) {
      remaining.push(pos);
      continue;
    }
    const diffPerDay = pos.isBuyer
      ? currentPrice - pos.entryPricePerDay
      : pos.entryPricePerDay - currentPrice;
    const pnl = diffPerDay;
    balanceDelta += pnl - liquidationFee;
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
 * Pick the worst-first subset of futures lot ids to close so the account lands
 * inside the `[MM, IM]` band. Lots are ranked by unrealized loss (desc), then
 * notional (desc). We add lots one at a time (simulating each removal) and keep
 * the DEEPEST prefix that is healthy at MM while staying at/under IM. When a
 * real IM buffer exists (`imSpotShock > mmSpotShock`), closing past the IM
 * crossing would trip `OverLiquidation`, so we stop there. In the degenerate
 * `IM == MM` case there is no upper bound — we take the minimal healthy prefix.
 * Returns `[]` if already healthy, or every id (full close) when no in-band
 * partial exists (deep crash / bad debt — the contract skips the guard once
 * the position set is empty).
 */
export function solveFuturesLotsToTarget(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
): Hex[] {
  const positions = snap.futures.positions;
  if (positions.length === 0) return [];
  if (mmSurplus(snap, params, currentPrice) >= 0n) return [];

  const hasBuffer = params.imSpotShock > params.mmSpotShock;

  // Expiry-balanced worst-first ordering. Each `deliveryAt` is a separate
  // market/order-book, so we interleave closures across expirations (round
  // robin, worst-first within each) instead of a single global worst-first
  // prefix that would drain one expiry's book before touching another. The
  // batch is still submitted in one `liquidatePositions` tx; balancing only
  // shapes WHICH lots that tx closes. The prefix search below is unchanged, so
  // we still stop at the deepest in-band subset (reaching IM stays the
  // priority — balance is best-effort within that).
  const ranked = rankLotsBalancedAcrossExpirations(positions, currentPrice);

  const n = ranked.length;
  let best: Hex[] | undefined;
  for (let k = 1; k < n; k++) {
    const closeSet = ranked.slice(0, k).map((p) => p.id);
    const after = simulateFuturesClose(snap, closeSet, currentPrice, liquidationFee);
    const mmS = mmSurplus(after, params, currentPrice);
    const imS = imSurplus(after, params, currentPrice);
    if (!hasBuffer) {
      // Degenerate IM == MM: no over-liquidation ceiling. Take minimal healthy.
      if (mmS >= 0n) {
        best = closeSet;
        break;
      }
      continue;
    }
    if (mmS >= 0n && imS <= 0n) best = closeSet; // in band — record and keep going deeper
    if (imS > 0n) break; // deeper only raises IM surplus → would over-liquidate
  }

  if (best !== undefined) return best;
  // No in-band partial — close everything (bad-debt / full-deleverage path).
  return ranked.map((p) => p.id);
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

type FuturesLot = AccountSnapshot["futures"]["positions"][number];

/**
 * Order futures lots so a worst-first prefix is *balanced across expirations*.
 *
 * Lots are grouped by `deliveryAt` (each group = one market). Within a group
 * they are sorted worst-first (unrealized loss desc, then notional desc, then
 * id for determinism). Groups are then round-robin interleaved — round `r`
 * takes the r-th lot of every group that still has one — with groups visited
 * worst-first (group total loss desc, tiebreak `deliveryAt` asc).
 *
 * The effect: any prefix of the result draws from every expiry evenly until a
 * book is exhausted, so the deepest in-band prefix spreads the close rather
 * than emptying a single expiry's book. A single-expiry portfolio collapses to
 * plain worst-first (identical to the pre-balancing behaviour).
 */
function rankLotsBalancedAcrossExpirations(
  positions: readonly FuturesLot[],
  currentPrice: bigint,
): FuturesLot[] {
  const lossOf = (p: FuturesLot) => lotUnrealizedLoss(p, currentPrice);
  const notionalOf = (p: FuturesLot) => p.entryPricePerDay;

  const groups = new Map<bigint, FuturesLot[]>();
  for (const p of positions) {
    const bucket = groups.get(p.deliveryAt);
    if (bucket === undefined) groups.set(p.deliveryAt, [p]);
    else bucket.push(p);
  }

  const worstFirst = (a: FuturesLot, b: FuturesLot): number => {
    const la = lossOf(a);
    const lb = lossOf(b);
    if (la !== lb) return la < lb ? 1 : -1;
    const na = notionalOf(a);
    const nb = notionalOf(b);
    if (na !== nb) return na < nb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  for (const bucket of groups.values()) bucket.sort(worstFirst);

  const orderedGroups = [...groups.entries()]
    .sort(([dateA, groupA], [dateB, groupB]) => {
      const lossA = groupA.reduce((s, p) => s + lossOf(p), 0n);
      const lossB = groupB.reduce((s, p) => s + lossOf(p), 0n);
      if (lossA !== lossB) return lossA < lossB ? 1 : -1;
      return dateA < dateB ? -1 : dateA > dateB ? 1 : 0;
    })
    .map(([, group]) => group);

  const result: FuturesLot[] = [];
  let maxLen = 0;
  for (const group of orderedGroups) if (group.length > maxLen) maxLen = group.length;
  for (let round = 0; round < maxLen; round++) {
    for (const group of orderedGroups) {
      const lot = group[round];
      if (lot !== undefined) result.push(lot);
    }
  }
  return result;
}

/** Per-lot unrealized loss at `P` (token decimals); 0 when in profit. */
function lotUnrealizedLoss(
  pos: AccountSnapshot["futures"]["positions"][number],
  P: bigint,
): bigint {
  const diffPerDay = pos.isBuyer ? P - pos.entryPricePerDay : pos.entryPricePerDay - P;
  const pnl = diffPerDay;
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
