import type {
  AccountSnapshot,
  AlertThresholds,
  FuturesCloseLeg,
  MarginRequirement,
  MMParams,
  PriceThresholds,
} from "./types.ts";
import {
  futuresUnrealizedPnl,
  imRequired,
  imSurplus,
  mmRequired,
  mmSurplus,
  netDeltaWad,
  orderDeltaWad,
  perpUnrealizedPnl,
} from "./mm.ts";

const WAD = 10n ** 18n;

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** Floor division (bigint `/` truncates toward zero, which is wrong below zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/**
 * A rational root as the pair of integers straddling it. Truncating division can
 * never land on the exact breakeven, so both sides are emitted and whichever is
 * the real turning point becomes an interval boundary; the other is a spare.
 */
function straddle(root: bigint): bigint[] {
  return [root, root + 1n];
}

/** Average entry price for an aggregate (`|netEntryValue| / |netQuantity|`). */
function avgEntry(
  pos: AccountSnapshot["futures"]["positions"][number],
): bigint {
  const absNet = abs(pos.netQuantity);
  if (absNet === 0n) return 0n;
  return abs(pos.netEntryValue) / absNet;
}

/**
 * The futures venue's PnL reduced to the affine form `P · qty − value`, which is
 * what every breakeven below is solved against.
 *
 * A settled-but-unswept expiry is pinned at its `settlementPrice`, so it drops out
 * of `qty` — it no longer moves with spot — and folds its frozen mark into `value`
 * as a constant. Leaving it in `qty` would put the breakeven at a price that does
 * not exist, since the leg cannot reach it.
 */
function futuresPnlTerms(snap: AccountSnapshot): {
  qty: bigint;
  value: bigint;
} {
  let qty = 0n;
  let value = 0n;
  for (const pos of snap.futures.positions) {
    value += pos.netEntryValue;
    if (pos.settlementPrice !== 0n) {
      value -= pos.settlementPrice * pos.netQuantity;
      continue;
    }
    qty += pos.netQuantity;
  }
  return { qty, value };
}

/**
 * Prices at which the requirement's unrealized-PnL term changes slope. The set
 * depends on which requirement is being solved, because the two clamp differently.
 *
 * IM clamps per market, so each venue contributes its own breakeven: the perp's
 * entry price, and the futures venue's *aggregate* breakeven across every expiry,
 * `Σ netEntryValue / Σ netQuantity`. One kink for the whole futures venue, not one
 * per expiry — `Futures.getRiskView` nets the expiries into a single signed number
 * before the engine clamps it. A calendar spread whose quantities cancel
 * (`Σ netQuantity == 0`) has a PnL constant in P and no kink at all.
 *
 * MM clamps the portfolio-wide sum, and that sum is a *single* affine function of
 * P, so there is exactly one kink: the price where the perp and futures PnL cancel.
 * It is generally not any leg's entry price — a perp long entered at $100 netted
 * against a futures short entered at $50 breaks even at neither. When the two
 * venues' price coefficients cancel exactly the aggregate is constant in P, and
 * again there is no kink.
 *
 * The perp leg divides by its quantity scale, so its PnL is a staircase rather
 * than a true line and the clamp can flip a step away from the rational root
 * emitted here. That displacement is bounded by one token-decimal unit of margin —
 * the same rounding slop the requirement already carries from `fromWad` — so it
 * cannot hide a crossing of any size.
 */
function unrealizedPnlBreakevens(
  snap: AccountSnapshot,
  params: MMParams,
  requirement: MarginRequirement,
): bigint[] {
  const netQty = snap.perp.netQty;
  const { qty: futuresQty, value: futuresValue } = futuresPnlTerms(snap);

  if (requirement === "im") {
    const kinks: bigint[] = [];
    if (netQty !== 0n) kinks.push(snap.perp.entryPrice);
    if (futuresQty !== 0n)
      kinks.push(...straddle(floorDiv(futuresValue, futuresQty)));
    return kinks.filter((k) => k > 0n);
  }

  // perpPnl(P) + futuresPnl(P) == 0
  //   ⇔ (P − entry)·netQty / scale + P·Σq − Σv == 0
  //   ⇔ P·(netQty + scale·Σq) == entry·netQty + scale·Σv
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  const coefficient = netQty + perpQtyScale * futuresQty;
  if (coefficient === 0n) return [];
  const intercept = snap.perp.entryPrice * netQty + perpQtyScale * futuresValue;
  return straddle(floorDiv(intercept, coefficient)).filter((k) => k > 0n);
}

/**
 * Find the price thresholds where `mmSurplus(P)` crosses zero.
 *
 * `mmRequired(P)` is convex in P. Stress is
 * `max(|netDelta + buyDelta|, |netDelta − sellDelta|) × shock × P / WAD` after
 * rescaling — linear in P, because net delta and order delta are both independent
 * of price: the two legs are lines through the origin, so whichever has the larger
 * coefficient wins at every price. The MM clamp on the portfolio-wide unrealized
 * PnL is piecewise-linear with one kink, at its break-even. Each side's fill-loss
 * bound is a smooth convex curve in the mark, with no kink at all.
 *
 * So `mmSurplus(P)` is concave, and for a typical net-long portfolio a hump:
 *   - Climbs as P rises (PnL recovers faster than stress grows) until the
 *     portfolio's aggregate PnL breaks even.
 *   - Above that price, only stress and fill loss contribute — `mmSurplus(P)`
 *     declines to negative infinity as P → ∞.
 * Net-short portfolios mirror this.
 *
 * We don't try to derive a closed form — between leg counts, sign mixes, and
 * stress magnitude vs. leverage, the case analysis is fragile. Instead we:
 *
 *   1. Enumerate the kink prices (the MM aggregate PnL breakeven).
 *   2. Bisect on each side of the current price (down and up) on intervals
 *      bounded by adjacent kinks. Concavity leaves at most one crossing per
 *      interval with a sign change, and none in an interval without one (the
 *      healthy set is a single interval containing `currentPrice`, which is
 *      itself a boundary), so a standard bisection converges in O(log) each.
 *   3. Return the closest crossings on either side of `currentPrice`.
 *
 * Integer rounding (`fromWad`, the bound's rounded-up square root) makes the
 * function concave only to within a few token units, which is the same slop the
 * requirement already carries; it cannot hide a crossing of any size.
 *
 * O(K · log(2^60)) per user where K is the number of kinks (≤ 4 — the PnL
 * breakeven no longer scales with the number of futures expiries, since the venue
 * nets them into one). At keeper scale this is a handful of µs of pure CPU work —
 * negligible vs the RPC the snapshot read already cost.
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
  const result = findClosestCrossings(
    snap,
    params,
    currentPrice,
    (P) => mmSurplus(snap, params, P),
    "mm",
  );
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
  const f = (target: bigint) => (P: bigint) =>
    imRequired(snap, params, P) - target;

  // For an alert level we want price points where `imRequired(P) = target`.
  // Already at-or-over the target at currentPrice → that level isn't a
  // forward-looking trigger; the sweep alert path will fire it.
  const warn =
    imRequired(snap, params, currentPrice) >= warnTarget
      ? { down: undefined, up: undefined }
      : findClosestCrossings(snap, params, currentPrice, f(warnTarget), "im");
  const crit =
    imRequired(snap, params, currentPrice) >= critTarget
      ? { down: undefined, up: undefined }
      : findClosestCrossings(snap, params, currentPrice, f(critTarget), "im");
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
 * the supplied `f` function crosses zero. Uses the same kink-bounded
 * bisection as `solveLiquidationThresholds`, parameterised so multiple solvers
 * (liq, im-warn, im-crit) can share the engine. `f` must be concave or convex
 * between kinks, as every requirement-based function here is.
 *
 * Sign-convention agnostic: detects crossings regardless of which sign
 * means "safe". Callers are responsible for short-circuiting when
 * currentPrice is already past the threshold of interest.
 *
 * `requirement` must name the requirement `f` is built on. It is not cosmetic:
 * IM and MM clamp unrealized PnL at different places, so they kink at different
 * prices, and an interval boundary set for the wrong one leaves an interval
 * with two crossings that bisection can walk straight past.
 */
function findClosestCrossings(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  f: (P: bigint) => bigint,
  requirement: MarginRequirement,
): { down: bigint | undefined; up: bigint | undefined } {
  const kinks: bigint[] = [];
  kinks.push(...unrealizedPnlBreakevens(snap, params, requirement));
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
// closeQty)` (perps) treat the keeper-supplied amount as an upper bound and
// revert `OverLiquidation` when a partial leaves balance above IM with a real
// IM buffer (`im > mm`). These solvers pick, off-chain, the deepest close that
// keeps the account inside the `[MM, IM]` band (healthy but not
// over-liquidated). If no in-band partial exists (deep crash / bad debt) they
// fall back to a full close, which the contract lets through (the guard is
// skipped once no positions remain).
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
    closeByExpiry.set(
      c.expirationAt,
      (closeByExpiry.get(c.expirationAt) ?? 0n) + c.closeQty,
    );
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
    // A settled leg realizes against its pinned price, not spot — that is the
    // mark it has been carrying since settlement, and it cannot move again.
    const mark =
      pos.settlementPrice !== 0n ? pos.settlementPrice : currentPrice;
    const pnl = (mark - entry) * signedClose;
    balanceDelta += pnl - liquidationFee;

    if (closeAbs >= absNet) continue;
    const newAbs = absNet - closeAbs;
    remaining.push({
      expirationAt: pos.expirationAt,
      netQuantity: pos.netQuantity > 0n ? newAbs : -newAbs,
      netEntryValue: (pos.netEntryValue * newAbs) / absNet,
      settlementPrice: pos.settlementPrice,
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
  // matches `perpUnrealizedPnl` in mm.ts and the venue's QUANTITY_SCALE.
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
 * band. Closes follow a round-robin path: one contract from each expiry per
 * round, expiries ranked by their effect on the requirement (see
 * `rankExpiriesForClose`), so a prefix does not drain one book before touching
 * another. With a real IM buffer the target is the deepest in-band prefix of that
 * path, otherwise the shallowest healthy one.
 *
 * The cost does not depend on the number of contracts: the path is never
 * expanded unit by unit (see `searchClosePath`), and the legs carry many
 * contracts each (see `stagedLegs`), so one `liquidatePositions` call can close
 * the whole amount.
 *
 * Aggregates expiring at or before `now` (unix seconds) are left alone, as the
 * venue skips matured legs; they still count toward the requirement. Returns `[]`
 * if already healthy or nothing is closable, or a full close of every closable
 * aggregate when no in-band partial exists (deep crash / bad debt).
 */
export function solveFuturesClosesToTarget(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
  now?: bigint,
): FuturesCloseLeg[] {
  if (snap.futures.positions.length === 0) return [];
  if (mmSurplus(snap, params, currentPrice) >= 0n) return [];

  const ordered = rankExpiriesForClose(
    snap,
    params,
    currentPrice,
    liquidationFee,
    now,
  );
  if (ordered.length === 0) return [];

  const path = closePath(ordered);
  const stateAt = (k: bigint) =>
    simulateFuturesClose(
      snap,
      path.legsBetween(0n, k),
      currentPrice,
      liquidationFee,
    );
  const hasBuffer = params.imSpotShock > params.mmSpotShock;
  const target = searchClosePath(
    path,
    stateAt,
    params,
    currentPrice,
    hasBuffer,
  );
  if (target === undefined) {
    return ordered.map((p) => ({
      expirationAt: p.expirationAt,
      closeQty: abs(p.netQuantity),
    }));
  }
  return stagedLegs(snap, path, target, params, currentPrice, liquidationFee);
}

/**
 * The round-robin close path over the ranked aggregates, in closed form. Prefix
 * `k` closes `min(size, r)` from every expiry after `r` full rounds, plus one more
 * from each of the first `k − T(r)` expiries still open, in rank order, where
 * `T(r) = Σ min(size, r)` is the largest round total not above `k`.
 *
 * `segments` cuts the path where an expiry runs out: inside a segment every round
 * closes one contract from each of the same `width` expiries.
 */
interface ClosePath {
  segments: { start: bigint; rounds: bigint; width: bigint }[];
  /** The closes taking prefix `from` to prefix `to`, one leg per expiry touched, in rank order. */
  legsBetween(from: bigint, to: bigint): FuturesCloseLeg[];
}

function closePath(ordered: readonly FuturesAggregate[]): ClosePath {
  const sizes = ordered.map((p) => abs(p.netQuantity));
  const roundTotal = (r: bigint) =>
    sizes.reduce((s, a) => s + (a < r ? a : r), 0n);
  const maxSize = sizes.reduce((m, a) => (a > m ? a : m), 0n);

  const countsAt = (k: bigint): bigint[] => {
    let lo = 0n;
    let hi = maxSize;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (roundTotal(mid) <= k) lo = mid;
      else hi = mid - 1n;
    }
    let extra = k - roundTotal(lo);
    return sizes.map((a) => {
      if (a <= lo) return a;
      if (extra <= 0n) return lo;
      extra -= 1n;
      return lo + 1n;
    });
  };

  const segments: ClosePath["segments"] = [];
  let prev = 0n;
  for (const r of [...new Set(sizes)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const width = BigInt(sizes.filter((a) => a >= r).length);
    segments.push({ start: roundTotal(prev), rounds: r - prev, width });
    prev = r;
  }

  return {
    segments,
    legsBetween(from, to) {
      const a = countsAt(from);
      const b = countsAt(to);
      const legs: FuturesCloseLeg[] = [];
      for (const [i, pos] of ordered.entries()) {
        const closeQty = (b[i] ?? 0n) - (a[i] ?? 0n);
        if (closeQty > 0n)
          legs.push({ expirationAt: pos.expirationAt, closeQty });
      }
      return legs;
    },
  };
}

/**
 * The target prefix of the close path: the deepest in-band one with a real IM
 * buffer, the shallowest healthy one without, `undefined` if there is none.
 *
 * The surplus along the path is not monotone. The engine stresses
 * `netDelta − sellOrderDelta` as well, and that leg grows as a long closes toward
 * flat past the point where resting asks outweigh it; mixed-sign books move net
 * delta away from zero for a while. So the in-band set is not a contiguous prefix.
 * But within one segment, the prefixes at a fixed offset `j` into the round are
 * `start + j + width·u`, and along `u` every input to the requirement is affine:
 * net delta, the unrealized PnL of what is left, the realized PnL credited to the
 * balance. The requirement is then piecewise-linear in `u`, with kinks only where
 * a clamp turns over (`closePathKinks`), and each piece is bisected like the perps
 * solver does. That is O(expiries² · log contracts) evaluations, whatever the size.
 */
function searchClosePath(
  path: ClosePath,
  stateAt: (k: bigint) => AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  hasBuffer: boolean,
): bigint | undefined {
  const mmS = (s: AccountSnapshot) => mmSurplus(s, params, currentPrice);
  const imS = (s: AccountSnapshot) => imSurplus(s, params, currentPrice);
  let deepest: bigint | undefined;
  for (const seg of path.segments) {
    let shallowest: bigint | undefined;
    for (let j = 0n; j < seg.width; j++) {
      const kOf = (u: bigint) => seg.start + j + seg.width * u;
      const at = (u: bigint) => stateAt(kOf(u));
      const last = j === 0n ? seg.rounds : seg.rounds - 1n;
      const bounds = closePathKinks(at, last, params, currentPrice);
      for (let i = 0; i + 1 < bounds.length; i++) {
        const healthy = nonNegativeRange(bounds[i], bounds[i + 1], (u) =>
          mmS(at(u)),
        );
        if (healthy === undefined) continue;
        if (!hasBuffer) {
          const k = kOf(healthy.lo);
          if (shallowest === undefined || k < shallowest) shallowest = k;
          break;
        }
        const underIM = nonNegativeRange(
          healthy.lo,
          healthy.hi,
          (u) => -imS(at(u)),
        );
        if (underIM === undefined) continue;
        const k = kOf(underIM.hi);
        const s = stateAt(k);
        if (
          mmS(s) >= 0n &&
          imS(s) <= 0n &&
          (deepest === undefined || k > deepest)
        )
          deepest = k;
      }
    }
    if (shallowest !== undefined) return shallowest;
  }
  return deepest;
}

/**
 * Interval bounds over `u ∈ [0, last]` for `searchClosePath`: the ends, `u = 1`
 * (the first close of an expiry can carry a flat fee), and every root of the
 * requirement's clamps. Net delta and both PnL sums are affine in `u`, so each
 * root is read off the line through the ends:
 *
 *   - stress `max(|netDelta + buy|, |netDelta − sell|)` turns at `netDelta = −buy`,
 *     at `netDelta = sell`, and where the legs swap, `netDelta = (sell − buy) / 2`;
 *   - the MM clamp turns where the portfolio's unrealized PnL crosses zero, the IM
 *     clamp where the futures venue's does (the perp is not touched).
 *
 * The remaining entry value is truncated per close, so the PnL lines are exact
 * only to a token unit; each root is emitted with its neighbours.
 */
function closePathKinks(
  at: (u: bigint) => AccountSnapshot,
  last: bigint,
  params: MMParams,
  currentPrice: bigint,
): bigint[] {
  const bounds = new Set<bigint>([0n, last]);
  if (last > 1n) {
    bounds.add(1n);
    const first = at(0n);
    const end = at(last);
    const order = orderDeltaWad(first, params);
    const lines: [bigint, bigint, bigint[]][] = [
      [
        netDeltaWad(first, params),
        netDeltaWad(end, params),
        [-order.buy, order.sell, (order.sell - order.buy) / 2n],
      ],
      [
        perpUnrealizedPnl(first, params, currentPrice) +
          futuresUnrealizedPnl(first, currentPrice),
        perpUnrealizedPnl(end, params, currentPrice) +
          futuresUnrealizedPnl(end, currentPrice),
        [0n],
      ],
      [
        futuresUnrealizedPnl(first, currentPrice),
        futuresUnrealizedPnl(end, currentPrice),
        [0n],
      ],
    ];
    for (const [f0, f1, targets] of lines) {
      if (f0 === f1) continue;
      for (const target of targets) {
        const root = floorDiv((target - f0) * last, f1 - f0);
        for (const u of [root - 1n, root, root + 1n, root + 2n]) {
          if (u > 0n && u < last) bounds.add(u);
        }
      }
    }
  }
  return [...bounds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const MAX_STAGE_SPLITS = 64;

/**
 * Legs from the empty prefix to `target`, safe to run as one `liquidatePositions`
 * call. The venue runs legs in order, stops before a leg once the account is
 * healthy, and reverts `OverLiquidation` if a close leaves the balance above IM.
 * Starting from one stage (a single leg per expiry), any stage holding a leg that
 * would overshoot IM is split at its midpoint prefix. Stage ends are path prefixes
 * before the first healthy one, so every leg starts underwater; at worst the split
 * reaches single contracts, which is the round-robin path itself.
 */
function stagedLegs(
  snap: AccountSnapshot,
  path: ClosePath,
  target: bigint,
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
): FuturesCloseLeg[] {
  const cuts = [0n, target];
  for (let split = 0; ; split++) {
    const legs: FuturesCloseLeg[] = [];
    const stageOf: number[] = [];
    for (let s = 0; s + 1 < cuts.length; s++) {
      for (const leg of path.legsBetween(cuts[s] ?? 0n, cuts[s + 1] ?? 0n)) {
        legs.push(leg);
        stageOf.push(s);
      }
    }
    const bad = overLiquidatingLeg(
      snap,
      legs,
      params,
      currentPrice,
      liquidationFee,
    );
    if (bad === undefined || split === MAX_STAGE_SPLITS) return legs;
    const s = stageOf[bad] ?? 0;
    const lo = cuts[s] ?? 0n;
    const hi = cuts[s + 1] ?? 0n;
    if (hi - lo <= 1n) return legs;
    cuts.splice(s + 1, 0, (lo + hi) / 2n);
  }
}

/** Index of the first leg `liquidatePositions` would revert `OverLiquidation` on, if any. */
function overLiquidatingLeg(
  snap: AccountSnapshot,
  legs: readonly FuturesCloseLeg[],
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
): number | undefined {
  let state = snap;
  for (const [i, leg] of legs.entries()) {
    if (mmSurplus(state, params, currentPrice) >= 0n) return undefined;
    state = simulateFuturesClose(state, [leg], currentPrice, liquidationFee);
    const im = imRequired(state, params, currentPrice);
    if (im > mmRequired(state, params, currentPrice) && state.balance > im)
      return i;
  }
  return undefined;
}

/**
 * Pick the absolute `closeQty` (scaled by perp quantity decimals) to partially
 * close a perps position down into the `[MM, IM]` band. With a real IM buffer we
 * take the deepest close that stays at/under IM (which is automatically ≥ the
 * minimal-healthy amount); degenerate `IM == MM` targets minimal-healthy. Returns
 * `0n` if already healthy, or `|netQty|` (full close) when even closing everything
 * can't reach the band (deep crash / bad debt).
 *
 * This used to bisect `[0, |netQty|]` in one shot on the premise that both surpluses
 * are monotone increasing in the closed quantity. That premise is gone. The engine
 * now stresses `netDelta − sellOrderDelta` alongside `netDelta + buyOrderDelta`, and
 * closing a long drives net delta toward zero — which *increases* `|netDelta − sell|`
 * once the resting asks outweigh what is left of the position. Perps orders must be
 * cleared before `liquidatePosition` (the venue reverts `OrdersStillOpen`), but the
 * order delta the engine sees is portfolio-wide, so a user's resting *futures* book
 * still feeds these legs while their perp is being closed.
 *
 * What survives is weaker but enough: the requirement is piecewise-linear in the
 * closed quantity, with kinks only where a stress leg's delta crosses zero, where
 * the two legs swap places, or where the MM clamp on the portfolio's aggregate PnL
 * turns over. `perpCloseKinks` enumerates those points, and we bisect within each
 * resulting interval, where linearity restores monotonicity.
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
    mmSurplus(
      simulatePerpClose(snap, q, currentPrice, liquidationFee),
      params,
      currentPrice,
    );
  const imS = (q: bigint) =>
    imSurplus(
      simulatePerpClose(snap, q, currentPrice, liquidationFee),
      params,
      currentPrice,
    );

  const hasBuffer = params.imSpotShock > params.mmSpotShock;
  const bounds = perpCloseKinks(snap, params, absNet, currentPrice);

  let best: bigint | undefined;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const healthy = nonNegativeRange(bounds[i], bounds[i + 1], mmS);
    if (healthy === undefined) continue;

    if (!hasBuffer) {
      // Degenerate IM == MM: the shallowest healthy close is the answer, and the
      // intervals are walked in increasing quantity, so the first one wins.
      return healthy.lo >= absNet ? absNet : healthy.lo;
    }

    const underIM = nonNegativeRange(healthy.lo, healthy.hi, (q) => -imS(q));
    if (underIM === undefined) continue;
    if (best === undefined || underIM.hi > best) best = underIM.hi;
  }

  if (best === undefined) return absNet;
  return best >= absNet ? absNet : best;
}

/**
 * Closed quantities at which the margin requirement stops being linear, so that
 * each `[bounds[i], bounds[i+1]]` interval is safe to bisect. Closing changes net
 * delta affinely, `netDelta(q) = netDelta(0) − sign(netQty) · q · WAD / qtyScale`, and
 * everything else in the requirement is either affine in `q` (both venues' signed
 * PnL, the realized PnL credited to the balance) or untouched by the close (fill
 * loss, funding). The kinks are therefore the points where one of the requirement's
 * two clamps turns over:
 *
 *   - The stress term `max(|netDelta + buy|, |netDelta − sell|)`: the two absolute
 *     values turn at `netDelta = −buy` and `netDelta = sell`, and the outer `max`
 *     switches legs where they meet, at `netDelta = (sell − buy) / 2`.
 *   - The MM clamp on the portfolio-wide unrealized PnL, `max(0, −(perpPnl(q) + F))`
 *     with `F` the futures venue's PnL (constant in `q` — a perp close does not
 *     touch it).
 *
 * That second family is new, and it is the one the per-market clamp let us skip.
 * The old argument was that closing moves a position toward zero without crossing
 * it, so `perpPnl` keeps its sign and its clamp never turns. That still holds for
 * IM, which clamps the perp's PnL on its own — the IM path contributes no kink here.
 * It fails for MM, which clamps the *sum*: with futures carrying a constant +$100
 * and the perp −$150, the total is −$50 at `q = 0` and +$100 at a full close, so it
 * crosses zero partway through and the clamp turns with it. Solving
 * `perpPnl(q) + F = 0` for `q`, where `perpPnl(q) = (P − entry)(netQty − sign·q) / scale`:
 *
 *   q = ((P − entry)·netQty + F·scale) / ((P − entry)·sign)
 *
 * undefined (and irrelevant) at `P == entry`, where the perp carries no PnL at any
 * `q` and the term is the constant `max(0, −F)`.
 *
 * Each root is emitted as both its floor and floor+1 because integer division
 * truncates and the true root lies in between.
 */
function perpCloseKinks(
  snap: AccountSnapshot,
  params: MMParams,
  absNet: bigint,
  currentPrice: bigint,
): bigint[] {
  const netQty = snap.perp.netQty;
  const sign = netQty > 0n ? 1n : -1n;
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  const perUnit = WAD / perpQtyScale;
  const delta0 = netDeltaWad(snap, params);
  const order = orderDeltaWad(snap, params);
  const qtyAtDelta = (target: bigint) => (sign * (delta0 - target)) / perUnit;

  const roots = [
    qtyAtDelta(-order.buy),
    qtyAtDelta(order.sell),
    qtyAtDelta((order.sell - order.buy) / 2n),
  ];

  const priceDiff = currentPrice - snap.perp.entryPrice;
  if (priceDiff !== 0n) {
    const futuresPnl = futuresUnrealizedPnl(snap, currentPrice);
    roots.push(
      floorDiv(
        priceDiff * netQty + futuresPnl * perpQtyScale,
        priceDiff * sign,
      ),
    );
  }

  const bounds = new Set<bigint>([0n, absNet]);
  for (const root of roots) {
    for (const q of straddle(root)) {
      if (q > 0n && q < absNet) bounds.add(q);
    }
  }
  return [...bounds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The sub-range of `[lo, hi]` on which `f(q) >= 0`, or `undefined` if nowhere.
 * Requires `f` to be monotone on `[lo, hi]` — callers get that from
 * `perpCloseKinks`, which cuts the domain at every point where linearity breaks.
 * The direction is read off the endpoints rather than assumed, so the same
 * bisection serves both the increasing MM-surplus and the decreasing IM-surplus
 * side of the band.
 */
function nonNegativeRange(
  lo: bigint,
  hi: bigint,
  f: (q: bigint) => bigint,
): { lo: bigint; hi: bigint } | undefined {
  const atLo = f(lo);
  const atHi = f(hi);
  if (atLo >= 0n && atHi >= 0n) return { lo, hi };
  if (atLo < 0n && atHi < 0n) return undefined;

  let a = lo;
  let b = hi;
  if (atLo < 0n) {
    while (b - a > 1n) {
      const m = (a + b) / 2n;
      if (f(m) >= 0n) b = m;
      else a = m;
    }
    return { lo: b, hi };
  }
  while (b - a > 1n) {
    const m = (a + b) / 2n;
    if (f(m) >= 0n) a = m;
    else b = m;
  }
  return { lo, hi: a };
}

type FuturesAggregate = AccountSnapshot["futures"]["positions"][number];

/**
 * The closable aggregates (non-zero, expiring after `now` when given) in close-path
 * order: by how much closing one contract *drops the requirement* (desc).
 *
 * This used to rank by the aggregate's standalone unrealized loss, on the reading
 * that the biggest loser frees the most margin. Netting retires that: the engine
 * charges MM on the portfolio-wide signed PnL, so an aggregate's own loss says
 * nothing about the requirement until you know what the rest of the portfolio does
 * with it. A profitable aggregate now ranks *below* a flat one, because closing it
 * strips an offset the losing legs were leaning on and the requirement goes up.
 * Measuring the drop directly keeps the rationale from rotting again — whatever
 * the engine's PnL term does, this ranks by its response.
 *
 * MM (not IM) because MM is the constraint the close is trying to clear, and it is
 * the netted one. Only a heuristic either way: `solveFuturesClosesToTarget` checks
 * prefixes against the real requirement, so a mis-ranking costs close depth, never
 * correctness.
 */
function rankExpiriesForClose(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
  now: bigint | undefined,
): FuturesAggregate[] {
  const closable = snap.futures.positions.filter(
    (p) => p.netQuantity !== 0n && (now === undefined || p.expirationAt > now),
  );
  const before = mmRequired(snap, params, currentPrice);
  const dropOf = (p: FuturesAggregate) =>
    before -
    mmRequired(
      unitClosed(snap, p, currentPrice, liquidationFee),
      params,
      currentPrice,
    );
  const drops = new Map<bigint, bigint>();
  for (const p of closable) drops.set(p.expirationAt, dropOf(p));
  return closable.sort((a, b) => {
    const da = drops.get(a.expirationAt) ?? 0n;
    const db = drops.get(b.expirationAt) ?? 0n;
    if (da !== db) return da < db ? 1 : -1;
    const na = abs(a.netQuantity) * avgEntry(a);
    const nb = abs(b.netQuantity) * avgEntry(b);
    if (na !== nb) return na < nb ? 1 : -1;
    return a.expirationAt < b.expirationAt
      ? -1
      : a.expirationAt > b.expirationAt
        ? 1
        : 0;
  });
}

/** The snapshot after closing one contract of `pos` at `P`. */
function unitClosed(
  snap: AccountSnapshot,
  pos: FuturesAggregate,
  P: bigint,
  liquidationFee: bigint,
): AccountSnapshot {
  return simulateFuturesClose(
    snap,
    [{ expirationAt: pos.expirationAt, closeQty: 1n }],
    P,
    liquidationFee,
  );
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

function registerCrossing(
  at: bigint,
  currentPrice: bigint,
  sink: (down: boolean) => void,
): void {
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
