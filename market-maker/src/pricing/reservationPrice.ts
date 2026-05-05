import Fraction from "fraction.js";
import { fromNumber, fromRatio, toBigint } from "../rational.ts";
import { BPS_SCALE, QUANTITY_SCALE, roundDownToTick, roundUpToTick } from "../math.ts";
import type { OracleTracker } from "../oracleTracker.ts";
import type { GasTracker } from "../gasTracker.ts";
import type { InventoryManager } from "../inventoryManager.ts";
import type { InstrumentContext } from "../adapter.ts";
import type { MidQuote } from "./effectiveSpread.ts";

export interface ReservationPriceConfig {
  /** Avellaneda–Stoikov risk aversion γ. Positive → short inventory pushes mid up,
   *  long inventory pushes mid down. Tuned relative to the σ × T product in your
   *  deployment: if σ is per-poll (~3 s) and T is in seconds, γ should be chosen
   *  to produce a sensible tick-level shift at max inventory. */
  riskAversion: number;
  /** Fallback remaining-time value (seconds) used when InstrumentContext has no
   *  deliveryDate (e.g. during testing or for non-delivery instruments). */
  marginCallTimeSeconds: number;
  /** Floor half-spread in basis points. */
  minSpreadBps: number;
  /** Widens spread by this multiple of σ (per-poll vol × 10 000 bps). */
  volatilityMultiplier: number;
  /** Penalty added to spread when gas price spikes. */
  gasPenaltyBps: number;
}

/**
 * Avellaneda–Stoikov reservation-price mid-quote.
 *
 *   r = S − q · γ · σ² · T
 *
 *   S  = oracle index price
 *   q  = signed inventory in contracts (netQuantity / QUANTITY_SCALE)
 *   γ  = risk aversion coefficient (ReservationPriceConfig.riskAversion)
 *   σ  = realized volatility per poll step (OracleTracker.volatility, a Fraction)
 *   T  = remaining time in seconds until delivery / margin-call
 *
 * All arithmetic on Fraction until the final tick-quantisation step.
 * The spread around r is computed identically to EffectiveSpread
 * (vol-widened, gas-floored), so the two strategies are drop-in-swappable
 * inside Quoter.
 */
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

  // ── Reservation price ────────────────────────────────────────────────────
  const sigma = oracle.volatility; // Fraction, per-poll
  const sigma2 = sigma.mul(sigma);
  const gamma = fromNumber(cfg.riskAversion);

  const remainingSeconds: Fraction = context.deliveryDate !== undefined
    ? fromNumber(Math.max(0, context.deliveryDate - nowMs / 1000))
    : fromNumber(cfg.marginCallTimeSeconds);

  // q = netQuantity / QUANTITY_SCALE  (signed, in "contracts")
  const q = new Fraction(inventory.netQuantity, QUANTITY_SCALE);

  // r = S - q·γ·σ²·T
  const adjustment = q.mul(gamma).mul(sigma2).mul(remainingSeconds);
  const rFrac = fromRatio(S).sub(adjustment);
  const rBigint = toBigint(rFrac, 1n, "nearest");
  const r = rBigint > tick ? rBigint : tick; // floor at 1 tick

  // ── Spread ───────────────────────────────────────────────────────────────
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

  const minSpread = fromNumber(cfg.minSpreadBps / 2); // half-spread floor

  // vol component: σ * volatilityMultiplier * 10000 bps, halved for half-spread
  const volBps = oracle.volatility
    .mul(fromNumber(cfg.volatilityMultiplier))
    .mul(new Fraction(10_000n))
    .div(new Fraction(2n));

  const base = volBps.compare(minSpread) > 0 ? volBps : minSpread;

  // gas spike penalty
  const spike = gas.gasSpikePct;
  const gasPenalty = spike.compare(new Fraction(0n)) > 0
    ? spike.div(new Fraction(100n)).mul(fromNumber(cfg.gasPenaltyBps / 2))
    : new Fraction(0n);

  return base.add(gasPenalty);
}
