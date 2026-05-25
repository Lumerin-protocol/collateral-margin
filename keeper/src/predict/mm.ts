import type { AccountSnapshot, MMParams } from "./types.ts";

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
 * Plus the four constant or P-piecewise-linear add-ons:
 *   - perp.orderMargin (constant)
 *   - perp.unrealizedLoss = max(0, -((P - entry) * netQty / qtyScale))
 *   - futures.orderMargin (constant)
 *   - futures.unrealizedLoss = sum_i max(0, -(buyer? : ±)(P - entry_i)*deliveryDays)
 *   - perp.fundingOwed (constant — short-term, refreshed on snapshot)
 *
 * Total mmRequired(P) is therefore piecewise-linear with kinks at the
 * per-leg break-even prices. We deliberately keep the math straight (no
 * over-engineered piecewise representation) — `mmRequired` is cheap, the
 * solver bisects when it matters, and the closed-form solver invokes this
 * to verify its candidate roots.
 *
 * All bigint arithmetic. Token-decimal rounding matches PME's integer division.
 */

const WAD = 10n ** 18n;

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Aggregate net delta in WAD (matches `_aggregateGreeks` for pure-delta).
 *
 *   perpDelta = perpNetQty * WAD / 10^perpQtyDecimals
 *   futuresDelta = sum_i (isBuyer ? +1 : -1) * deliveryDays * WAD
 *
 * Note: the on-chain `getNetPositionDelta` already returns this sum for the
 * futures leg in WAD; we re-derive it here off-chain because the snapshot
 * carries per-position rows (needed for per-leg PnL kinks) and re-using
 * them avoids a second contract call. Both paths converge on the same value.
 */
export function netDeltaWad(snap: AccountSnapshot, params: MMParams): bigint {
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  let delta = (snap.perp.netQty * WAD) / perpQtyScale;
  for (const pos of snap.futures.positions) {
    const sign = pos.isBuyer ? 1n : -1n;
    delta += sign * snap.futures.deliveryDays * WAD;
  }
  return delta;
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
 * Perp unrealized loss at price P.
 *
 *   pnl = (P - entry) * netQty / 10^perpQtyDecimals
 *   loss = max(0, -pnl)
 */
export function perpUnrealizedLoss(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  if (snap.perp.netQty === 0n) return 0n;
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  const pnl = ((P - snap.perp.entryPrice) * snap.perp.netQty) / perpQtyScale;
  return pnl < 0n ? -pnl : 0n;
}

/**
 * Sum of per-position futures unrealized losses at price P. Each contract:
 *
 *   diffPerDay = isBuyer ? (P - entryPerDay) : (entryPerDay - P)
 *   pnl = diffPerDay * deliveryDays
 *   loss = max(0, -pnl)
 */
export function futuresUnrealizedLoss(snap: AccountSnapshot, P: bigint): bigint {
  let sum = 0n;
  for (const pos of snap.futures.positions) {
    const diffPerDay = pos.isBuyer ? P - pos.entryPricePerDay : pos.entryPricePerDay - P;
    const pnl = diffPerDay * snap.futures.deliveryDays;
    if (pnl < 0n) sum += -pnl;
  }
  return sum;
}

/**
 * Maintenance-margin requirement at price P. Mirrors PME's
 * `_computeMargin(user, isIM=false)` for pure-delta portfolios.
 */
export function mmRequired(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  const delta = netDeltaWad(snap, params);
  return (
    stressLoss(delta, params.mmSpotShock, P, params.tokenDecimals) +
    snap.perp.orderMargin +
    snap.futures.orderMargin +
    perpUnrealizedLoss(snap, params, P) +
    futuresUnrealizedLoss(snap, P) +
    snap.perp.fundingOwed
  );
}

/**
 * Initial-margin requirement at price P. Same shape, swap mmShock → imShock.
 */
export function imRequired(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  const delta = netDeltaWad(snap, params);
  return (
    stressLoss(delta, params.imSpotShock, P, params.tokenDecimals) +
    snap.perp.orderMargin +
    snap.futures.orderMargin +
    perpUnrealizedLoss(snap, params, P) +
    futuresUnrealizedLoss(snap, P) +
    snap.perp.fundingOwed
  );
}

/** `balance - mmRequired(P)`. Negative = liquidatable. */
export function mmSurplus(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  return snap.balance - mmRequired(snap, params, P);
}

/** `balance - imRequired(P)`. Negative = below IM (warn / critical band). */
export function imSurplus(snap: AccountSnapshot, params: MMParams, P: bigint): bigint {
  return snap.balance - imRequired(snap, params, P);
}
