/**
 * `@hashpower/portfolio-margin` — an off-chain replica of
 * `PortfolioMarginEngine._computeMargin` and the price-threshold solvers built
 * on top of it.
 *
 * This exists because the keeper and the UI both have to answer "at what spot
 * price does this account become liquidatable?", and they have to answer it
 * identically. When each kept its own copy they drifted — the two clamped
 * unrealized PnL differently, so they disagreed about who was liquidatable.
 * Keeping one implementation here makes that class of divergence impossible.
 *
 * The package is deliberately dependency-free and side-effect-free: pure
 * bigint arithmetic over a plain snapshot struct. Reading that snapshot from
 * chain is the caller's job, because the keeper and the UI do it very
 * differently (batched RPC vs wagmi hooks).
 */

export type {
  AccountSnapshot,
  Address,
  AlertThresholds,
  FuturesCloseLeg,
  MarginRequirement,
  MMParams,
  PriceThresholds,
  RestingOrders,
} from "./types.ts";

export {
  fillLoss,
  futuresUnrealizedPnl,
  imRequired,
  imSurplus,
  mmRequired,
  mmSurplus,
  netDeltaWad,
  orderDeltaWad,
  perpUnrealizedPnl,
  stressLoss,
  unrealizedLoss,
  venueFillLoss,
  worstLegStressLoss,
} from "./mm.ts";

export {
  simulateFuturesClose,
  simulatePerpClose,
  solveAlertThresholds,
  solveFuturesClosesToTarget,
  solveLiquidationThresholds,
  solvePerpCloseToTarget,
} from "./solve.ts";
