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
 *   r = S − q · γ · σ² · T              (reservation price)
 *
 *   half_spread_bps = max(min_half_bps, vol_half_bps) + gas_penalty_bps/2 · spike%
 *   vol_half_bps    = σ · vol_mult · 1e4 / 2
 *   bid             = r · (1 − half_spread_bps / 1e4)
 *   ask             = r · (1 + half_spread_bps / 1e4)
 *
 *   q = netQuantity / QUANTITY_SCALE     (signed, in "contracts")
 *   T = max(0, deliveryDate − now)       (seconds, fallback marginCallTimeSeconds)
 *   σ = OracleTracker.volatility         (per-poll Fraction)
 *
 * ## Units
 *
 *   - S, r, bid, ask  : token-decimals
 *   - q               : contracts (Fraction)
 *   - γ (riskAversion): dimensionless; tune so q·γ·σ²·T at max inventory
 *                       shifts r by ~1 tick
 *   - σ               : per-poll log-return stddev
 *   - T               : seconds
 *
 * ## Inventory direction
 *
 *   q > 0 (long)   → r < S → quotes shift DOWN, ask at lower price (eager to sell)
 *   q < 0 (short)  → r > S → quotes shift UP,  bid at higher price (eager to buy)
 *
 * ## Worked example
 *
 *   S = 100_000_000, σ = 0.001, γ = 0.001, q = 50 (long 50 contracts),
 *   T = 86_400 (1 day to delivery), min_spread = 15 bps, vol_mult = 2.5,
 *   tick = 1000.
 *
 *   adj   = 50 · 0.001 · 0.000001 · 86_400 ≈ 4.32  (price units)
 *   r     = 100_000_000 − 4.32 ≈ 99_999_995.68 → quantize to 99_999_995
 *   half  = max(7.5, 0.001 · 2.5 · 1e4 / 2) = max(7.5, 12.5) = 12.5 bps
 *   bid   = 99_999_995 · 0.99875 ≈ 99_874_995 → round down to nearest tick
 *   ask   = 99_999_995 · 1.00125 ≈ 100_124_994 → round up
 *
 * ## References
 *
 *   - Avellaneda & Stoikov 2008, "High-frequency trading in a limit order book."
 *     Section 3.2 derives r = S − q · γ · σ² · T and shows half-spread widens
 *     with γ and σ; the "min_spread floor" used here is a practitioner add-on
 *     to handle gas costs and exchange minimums that A-S abstracts away.
 *   - For futures, T is bounded above by deliveryDate (margin-call point);
 *     after delivery the position settles and there's no more inventory risk.
 */

import Fraction from "fraction.js";
import { fromNumber, fromRatio, toBigint } from "../rational.ts";
import { BPS_SCALE, QUANTITY_SCALE, roundDownToTick, roundUpToTick } from "../math.ts";
import type { OracleTracker } from "../oracleTracker.ts";
import type { GasTracker } from "../gasTracker.ts";
import type { InventoryManager } from "../inventoryManager.ts";
import type { InstrumentContext } from "../adapter.ts";
import type { MidQuote } from "./effectiveSpread.ts";

export interface ReservationPriceConfig {
  /** Avellaneda–Stoikov risk aversion γ. */
  riskAversion: number;
  /** Fallback remaining time (seconds) when InstrumentContext.deliveryDate is absent. */
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
  nowMs?: number;
}): MidQuote {
  const { oracle, gas, inventory, context, cfg, tick, nowMs = Date.now() } = opts;
  const S = oracle.currentPrice;

  // Reservation price r = S − q·γ·σ²·T (file header).
  const sigma = oracle.volatility;
  const sigma2 = sigma.mul(sigma);
  const gamma = fromNumber(cfg.riskAversion);

  const remainingSeconds: Fraction = context.deliveryDate !== undefined
    ? fromNumber(Math.max(0, context.deliveryDate - nowMs / 1000))
    : fromNumber(cfg.marginCallTimeSeconds);

  const q = new Fraction(inventory.netQuantity, QUANTITY_SCALE);
  const adjustment = q.mul(gamma).mul(sigma2).mul(remainingSeconds);
  const rFrac = fromRatio(S).sub(adjustment);
  const rBigint = toBigint(rFrac, 1n, "nearest");
  const r = rBigint > tick ? rBigint : tick; // floor at 1 tick

  // Symmetric half-spread around r; vol/gas widen it (file header).
  const spreadBps = halfSpreadBps({ oracle, gas, cfg }).mul(new Fraction(2n));
  const halfBps = halfSpreadBps({ oracle, gas, cfg });
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
}): Fraction {
  const { oracle, gas, cfg } = opts;

  const minSpread = fromNumber(cfg.minSpreadBps / 2); // half of the full-spread floor
  const volBps = oracle.volatility
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
