/**
 * # Effective-spread pricing
 *
 * Symmetric quoter that widens the spread with realised vol, gas, and inventory
 * skew. Used on perps where matching is "limit" (better-or-equal). The quoter
 * is symmetric around the oracle mid; inventory drives a price *shift* (skew
 * offset) rather than the spread (the asymmetry comes from the offset).
 *
 * ## Formulas
 *
 *   half_spread_bps = 0.5 * full_spread_bps
 *
 *   full_spread_bps = max(min_spread, gas_floor)
 *                   + vol_mult * σ_s * √H_sec * 1e4
 *                   + γ * |skew| * min_spread
 *                   + gas_penalty * spike_pct / 100
 *
 *   gas_floor      = round_trip_gas_cost / expected_notional * 1e4
 *   skew_offset    = round(γ_skew * skew * max_skew_ticks) * tick
 *
 *   bid_mid        = oracle * (1 - half_spread_bps / 1e4) - skew_offset
 *   ask_mid        = oracle * (1 + half_spread_bps / 1e4) - skew_offset
 *
 * ## Units
 *
 *   - oracle, bid_mid, ask_mid : token-decimals (USDC base units)
 *   - σ_s                      : per-second log-return stddev (Fraction, units s^-1/2)
 *   - H_sec                    : holding-time horizon in seconds (poll interval)
 *   - skew                     : netQty / maxPos in [-1, 1]   (Fraction)
 *   - bps                      : basis points (1 bp = 0.01%)
 *
 * `σ_s · √H_sec` is the equivalent log-return stddev over an H_sec window; for
 * Brownian motion that is what the spread must compensate for between requotes.
 *
 * ## Worked example
 *
 *   oracle = 100_000_000 (≈ $100), σ_s = 5.8e-4 per √s (≈ 1e-3 per √3s),
 *   H = 3 s, vol_mult = 2, γ = 0.5, skew = +0.4, max_skew_ticks = 20,
 *   tick = 1000, min_spread = 10 bps, no gas.
 *
 *   vol_bps        = 5.8e-4 * √3 * 2 * 1e4 ≈ 20 bps
 *   skew_inv_bps   = 0.5 * 0.4 * 10  = 2 bps
 *   full_spread_bps= max(10, 0) + 20 + 2 = 32 bps
 *   half_spread_bps= 16
 *   skew_offset    = round(0.5 * 0.4 * 20) * 1000 = 4 * 1000 = 4000
 *   bid_mid        ≈ 100_000_000 * 0.9984 - 4000 = 99_836_000
 *   ask_mid        ≈ 100_000_000 * 1.0016 - 4000 = 100_156_000
 *
 * ## References
 *
 *   - Avellaneda & Stoikov 2008 (the spread component is the same first-order
 *     approximation; the inventory shift is bolted on linearly here, which is
 *     the simpler "symmetric quoter" used by perps. For a full A-S quoter see
 *     `reservationPrice.ts`.)
 */

import Fraction from "fraction.js";
import type { OracleTracker } from "../oracleTracker.ts";
import type { GasTracker } from "../gasTracker.ts";
import type { InventoryManager } from "../inventoryManager.ts";
import { BPS_SCALE, calculateNotional } from "../math.ts";
import { sqrt, toBigint } from "../rational.ts";

/** Bigint precision for the √H_sec conversion of σ_per_sec → σ_per_horizon. */
const VOL_HORIZON_PRECISION_BITS = 48;

export interface EffectiveSpreadConfig {
  /** Floor spread in basis points; one-side half-spread is half this. */
  minSpreadBps: number;
  /** Multiplier on realised volatility (Fraction → bps). */
  volatilityMultiplier: number;
  /** Multiplier on |inventory skew| (×minSpreadBps). */
  inventorySkewGamma: number;
  /** Penalty added when gas spikes (×spike fraction). */
  gasPenaltyBps: number;
}

export interface MidQuote {
  /** Bid mid (oracle − halfSpread − skewOffset). */
  bidMid: bigint;
  /** Ask mid (oracle + halfSpread − skewOffset). */
  askMid: bigint;
  /** Effective full spread used (Fraction bps, for diagnostics). */
  spreadBps: Fraction;
}

/** See file header for full formula and worked example. */
export function computeMidQuote(opts: {
  oracle: OracleTracker;
  gas: GasTracker;
  inventory: InventoryManager;
  cfg: EffectiveSpreadConfig;
  baseQuantity: bigint;
  maxSkewTicks: number;
  tick: bigint;
  /** Holding-time horizon (seconds) used to scale per-second σ into bps. */
  volHorizonSec: number;
}): MidQuote {
  const { oracle, gas, inventory, cfg, baseQuantity, maxSkewTicks, tick, volHorizonSec } = opts;
  const oraclePrice = oracle.currentPrice;

  const spreadBps = effectiveSpreadBps({ oracle, gas, inventory, cfg, baseQuantity, volHorizonSec });
  const halfSpreadBps = spreadBps.div(new Fraction(2n));

  const skewOffset = inventorySkewOffset({
    inventory,
    oraclePrice,
    maxSkewTicks,
    tick,
    gamma: cfg.inventorySkewGamma,
  });

  const halfBpsBig = bpsToBigint(halfSpreadBps);
  const bidMid = (oraclePrice * (BPS_SCALE - halfBpsBig)) / BPS_SCALE - skewOffset;
  const askMid = (oraclePrice * (BPS_SCALE + halfBpsBig)) / BPS_SCALE - skewOffset;

  return { bidMid, askMid, spreadBps };
}

function effectiveSpreadBps(opts: {
  oracle: OracleTracker;
  gas: GasTracker;
  inventory: InventoryManager;
  cfg: EffectiveSpreadConfig;
  baseQuantity: bigint;
  volHorizonSec: number;
}): Fraction {
  const { oracle, gas, inventory, cfg, baseQuantity, volHorizonSec } = opts;

  const gasFloor = gasFloorBps(oracle, gas, baseQuantity);
  const minSpread = new Fraction(cfg.minSpreadBps);
  const base = gasFloor.compare(minSpread) > 0 ? gasFloor : minSpread;

  // σ_per_sec * √H_sec * multiplier * 10000 → bps
  const horizonScale = horizonStddevScale(volHorizonSec);
  const vol = oracle.volatilityPerSecond
    .mul(horizonScale)
    .mul(new Fraction(Math.round(cfg.volatilityMultiplier * 1_000_000), 1_000_000))
    .mul(new Fraction(10_000n));

  const skewAbs = inventory.inventorySkew.abs();
  const inv = skewAbs.mul(minSpread).mul(
    new Fraction(Math.round(cfg.inventorySkewGamma * 1_000_000), 1_000_000),
  );

  const spike = gas.gasSpikePct;
  const gasPenalty = spike.compare(new Fraction(0n)) > 0
    ? spike.div(new Fraction(100n)).mul(new Fraction(cfg.gasPenaltyBps))
    : new Fraction(0n);

  return base.add(vol).add(inv).add(gasPenalty);
}

/**
 * Round-trip gas cost expressed as bps of expected notional. Forms a floor
 * for the spread when gas is so expensive that a fill at minSpread would
 * lose money on gas alone.
 */
function gasFloorBps(oracle: OracleTracker, gas: GasTracker, baseQuantity: bigint): Fraction {
  const rt = gas.roundTripCostUsd;
  if (rt === 0n) return new Fraction(0n);
  const expectedNotional = calculateNotional(oracle.currentPrice, baseQuantity);
  if (expectedNotional === 0n) return new Fraction(0n);
  return new Fraction(rt * 10_000n, expectedNotional);
}

function inventorySkewOffset(opts: {
  inventory: InventoryManager;
  oraclePrice: bigint;
  maxSkewTicks: number;
  tick: bigint;
  gamma: number;
}): bigint {
  const { inventory, oraclePrice, maxSkewTicks, tick, gamma } = opts;
  if (oraclePrice === 0n || tick === 0n) return 0n;
  // skewTicks = round(gamma * skew * maxSkewTicks)
  const skewTicks = inventory.inventorySkew
    .mul(new Fraction(Math.round(gamma * 1_000_000), 1_000_000))
    .mul(new Fraction(maxSkewTicks));
  const skewTicksBig = toBigint(skewTicks, 1n, "nearest");
  return skewTicksBig * tick;
}

function bpsToBigint(bpsFraction: Fraction): bigint {
  return toBigint(bpsFraction, 1n, "nearest");
}

/**
 * √H_sec as a Fraction. Uses millisecond resolution under the hood so
 * fractional-second horizons (e.g. 0.5s) round to a stable rational.
 */
function horizonStddevScale(horizonSec: number): Fraction {
  if (!Number.isFinite(horizonSec) || horizonSec <= 0) return new Fraction(0n);
  const ms = Math.max(1, Math.round(horizonSec * 1000));
  return sqrt(new Fraction(BigInt(ms), 1000n), VOL_HORIZON_PRECISION_BITS);
}
