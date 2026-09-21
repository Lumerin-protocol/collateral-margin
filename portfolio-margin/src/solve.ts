import type {
  AccountSnapshot,
  AlertThresholds,
  FuturesCloseLeg,
  MarginRequirement,
  MMParams,
  PriceThresholds,
  RestingOrders,
} from "./types.ts";
import {
  futuresUnrealizedPnl,
  imRequired,
  imSurplus,
  mmRequired,
  mmSurplus,
  netDeltaWad,
  orderDeltaWad,
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
function avgEntry(pos: AccountSnapshot["futures"]["positions"][number]): bigint {
  const absNet = abs(pos.netQuantity);
  if (absNet === 0n) return 0n;
  return abs(pos.netEntryValue) / absNet;
}

/**
 * The two prices at which a venue's per-side fill loss reaches zero: the aggregate
 * breakeven `value / delta`, one per side. Below its breakeven a bid side carries a
 * loss, above it none; the ask side is the mirror. There is exactly one kink per
 * side per venue no matter how many orders rest, because both venues clamp the loss
 * per side across the whole book rather than per order.
 */
function fillLossBreakevens(orders: RestingOrders, tokenDecimals: number): bigint[] {
  const scale = 10n ** BigInt(tokenDecimals);
  const kinks: bigint[] = [];
  if (orders.buyDelta > 0n) kinks.push((orders.buyValue * scale) / orders.buyDelta);
  if (orders.sellDelta > 0n) kinks.push((orders.sellValue * scale) / orders.sellDelta);
  return kinks;
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
function futuresPnlTerms(snap: AccountSnapshot): { qty: bigint; value: bigint } {
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
    if (futuresQty !== 0n) kinks.push(...straddle(floorDiv(futuresValue, futuresQty)));
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
 * `mmRequired(P)` is piecewise-linear in P with kinks at the portfolio-wide
 * unrealized-PnL break-even (one, because MM clamps the venues' signed sum once)
 * and at each venue's per-side fill-loss breakeven. Stress is
 * `max(|netDelta + buyDelta|, |netDelta − sellDelta|) × shock × P / WAD` after
 * rescaling — strictly non-decreasing in P, and with no kink of its own, because
 * net delta and order delta are both independent of price: the two legs are lines
 * through the origin, so whichever has the larger coefficient wins at every price.
 *
 * For a typical net-long portfolio, `mmSurplus(P)` is therefore a tent shape:
 *   - Climbs as P rises (PnL recovers faster than stress grows) until the
 *     portfolio's aggregate PnL breaks even.
 *   - Above that price, only stress contributes — `mmSurplus(P)` declines
 *     linearly to negative infinity as P → ∞.
 * Net-short portfolios mirror this around an inverted apex.
 *
 * We don't try to derive a single closed form for the general piecewise
 * landscape — between leg counts, sign mixes, and stress magnitude vs.
 * leverage, the case analysis is fragile. Instead we:
 *
 *   1. Enumerate the kink prices (the MM aggregate PnL breakeven, both venues'
 *      per-side fill-loss breakevens).
 *   2. Bisect on each side of the current price (down and up) on intervals
 *      bounded by adjacent kinks. `mmSurplus(P)` is monotone within each
 *      interval, so a standard bisection converges in O(log) per interval.
 *   3. Return the closest crossings on either side of `currentPrice`.
 *
 * O(K · log(2^60)) per user where K is the number of kinks (≤ 7 — the PnL
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
  const f = (target: bigint) => (P: bigint) => imRequired(snap, params, P) - target;

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
 * the supplied `f` function crosses zero. Uses the same kink-driven
 * piecewise-monotone bisection as `solveLiquidationThresholds`, parameterised
 * so multiple solvers (liq, im-warn, im-crit) can share the engine.
 *
 * Sign-convention agnostic: detects crossings regardless of which sign
 * means "safe". Callers are responsible for short-circuiting when
 * currentPrice is already past the threshold of interest.
 *
 * `requirement` must name the requirement `f` is built on. It is not cosmetic:
 * IM and MM clamp unrealized PnL at different places, so they kink at different
 * prices, and an interval boundary set for the wrong one leaves a non-monotone
 * interval that bisection can walk straight past.
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
  kinks.push(...fillLossBreakevens(snap.perp.orders, params.tokenDecimals));
  kinks.push(...fillLossBreakevens(snap.futures.orders, params.tokenDecimals));
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
    // A settled leg realizes against its pinned price, not spot — that is the
    // mark it has been carrying since settlement, and it cannot move again.
    const mark = pos.settlementPrice !== 0n ? pos.settlementPrice : currentPrice;
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
 * band. Unit closes are ranked by their effect on the requirement (see
 * `rankUnitClosesBalancedAcrossExpirations`) and interleaved across expiries
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
  const unitSequence = rankUnitClosesBalancedAcrossExpirations(
    snap,
    params,
    currentPrice,
    liquidationFee,
  );
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
    // No early exit on `imS > 0`. Closing contracts no longer shrinks the
    // requirement monotonically: the engine stresses `netDelta − sellOrderDelta`
    // as well, and that leg *grows* as a long position closes toward flat past the
    // point where the resting asks outweigh it. So the in-band set is not a
    // contiguous prefix and the first prefix over IM is not the last one under it.
    // The worst case was already a full scan (an account that never lands in
    // band), so this costs nothing asymptotically.
  }

  if (!foundInBand) {
    // Full close every aggregate.
    return positions.map((p) => ({
      expirationAt: p.expirationAt,
      closeQty: abs(p.netQuantity),
    }));
  }
  // Emit 1-qty legs in round-robin order (not coalesced/sorted by expiry).
  // `liquidatePositions` stops once healthy; coalescing into [A:N, B:M] would
  // drain A first and skip B. Interleaved unit legs keep the prefix balanced.
  return unitSequence.slice(0, bestPrefix).map((expirationAt) => ({
    expirationAt,
    closeQty: 1n,
  }));
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
    mmSurplus(simulatePerpClose(snap, q, currentPrice, liquidationFee), params, currentPrice);
  const imS = (q: bigint) =>
    imSurplus(simulatePerpClose(snap, q, currentPrice, liquidationFee), params, currentPrice);

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
    roots.push(floorDiv(priceDiff * netQty + futuresPnl * perpQtyScale, priceDiff * sign));
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
 * Expand aggregates into a unit-close sequence interleaved across expiries.
 * Each unit is one whole contract at a `expirationAt`. Groups (expiries) are
 * ordered by how much closing one unit *drops the requirement* (desc); within the
 * sequence we round-robin one unit from each group until books are exhausted.
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
 * the netted one. Only a heuristic either way: `solveFuturesClosesToTarget` scans
 * prefixes against the real requirement, so a mis-ranking costs close depth, never
 * correctness.
 */
function rankUnitClosesBalancedAcrossExpirations(
  snap: AccountSnapshot,
  params: MMParams,
  currentPrice: bigint,
  liquidationFee: bigint,
): bigint[] {
  const positions = snap.futures.positions;
  const before = mmRequired(snap, params, currentPrice);
  const dropOf = (p: FuturesAggregate) =>
    before - mmRequired(unitClosed(snap, p, currentPrice, liquidationFee), params, currentPrice);
  const drops = new Map<bigint, bigint>();
  for (const p of positions) {
    if (p.netQuantity !== 0n) drops.set(p.expirationAt, dropOf(p));
  }
  const ordered = [...positions]
    .filter((p) => p.netQuantity !== 0n)
    .sort((a, b) => {
      const da = drops.get(a.expirationAt) ?? 0n;
      const db = drops.get(b.expirationAt) ?? 0n;
      if (da !== db) return da < db ? 1 : -1;
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
