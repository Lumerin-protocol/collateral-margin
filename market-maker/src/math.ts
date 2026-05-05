import Fraction from "fraction.js";
import { ln, sqrt } from "./rational.ts";

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

/** Notional value: price * absQuantity / 10^QUANTITY_DECIMALS. */
export function calculateNotional(price: bigint, absQuantity: bigint): bigint {
  const q = bigAbs(absQuantity);
  return (price * q) / QUANTITY_SCALE;
}

/** Apply basis-point offset to a price: price * (BPS_SCALE +/- bps) / BPS_SCALE. */
export function applyBps(price: bigint, bps: bigint): bigint {
  return (price * (BPS_SCALE + bps)) / BPS_SCALE;
}

/** Absolute value for bigint. */
export function bigAbs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Min / max for bigint. */
export const bigMin = (a: bigint, b: bigint) => (a < b ? a : b);
export const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Rolling window of bigint samples. Computes:
 *  - realized volatility = stddev of log returns (Fraction-precise)
 *  - median (bigint)
 *
 * `precisionBits` controls the precision used for the internal `ln` and `sqrt`
 * approximations when computing volatility; default is plenty for vol estimation.
 */
export class RollingWindow {
  private readonly samples: bigint[] = [];
  private readonly maxSize: number;
  private readonly precisionBits: number;

  constructor(maxSize: number, precisionBits = 64) {
    this.maxSize = maxSize;
    this.precisionBits = precisionBits;
  }

  push(value: bigint): void {
    this.samples.push(value);
    if (this.samples.length > this.maxSize) {
      this.samples.shift();
    }
  }

  get length(): number {
    return this.samples.length;
  }

  latest(): bigint | undefined {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : undefined;
  }

  /**
   * Realized volatility as stddev of log returns, returned as Fraction.
   * Returns 0 if fewer than 3 samples or all returns are degenerate.
   */
  volatility(): Fraction {
    if (this.samples.length < 3) return new Fraction(0n);

    const returns: Fraction[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1];
      const curr = this.samples[i];
      if (prev > 0n && curr > 0n) {
        // r = ln(curr / prev) = ln(curr) - ln(prev)
        const ratio = new Fraction(curr, prev);
        returns.push(ln(ratio, this.precisionBits));
      }
    }

    if (returns.length < 2) return new Fraction(0n);

    let sum = new Fraction(0n);
    for (const r of returns) sum = sum.add(r);
    const mean = sum.div(new Fraction(BigInt(returns.length)));

    let varSum = new Fraction(0n);
    for (const r of returns) {
      const d = r.sub(mean);
      varSum = varSum.add(d.mul(d));
    }
    const variance = varSum.div(new Fraction(BigInt(returns.length - 1)));
    return sqrt(variance, this.precisionBits);
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
