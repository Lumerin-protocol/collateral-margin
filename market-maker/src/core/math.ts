/**
 * Numeric helpers shared by core. All trading math stays in bigint or Fraction;
 * `Number` is allowed only at the IO boundary (logs, JSON, ratio params from
 * config). The big rule is "never round a price through a Number" — that's
 * what the rational helpers in `./rational.ts` are for.
 */

import Fraction from "fraction.js";
import { ln, sqrt } from "./rational.ts";

// Perps quantity scale. Mirrors `HashPowerPerpsDEX.QUANTITY_DECIMALS()` (an on-chain
// `uint8 public constant`). The value is hardcoded here so the hot-path sizing/notional
// math stays synchronous, but it is the CHAIN that is authoritative: the perps venue
// asserts this matches on-chain at startup (`validateQuantityDecimals`) and aborts on drift.
export const QUANTITY_DECIMALS = 6;
export const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_DECIMALS);
export const BPS_SCALE = 10_000n;

/** Round price DOWN to nearest tick (for bids). */
export function roundDownToTick(price: bigint, tick: bigint): bigint {
  return (price / tick) * tick;
}

/** Round price UP to nearest tick (for asks). */
export function roundUpToTick(price: bigint, tick: bigint): bigint {
  const remainder = price % tick;
  return remainder === 0n ? price : price + tick - remainder;
}

/** Round price to nearest tick (ties up). */
export function roundToTick(price: bigint, tick: bigint): bigint {
  const remainder = price % tick;
  if (remainder === 0n) return price;
  return remainder * 2n >= tick ? price + (tick - remainder) : price - remainder;
}

/** Notional value: price * absQuantity / QUANTITY_SCALE. */
export function calculateNotional(price: bigint, absQuantity: bigint): bigint {
  const q = bigAbs(absQuantity);
  return (price * q) / QUANTITY_SCALE;
}

/**
 * Convert a USD notional amount to venue-native size at `price`, rounded to
 * the nearest native unit (half-up).
 *
 * Inverts `notional = price * size / quantityScale`:
 *   - perps: `quantityScale = QUANTITY_SCALE` (1e6)
 *   - futures: `quantityScale = 1n` (size is whole contracts; 1 contract ≈ $price)
 */
export function notionalToSize(
  price: bigint,
  notionalUsd: bigint,
  quantityScale: bigint,
): bigint {
  if (price <= 0n || notionalUsd <= 0n || quantityScale <= 0n) return 0n;
  return (notionalUsd * quantityScale + price / 2n) / price;
}

/** Apply basis-point offset to a price: price * (BPS_SCALE +/- bps) / BPS_SCALE. */
export function applyBps(price: bigint, bps: bigint): bigint {
  return (price * (BPS_SCALE + bps)) / BPS_SCALE;
}

/** Absolute value for bigint. */
export function bigAbs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export const bigMin = (a: bigint, b: bigint) => (a < b ? a : b);
export const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Rolling window of bigint samples. Computes:
 *   - per-step realized volatility = stddev of log returns (Fraction-precise)
 *   - per-second realized volatility = stddev of time-normalised log returns
 *     (requires timestamps on every push)
 *   - median (bigint)
 *
 * # Per-step volatility math
 *
 *   r_i = ln(p_i / p_{i-1})       (log return per step)
 *   μ   = (Σ r_i) / N
 *   σ²  = (Σ (r_i − μ)²) / (N − 1)
 *   σ   = sqrt(σ²)                ← returned as Fraction
 *
 * # Per-second volatility math
 *
 * Each step covers a possibly-variable Δt_i seconds. For a Brownian process
 * with per-second stddev σ_s, Var(r_i) = σ_s² · Δt_i, so the time-normalised
 * return x_i = r_i / √Δt_i has constant variance σ_s². Then σ_s is the sample
 * stddev of {x_i}:
 *
 *   Δt_i = t_i − t_{i-1}
 *   x_i  = r_i / √Δt_i
 *   σ_s² = Σ (x_i − μ)² / (N − 1)
 *   σ_s  = sqrt(σ_s²)             (units: dimensionless × s^-1/2)
 *
 * Notes:
 *   - We compute log returns as `ln(curr/prev)`, NOT `ln(curr) − ln(prev)` as
 *     two separate logs — Fraction.div is exact, and one ln call is half the
 *     work (and half the truncation error).
 *   - Sample variance (N−1 denominator). For N < 3 we return 0 because two
 *     samples produce a variance of zero whichever way you slice it.
 *   - `precisionBits` controls the bigint-only `ln`/`sqrt` approximations
 *     (see rational.ts). 48 bits is plenty for vol estimation; tune via
 *     constructor only when a strategy demonstrably needs more.
 *   - Timestamps are stored alongside samples; passing `undefined` records a
 *     sentinel and excludes that pair from `volatilityPerSecond` (gas tracker
 *     pushes without timestamps and only consumes `median`, so this stays
 *     backwards-compatible).
 */
export class RollingWindow {
  private readonly samples: bigint[] = [];
  private readonly timestampsSec: number[] = [];
  private readonly maxSize: number;
  private readonly precisionBits: number;

  constructor(maxSize: number, precisionBits = 64) {
    this.maxSize = maxSize;
    this.precisionBits = precisionBits;
  }

  /**
   * Append a sample. `timestampSec` is required for `volatilityPerSecond`
   * but optional for the per-step `volatility` and `median` consumers.
   */
  push(value: bigint, timestampSec?: number): void {
    this.samples.push(value);
    this.timestampsSec.push(timestampSec ?? Number.NaN);
    if (this.samples.length > this.maxSize) {
      this.samples.shift();
      this.timestampsSec.shift();
    }
  }

  get length(): number {
    return this.samples.length;
  }

  latest(): bigint | undefined {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : undefined;
  }

  /** Realized per-step volatility (stddev of log returns). 0 if fewer than 3 samples. */
  volatility(): Fraction {
    if (this.samples.length < 3) return new Fraction(0n);

    const returns: Fraction[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1];
      const curr = this.samples[i];
      if (prev > 0n && curr > 0n) {
        const ratio = new Fraction(curr, prev);
        returns.push(ln(ratio, this.precisionBits));
      }
    }

    if (returns.length < 2) return new Fraction(0n);
    return sampleStddev(returns, this.precisionBits);
  }

  /**
   * Realized per-second volatility (stddev of √Δt-normalised log returns).
   * 0 if fewer than 3 samples or if any required timestamp is missing /
   * non-monotonic. Units: dimensionless × s^-1/2.
   */
  volatilityPerSecond(): Fraction {
    if (this.samples.length < 3) return new Fraction(0n);

    const xs: Fraction[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1];
      const curr = this.samples[i];
      if (prev <= 0n || curr <= 0n) continue;

      const dtSec = this.timestampsSec[i] - this.timestampsSec[i - 1];
      if (!Number.isFinite(dtSec) || dtSec <= 0) continue;

      const r = ln(new Fraction(curr, prev), this.precisionBits);
      // Encode Δt as a Fraction with millisecond resolution; sub-ms precision
      // is irrelevant given the ≤2^-precisionBits truncation in `sqrt`.
      const dt = new Fraction(BigInt(Math.round(dtSec * 1000)), 1000n);
      const x = r.div(sqrt(dt, this.precisionBits));
      xs.push(x);
    }

    if (xs.length < 2) return new Fraction(0n);
    return sampleStddev(xs, this.precisionBits);
  }

  /** Median of samples (bigint). */
  median(): bigint {
    if (this.samples.length === 0) return 0n;
    const sorted = [...this.samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2n;
  }
}

function sampleStddev(values: Fraction[], precisionBits: number): Fraction {
  let sum = new Fraction(0n);
  for (const v of values) sum = sum.add(v);
  const mean = sum.div(new Fraction(BigInt(values.length)));

  let varSum = new Fraction(0n);
  for (const v of values) {
    const d = v.sub(mean);
    varSum = varSum.add(d.mul(d));
  }
  const variance = varSum.div(new Fraction(BigInt(values.length - 1)));
  return sqrt(variance, precisionBits);
}

/**
 * Rolling budget tracker: sums amounts in a sliding time window.
 * Used for gas budget enforcement (hourly / daily).
 */
export class RollingBudget {
  private readonly entries: Array<{ timestamp: number; amount: bigint }> = [];
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  add(amount: bigint, now: number = Date.now()): void {
    this.entries.push({ timestamp: now, amount });
  }

  total(now: number = Date.now()): bigint {
    this.prune(now);
    let sum = 0n;
    for (const e of this.entries) sum += e.amount;
    return sum;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      this.entries.shift();
    }
  }
}
