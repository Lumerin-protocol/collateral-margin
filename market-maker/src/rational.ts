import Fraction from "fraction.js";

/**
 * Approximations for irrational results on `fraction.js` Fractions.
 *
 * `Fraction` itself is exact rational arithmetic with BigInt internals.
 * `sqrt` and `ln` are irrational in general; this module gives bounded-precision
 * Fraction approximations using bigint-only math. No `Number` is used in the hot path.
 *
 * Precision is expressed in fractional bits: a value of `precisionBits = b` returns
 * a Fraction with denominator <= 2^b that approximates the true value within roughly
 * 2^-b relative error.
 */

/** Floor of integer square root of a non-negative bigint (Newton's method). */
export function bigintSqrtFloor(n: bigint): bigint {
  if (n < 0n) throw new RangeError("bigintSqrtFloor: negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** Absolute value of a bigint. */
function babs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Square root of a non-negative Fraction with `precisionBits` fractional bits.
 *
 * Returned Fraction = floor(sqrt(x * 4^b)) / 2^b, where b = precisionBits.
 * The relative error is at most 2 * 2^-b for x >= 1.
 */
export function sqrt(x: Fraction, precisionBits = 64): Fraction {
  if (x.s < 0) throw new RangeError("sqrt: negative");
  if (x.n === 0n) return new Fraction(0n);

  // x = n/d  =>  sqrt(x) ≈ floor(sqrt(n * 4^b * d)) / (2^b * d)
  // We compute as bigint to avoid any Number conversion.
  const b = BigInt(precisionBits);
  const scale = 1n << b; // 2^b
  const scaleSquared = scale * scale; // 4^b

  // floor(sqrt(n * 4^b / d)) is what we want; multiply by d to get exact integer
  // sqrt(n/d) * 2^b = sqrt(n * 4^b / d) = sqrt(n * 4^b * d) / d
  const radicand = x.n * scaleSquared * x.d;
  const root = bigintSqrtFloor(radicand);
  // Sign of x is non-negative; n/d in fraction.js stores absolute values with .s
  return new Fraction(root, scale * x.d);
}

/**
 * Natural log of a positive Fraction with `precisionBits` fractional bits of accuracy.
 *
 * Strategy:
 *   1. Reduce x to y in [1/2, 2] by dividing by 2^k (k can be negative).
 *      ln(x) = k * ln(2) + ln(y)
 *   2. For y in [1/2, 2], let u = (y - 1) / (y + 1), |u| <= 1/3.
 *      ln(y) = 2 * (u + u^3/3 + u^5/5 + ...)
 *      Series converges geometrically; truncate when terms drop below precision.
 *   3. ln(2) is computed once at the requested precision via the same atanh series
 *      applied to (3-1)/(3+1) and the identity ln(2) = ln(4/3) + ln(3/2),
 *      but it's simpler to use ln(2) = -ln(1/2) computed by the same series with y=1/2.
 */
export function ln(x: Fraction, precisionBits = 64): Fraction {
  if (x.s <= 0 || x.n === 0n) {
    throw new RangeError("ln: argument must be positive");
  }

  // Step 1: reduce to y in [1/2, 2] by extracting powers of 2.
  // We compare numerator vs denominator * 2^k.
  let { n, d } = x;
  let k = 0n;
  // Halve while x >= 2  <=>  n >= 2*d
  while (n >= 2n * d) {
    d *= 2n;
    k += 1n;
  }
  // Double while x < 1/2  <=>  n*2 < d  <=>  d > 2*n
  while (d > 2n * n) {
    n *= 2n;
    k -= 1n;
  }
  const y = new Fraction(n, d); // y in [1/2, 2]

  const lnY = atanhSeries(y, precisionBits);
  if (k === 0n) return lnY;

  const ln2 = ln2Cached(precisionBits);
  return lnY.add(ln2.mul(new Fraction(k)));
}

/**
 * Computes ln(y) for y in [1/2, 2] using the atanh series:
 *   ln(y) = 2 * sum_{i=0..inf} u^(2i+1) / (2i+1),  where u = (y-1)/(y+1)
 *
 * |u| <= 1/3 in this interval, so the series converges quickly.
 * Truncates when the next term drops below 2^-precisionBits relative to result.
 */
function atanhSeries(y: Fraction, precisionBits: number): Fraction {
  const u = y.sub(1).div(y.add(1)); // (y-1)/(y+1)
  if (u.n === 0n) return new Fraction(0n);

  const u2 = u.mul(u);
  let term = u; // u^1 / 1
  let sum = term;
  // tolerance: when |term| < 2^-precisionBits we stop
  const tolDen = 1n << BigInt(precisionBits);
  // term threshold as Fraction: 1/2^precisionBits
  const tolerance = new Fraction(1n, tolDen);

  let i = 1n;
  while (true) {
    // next term = previous * u^2 * (2i-1)/(2i+1)
    const idx2 = 2n * i + 1n;
    term = term.mul(u2).mul(new Fraction(2n * i - 1n, idx2));
    sum = sum.add(term);
    if (term.abs().compare(tolerance) < 0) break;
    i += 1n;
    if (i > 10000n) break; // safety
  }
  return sum.mul(new Fraction(2n));
}

const ln2Cache = new Map<number, Fraction>();
function ln2Cached(precisionBits: number): Fraction {
  const cached = ln2Cache.get(precisionBits);
  if (cached) return cached;
  // ln(2) = -ln(1/2). y = 1/2 reduces to itself with k=0, so atanhSeries handles it.
  const v = atanhSeries(new Fraction(1n, 2n), precisionBits).neg();
  ln2Cache.set(precisionBits, v);
  return v;
}

/**
 * Convert a Fraction to bigint at a given scale, using nearest-even rounding.
 * E.g. toBigint(Fraction(7, 3), 1n) ~ 2n (since 7/3 = 2.33...).
 *
 * `scale` is the integer denominator the result will be expressed against,
 * i.e. result represents `value * scale` rounded to the nearest integer.
 */
export function toBigint(value: Fraction, scale: bigint = 1n, mode: "nearest" | "floor" | "ceil" = "nearest"): bigint {
  if (scale <= 0n) throw new RangeError("toBigint: scale must be positive");
  const num = value.n * scale * BigInt(value.s);
  const den = value.d;
  if (mode === "floor") {
    return floorDiv(num, den);
  }
  if (mode === "ceil") {
    return -floorDiv(-num, den);
  }
  // nearest-even (banker's rounding)
  const q = floorDiv(num, den);
  const r = num - q * den; // 0 <= r < den
  const twice = 2n * r;
  if (twice < den) return q;
  if (twice > den) return q + 1n;
  // exactly half — pick even
  return (q & 1n) === 0n ? q : q + 1n;
}

/** Floor division for bigints (Math.floor semantics, including negatives). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b < 0n) {
    a = -a;
    b = -b;
  }
  const q = a / b;
  const r = a - q * b;
  if (r < 0n) return q - 1n;
  return q;
}

/** Construct a Fraction from a bigint ratio safely. */
export function fromRatio(num: bigint, den: bigint = 1n): Fraction {
  return new Fraction(num, den);
}

/** Construct a Fraction approximating a JavaScript number (use only at IO boundaries). */
export function fromNumber(value: number): Fraction {
  return new Fraction(value);
}

/** Re-export Fraction for convenience so callers don't need a separate import. */
export { default as Fraction } from "fraction.js";
