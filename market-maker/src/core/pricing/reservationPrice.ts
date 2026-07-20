/**
 * # Reservation-price pricing (Avellaneda–Stoikov)
 *
 * Asymmetric quoter where the *mid* is shifted by inventory and the half-spread
 * is widened by vol/gas. Used on futures where matching is "exact" — each
 * level needs a distinct price to be useful, and the shift means the side we
 * want to be hit gets a better price than the side we don't.
 *
 * ## Formulas
 *
 *   r = S − q · γ · σ_s² · T            (reservation price)
 *
 *   half_spread_bps = max(min_half_bps, vol_half_bps) + gas_penalty_bps/2 · spike%
 *   vol_half_bps    = σ_s · √H_sec · vol_mult · 1e4 / 2
 *   bid             = r · (1 − half_spread_bps / 1e4)
 *   ask             = r · (1 + half_spread_bps / 1e4)
 *
 *   q   = netQuantity / QUANTITY_SCALE   (signed, in "contracts")
 *   T   = max(0, expirationAt − now)     (seconds, fallback marginCallTimeSeconds)
 *   H   = vol horizon                    (seconds; defaults to pollInterval)
 *   σ_s = OracleTracker.volatilityPerSecond  (units s^-1/2)
 *
 * ## Units
 *
 *   - S, r, bid, ask  : token-decimals
 *   - q               : contracts (Fraction)
 *   - σ_s             : per-second log-return stddev (units s^-1/2)
 *   - σ_s² · T        : dimensionless variance over T seconds
 *   - γ (riskAversion): price; tunes so q·γ·σ_s²·T at max inventory shifts r
 *                       by ~1 tick. With per-second σ, γ values are smaller
 *                       than the per-step legacy by roughly pollIntervalSec.
 *   - T, H            : seconds
 *
 * ## Inventory direction
 *
 *   q > 0 (long)   → r < S → quotes shift DOWN, ask at lower price (eager to sell)
 *   q < 0 (short)  → r > S → quotes shift UP,  bid at higher price (eager to buy)
 *
 * ## Worked example
 *
 *   S = 100_000_000, σ_s = 5.8e-4 per √s, γ = 1e-3, q = 50, T = 86_400,
 *   H = 3 s, min_spread = 15 bps, vol_mult = 2.5, tick = 1000.
 *
 *   σ_s²·T = (5.8e-4)² · 86_400 ≈ 0.0291
 *   adj    = 50 · 1e-3 · 0.0291 ≈ 1.45 (price units)
 *   r      = 100_000_000 − 1.45 → quantize to 99_999_999
 *   vol_half_bps = 5.8e-4 · √3 · 2.5 · 1e4 / 2 ≈ 12.5 bps
 *   half   = max(7.5, 12.5) = 12.5 bps
 *   bid    = 99_999_999 · 0.99875 → roundDownToTick
 *   ask    = 99_999_999 · 1.00125 → roundUpToTick
 *
 * ## References
 *
 *   - Avellaneda & Stoikov 2008, "High-frequency trading in a limit order book."
 *     Section 3.2 derives r = S − q · γ · σ² · T and shows half-spread widens
 *     with γ and σ; the "min_spread floor" used here is a practitioner add-on
 *     to handle gas costs and exchange minimums that A-S abstracts away.
 *   - For futures, T is bounded above by expirationAt (margin-call point);
 *     after delivery the position settles and there's no more inventory risk.
 */

import Fraction from "fraction.js";
import { fromNumber, fromRatio, sqrt, toBigint } from "../rational.ts";
import { BPS_SCALE, QUANTITY_SCALE, roundDownToTick, roundUpToTick } from "../math.ts";
import type { OracleTracker } from "../oracleTracker.ts";
import type { GasTracker } from "../gasTracker.ts";
import type { InventoryManager } from "../inventoryManager.ts";
import type { InstrumentContext } from "../adapter.ts";
import type { MidQuote } from "./effectiveSpread.ts";

/** Bigint precision for the √H_sec conversion of σ_per_sec → σ_per_horizon. */
const VOL_HORIZON_PRECISION_BITS = 48;

export interface ReservationPriceConfig {
  /** Avellaneda–Stoikov risk aversion γ. */
  riskAversion: number;
  /** Fallback remaining time (seconds) when InstrumentContext.expirationAt is absent. */
  marginCallTimeSeconds: number;
  /** Floor full-spread in basis points; one-side half-spread is half this. */
  minSpreadBps: number;
  /** Widens half-spread by σ × volatilityMultiplier × 1e4 / 2 (bps). */
  volatilityMultiplier: number;
  /** Penalty added to spread when gas price spikes. */
  gasPenaltyBps: number;
}

export function computeReservationMidQuote(opts: {
  oracle: OracleTracker;
  gas: GasTracker;
  inventory: InventoryManager;
  context: InstrumentContext;
  cfg: ReservationPriceConfig;
  tick: bigint;
  /** Holding-time horizon (seconds) used to scale per-second σ into bps. */
  volHorizonSec: number;
  nowMs?: number;
}): MidQuote {
  const { oracle, gas, inventory, context, cfg, tick, volHorizonSec, nowMs = Date.now() } = opts;
  const S = oracle.currentPrice;

  // Reservation price r = S − q·γ·σ_s²·T (file header).
  const sigma = oracle.volatilityPerSecond;
  const sigma2 = sigma.mul(sigma);
  const gamma = fromNumber(cfg.riskAversion);

  const remainingSeconds: Fraction = context.expirationAt !== undefined
    ? fromNumber(Math.max(0, context.expirationAt - nowMs / 1000))
    : fromNumber(cfg.marginCallTimeSeconds);

  const q = new Fraction(inventory.netQuantity, QUANTITY_SCALE);
  const adjustment = q.mul(gamma).mul(sigma2).mul(remainingSeconds);
  const rFrac = fromRatio(S).sub(adjustment);
  const rBigint = toBigint(rFrac, 1n, "nearest");
  const r = rBigint > tick ? rBigint : tick; // floor at 1 tick

  // Symmetric half-spread around r; vol/gas widen it (file header).
  const halfBps = halfSpreadBps({ oracle, gas, cfg, volHorizonSec });
  const spreadBps = halfBps.mul(new Fraction(2n));
  const halfBpsBig = toBigint(halfBps, 1n, "nearest");

  const bidRaw = (r * (BPS_SCALE - halfBpsBig)) / BPS_SCALE;
  const askRaw = (r * (BPS_SCALE + halfBpsBig)) / BPS_SCALE;

  const bidMid = roundDownToTick(bidRaw > tick ? bidRaw : tick, tick);
  const askMid = roundUpToTick(askRaw > tick ? askRaw : tick, tick);

  return { bidMid, askMid, spreadBps };
}

function halfSpreadBps(opts: {
  oracle: OracleTracker;
  gas: GasTracker;
  cfg: ReservationPriceConfig;
  volHorizonSec: number;
}): Fraction {
  const { oracle, gas, cfg, volHorizonSec } = opts;

  const minSpread = fromNumber(cfg.minSpreadBps / 2); // half of the full-spread floor
  const horizonScale = horizonStddevScale(volHorizonSec);
  const volBps = oracle.volatilityPerSecond
    .mul(horizonScale)
    .mul(fromNumber(cfg.volatilityMultiplier))
    .mul(new Fraction(10_000n))
    .div(new Fraction(2n));

  const base = volBps.compare(minSpread) > 0 ? volBps : minSpread;

  const spike = gas.gasSpikePct;
  const gasPenalty = spike.compare(new Fraction(0n)) > 0
    ? spike.div(new Fraction(100n)).mul(fromNumber(cfg.gasPenaltyBps / 2))
    : new Fraction(0n);

  return base.add(gasPenalty);
}

/** √H_sec as a Fraction; mirrors `effectiveSpread.horizonStddevScale`. */
function horizonStddevScale(horizonSec: number): Fraction {
  if (!Number.isFinite(horizonSec) || horizonSec <= 0) return new Fraction(0n);
  const ms = Math.max(1, Math.round(horizonSec * 1000));
  return sqrt(new Fraction(BigInt(ms), 1000n), VOL_HORIZON_PRECISION_BITS);
}
