import type { AccountSnapshot, MarginRequirement, MMParams, RestingOrders } from "./types.ts";

/**
 * Off-chain replica of `PortfolioMarginEngine._computeMargin`, restricted to
 * the pure-delta case (no options Greeks). The contract's stress engine is:
 *
 *   netDelta = perpDelta + futuresDelta
 *            = (perpNetQty * WAD / 10^perpQtyDecimals) + getNetPositionDelta()
 *
 *   stressLossWad = max over 4 (±spotShock, ±volShock) scenarios of
 *                   max(0, -(netDelta * deltaS / WAD + ½γ(deltaS)² + ν * deltaVol))
 *
 * For our pure-delta portfolios (γ=ν=0), the worst scenario is the one where
 * `deltaS` opposes `netDelta`, giving `|netDelta| * spotShock * P / WAD²`
 * in WAD. We then rescale to token decimals exactly the way `_fromWad` does.
 *
 * Resting orders are not a separate margin term any more. The engine runs that
 * stress twice — once at `netDelta + buyOrderDelta`, once at
 * `netDelta − sellOrderDelta` — and keeps the worse leg, which upper-bounds the
 * requirement after any subset of the account's orders fills. So the stress term
 * here is `max(|netDelta + buyDelta|, |netDelta − sellDelta|) × shock × P`, and the
 * add-ons are:
 *
 *   - fillLoss(P) = max(0, buyValue − buyMark(P)) + max(0, sellMark(P) − sellValue),
 *     charged in both legs
 *   - the unrealized-PnL term, the one place the two requirements differ in
 *     *shape* rather than just in shock:
 *
 *       IM: max(0, −perpPnl(P)) + max(0, −futuresPnl(P))
 *       MM: max(0, −(perpPnl(P) + futuresPnl(P)))
 *
 *     with one signed PnL per *venue* — `futuresPnl` already netted across every
 *     expiry, because that is the single number `Futures.getRiskView` hands the
 *     engine. IM clamps the two venues separately and so ignores gains entirely;
 *     MM clamps their sum once, so a gain at one venue offsets a loss at the other.
 *   - perp.fundingOwed (constant — short-term, refreshed on snapshot)
 *
 * Every term is piecewise-linear in P. The unrealized-PnL kinks differ per
 * requirement: on the IM path, one venue-aggregate breakeven each (the perp's
 * entry price, and the futures venue's netted breakeven across all expiries); on
 * the MM path a single portfolio-wide breakeven, which is generally not any leg's
 * entry price. Two further families come from the order terms: each side's
 * aggregate fill-loss breakeven (`value / delta`, one per side per venue) and each
 * stress leg's own delta zero, where `|netDelta ± orderDelta|` turns around.
 * `solve.ts` enumerates all of them. We deliberately keep the math straight (no
 * over-engineered piecewise representation) — `mmRequired` is cheap, the solver
 * bisects within a kink interval, and the closed-form solver invokes this to
 * verify its candidate roots.
 *
 * All bigint arithmetic. Token-decimal rounding matches PME's integer division.
 */

const WAD = 10n ** 18n;

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Net delta of *positions only*, in WAD (matches `_linearAggregate`'s
 * `netPositionDelta` sum for pure-delta portfolios).
 *
 *   perpDelta = perpNetQty * WAD / 10^perpQtyDecimals
 *   futuresDelta = sum_i netQuantity_i * WAD   over *unsettled* expiries only
 *
 * Settled-but-unswept expiries are skipped, matching `Futures.getRiskView`, which
 * folds an expiry into `netPositionDelta` only while `settlementPrice` is still
 * zero. Once the price is pinned the leg cannot move with spot, so stressing it
 * would charge for risk that no longer exists.
 *
 * Note: the on-chain `getNetPositionDelta` already returns this sum for the
 * futures leg; we re-derive it here off-chain because the snapshot carries
 * per-expiry aggregates (needed by the per-expiry close solver) and re-using them
 * avoids a second contract call. Both paths converge on the same value.
 */
export function netDeltaWad(snap: AccountSnapshot, params: MMParams): bigint {
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  let delta = (snap.perp.netQty * WAD) / perpQtyScale;
  for (const pos of snap.futures.positions) {
    if (pos.settlementPrice !== 0n) continue;
    delta += pos.netQuantity * WAD;
  }
  return delta;
}

/**
 * Order delta per side summed across venues, lifted to WAD. Venues report these
 * scaled by `10^tokenDecimals`, the same convention as `netPositionDelta`.
 */
export function orderDeltaWad(snap: AccountSnapshot, params: MMParams): {
  buy: bigint;
  sell: bigint;
} {
  const lift = 10n ** BigInt(18 - params.tokenDecimals);
  return {
    buy: (snap.perp.orders.buyDelta + snap.futures.orders.buyDelta) * lift,
    sell: (snap.perp.orders.sellDelta + snap.futures.orders.sellDelta) * lift,
  };
}

/**
 * Scale a WAD-denominated value down to token decimals using PME's exact
 * convention (integer division by `10^(18 - tokenDecimals)`).
 */
function fromWad(wadValue: bigint, tokenDecimals: number): bigint {
  return wadValue / 10n ** BigInt(18 - tokenDecimals);
}

/**
 * Stress loss in token decimals. Pure-delta worst case:
 *
 *   |delta| * shock * P_wad / WAD²    (in WAD)
 *
 * where P_wad = P_token * 10^(18 - tokenDecimals).
 *
 * Equivalent to the on-chain 4-scenario max in the absence of γ and ν.
 */
export function stressLoss(
  delta: bigint,
  shock: bigint,
  P: bigint,
  tokenDecimals: number,
): bigint {
  const Pwad = P * 10n ** BigInt(18 - tokenDecimals);
  const stressWad = (abs(delta) * shock * Pwad) / (WAD * WAD);
  return fromWad(stressWad, tokenDecimals);
}

/**
 * Worse of the two fill legs, in token decimals: the engine stresses
 * `netDelta + buyDelta` and `netDelta − sellDelta` and takes the maximum.
 */
export function worstLegStressLoss(
  snap: AccountSnapshot,
  params: MMParams,
  shock: bigint,
  P: bigint,
): bigint {
  const netDelta = netDeltaWad(snap, params);
  const order = orderDeltaWad(snap, params);
  const buyLeg = stressLoss(netDelta + order.buy, shock, P, params.tokenDecimals);
  const sellLeg = stressLoss(netDelta - order.sell, shock, P, params.tokenDecimals);
  return buyLeg > sellLeg ? buyLeg : sellLeg;
}

/**
 * Instant mark-to-market loss if a whole side of a venue's book filled at price P.
 * Clamped per side across the venue's book, matching both venues' `getRiskView`.
 *
 *   buy:  max(0, buyValue  − P × buyDelta  / 10^tokenDecimals)
 *   sell: max(0, P × sellDelta / 10^tokenDecimals − sellValue)
 */
export function venueFillLoss(orders: RestingOrders, P: bigint, tokenDecimals: number): bigint {
  const scale = 10n ** BigInt(tokenDecimals);
  let loss = 0n;
  const buyMark = (P * orders.buyDelta) / scale;
  if (orders.buyValue > buyMark) loss += orders.buyValue - buyMark;
  const sellMark = (P * orders.sellDelta) / scale;
  if (sellMark > orders.sellValue) loss += sellMark - orders.sellValue;
  return loss;
}

/** Both venues' fill loss at P. The engine charges this in both stress legs. */
export function fillLoss(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  return (
    venueFillLoss(snap.perp.orders, P, params.tokenDecimals) +
    venueFillLoss(snap.futures.orders, P, params.tokenDecimals)
  );
}

/**
 * Signed perp unrealized PnL at price P (token decimals):
 *
 *   pnl = (P - entry) * netQty / 10^perpQtyDecimals
 *
 * Signed and unclamped on purpose: the clamp belongs to the requirement, not the
 * venue, and where it lands differs between IM and MM. See `unrealizedLoss`.
 */
export function perpUnrealizedPnl(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  if (snap.perp.netQty === 0n) return 0n;
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  return ((P - snap.perp.entryPrice) * snap.perp.netQty) / perpQtyScale;
}

/**
 * Signed futures unrealized PnL at price P (token decimals), netted across every
 * active expiry. Each whole contract settles `pricePerDay` of notional (no
 * duration multiplier):
 *
 *   pnl = sum_i (mark_i * netQuantity_i - netEntryValue_i)
 *
 * `mark_i` is the expiry's pinned `settlementPrice` when it has one and `P`
 * otherwise, mirroring `getRiskView`'s per-expiry choice. A settled leg's PnL is
 * therefore constant in P: it is a realized amount awaiting a sweep, not an
 * exposure, and revaluing it at a hypothetical price would invent PnL the account
 * can no longer gain or lose.
 *
 * The netting is not an off-chain approximation — it is what the engine sees.
 * `Futures.getRiskView` accumulates one signed `totalPnl` over the participant's
 * active expiries and reports that as the market's `unrealizedPnl`; individual
 * expiries never reach the PME. Clamping per expiry (which this module used to do)
 * over-charges every calendar spread, on both the IM and the MM path.
 */
export function futuresUnrealizedPnl(snap: AccountSnapshot, P: bigint): bigint {
  let pnl = 0n;
  for (const pos of snap.futures.positions) {
    const mark = pos.settlementPrice !== 0n ? pos.settlementPrice : P;
    pnl += mark * pos.netQuantity - pos.netEntryValue;
  }
  return pnl;
}

/**
 * The engine's `pnlTerm` at price P (token decimals):
 *
 *   IM: max(0, -perpPnl) + max(0, -futuresPnl)   clamped per market, gains ignored
 *   MM: max(0, -(perpPnl + futuresPnl))          clamped once, gains offset losses
 *
 * Mirrors `_linearAggregate`'s `unrealizedLossPerMarket` / `netUnrealizedPnl` pair
 * and the `isIM` pick in `_marginFromAggregate`. "Per market" means per venue:
 * there are exactly two registered linear markets, and the futures leg arrives at
 * the engine already netted across its expiries, so the IM path clamps two
 * numbers — never one per expiry.
 */
export function unrealizedLoss(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
  requirement: MarginRequirement,
): bigint {
  const perp = perpUnrealizedPnl(snap, params, P);
  const futures = futuresUnrealizedPnl(snap, P);
  if (requirement === "mm") {
    const total = perp + futures;
    return total < 0n ? -total : 0n;
  }
  return (perp < 0n ? -perp : 0n) + (futures < 0n ? -futures : 0n);
}

/**
 * Shared body of `mmRequired` / `imRequired`. The requirement selects both the
 * shock and the unrealized-PnL clamp; taking one argument rather than two keeps
 * the pair from ever disagreeing.
 */
function requiredAt(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
  requirement: MarginRequirement,
): bigint {
  const shock = requirement === "im" ? params.imSpotShock : params.mmSpotShock;
  return (
    worstLegStressLoss(snap, params, shock, P) +
    fillLoss(snap, params, P) +
    unrealizedLoss(snap, params, P, requirement) +
    snap.perp.fundingOwed
  );
}

/**
 * Maintenance-margin requirement at price P. Mirrors PME's
 * `_computeMargin(user, isIM=false)` for pure-delta portfolios.
 */
export function mmRequired(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  return requiredAt(snap, params, P, "mm");
}

/**
 * Initial-margin requirement at price P. Same shape, with the IM shock and the
 * per-market PnL clamp.
 */
export function imRequired(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  return requiredAt(snap, params, P, "im");
}

/** `balance - mmRequired(P)`. Negative = liquidatable. */
export function mmSurplus(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  return snap.balance - mmRequired(snap, params, P);
}

/** `balance - imRequired(P)`. Negative = below IM (warn / critical band). */
export function imSurplus(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  return snap.balance - imRequired(snap, params, P);
}
