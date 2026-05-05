/**
 * Venue-agnostic helper functions used primarily by the futures adapter
 * and its historical warm-up path (scanning past on-chain events for vol).
 *
 * All functions operate on bigint prices and plain numbers for timestamps.
 * No viem or on-chain dependencies; fully unit-testable in isolation.
 */

import Fraction from "fraction.js";
import { ln, sqrt } from "./rational.ts";

// ─── Order delta ──────────────────────────────────────────────────────────────

export interface PricedOrder {
  price: bigint;
  /** Signed quantity: positive = buy/long, negative = sell/short. */
  qty: bigint;
}

/**
 * Calculate the minimal set of orders needed to transition from `currentOrders`
 * to `modelledOrders`. Orders at the same price offset each other: a +5 and a -5
 * at the same price produce a zero diff and are omitted.
 *
 * Returns orders sorted by price ascending.
 */
export function calculateOrders(
  modelledOrders: PricedOrder[],
  currentOrders: PricedOrder[],
): PricedOrder[] {
  const modelledByPrice = new Map<bigint, bigint>();
  for (const o of modelledOrders) {
    modelledByPrice.set(o.price, (modelledByPrice.get(o.price) ?? 0n) + o.qty);
  }

  const currentByPrice = new Map<bigint, bigint>();
  for (const o of currentOrders) {
    currentByPrice.set(o.price, (currentByPrice.get(o.price) ?? 0n) + o.qty);
  }

  const allPrices = new Set([...modelledByPrice.keys(), ...currentByPrice.keys()]);
  const result: PricedOrder[] = [];

  for (const price of allPrices) {
    const diff = (modelledByPrice.get(price) ?? 0n) - (currentByPrice.get(price) ?? 0n);
    if (diff !== 0n) result.push({ price, qty: diff });
  }

  result.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  return result;
}

// ─── Resample ─────────────────────────────────────────────────────────────────

export interface TimedPrice {
  /** Milliseconds since epoch (same as Date.now() convention). */
  date: number;
  price: bigint;
}

/**
 * Resample irregular price ticks into fixed-interval close prices.
 *
 * "Close" = last observed price in each bucket.
 * Missing buckets are filled with LOCF (last observation carried forward).
 *
 * @param prices - Raw price ticks in any order.
 * @param intervalMs - Bucket width in ms (default 1 hour).
 */
export function resampleHourlyClose(
  prices: TimedPrice[],
  intervalMs = 60 * 60 * 1000,
): TimedPrice[] {
  const pts = (prices ?? []).slice().sort((a, b) => a.date - b.date);
  if (pts.length === 0) return [];

  const bucketStart = (t: number) => Math.floor(t / intervalMs) * intervalMs;

  const closeByBucket = new Map<number, bigint>();
  for (const p of pts) {
    closeByBucket.set(bucketStart(p.date), p.price);
  }

  const start = bucketStart(pts[0].date);
  const end = bucketStart(pts[pts.length - 1].date);
  const result: TimedPrice[] = [];

  let last: bigint | null = null;
  for (let h = start; h <= end; h += intervalMs) {
    const price: bigint | null = closeByBucket.has(h) ? (closeByBucket.get(h) as bigint) : last;
    if (price != null) {
      result.push({ date: h, price });
      last = price;
    }
  }
  return result;
}

// ─── Realized volatility ──────────────────────────────────────────────────────

export interface VolatilityResult {
  /** Stddev of log returns per sample step. 0 if fewer than 2 valid returns. */
  sigmaPerStep: number;
}

/**
 * Realized volatility from a price series: stddev of log returns.
 *
 * Uses Fraction arithmetic (via rational.ts ln/sqrt) for precision.
 * Returns `{ sigmaPerStep: 0 }` for fewer than 2 valid log-return pairs.
 * Returns `{ sigmaPerStep: NaN }` when sample=true and exactly 1 return
 * (matches the original futures implementation: variance = 0/0 = NaN).
 *
 * Input prices must be positive bigints; dates must be positive finite numbers.
 * Input is sorted by date before processing.
 *
 * @param prices - Price ticks with timestamps.
 * @param sample - Use sample variance N−1 denominator (default true).
 * @param precisionBits - Precision for ln/sqrt (default 48).
 */
export function realizedVolatility(
  prices: TimedPrice[],
  sample = true,
  precisionBits = 48,
): VolatilityResult {
  for (const p of prices ?? []) {
    if (p.price <= 0n) throw new Error(`Invalid p.price: price=${p.price}, date=${p.date}`);
    if (!Number.isFinite(p.date) || p.date <= 0) {
      throw new Error(`Invalid p.date: price=${p.price}, date=${p.date}`);
    }
  }

  const pts = (prices ?? []).slice().sort((a, b) => a.date - b.date);
  if (pts.length < 2) return { sigmaPerStep: 0 };

  const returns: Fraction[] = [];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1].price;
    const curr = pts[i].price;
    if (prev > 0n && curr > 0n) {
      returns.push(ln(new Fraction(curr, prev), precisionBits));
    }
  }

  if (returns.length === 0) return { sigmaPerStep: 0 };

  // Exactly 1 return with sample variance → division by (1-1)=0 → NaN
  if (sample && returns.length === 1) return { sigmaPerStep: Number.NaN };

  let sum = new Fraction(0n);
  for (const r of returns) sum = sum.add(r);
  const mean = sum.div(new Fraction(BigInt(returns.length)));

  let varSum = new Fraction(0n);
  for (const r of returns) {
    const d = r.sub(mean);
    varSum = varSum.add(d.mul(d));
  }

  const denom = BigInt(sample ? returns.length - 1 : returns.length);
  const variance = varSum.div(new Fraction(denom));
  const sigmaFrac = sqrt(variance, precisionBits);

  const magnitude = Number(sigmaFrac.n) / Number(sigmaFrac.d);
  return { sigmaPerStep: sigmaFrac.s < 0 ? -magnitude : magnitude };
}
