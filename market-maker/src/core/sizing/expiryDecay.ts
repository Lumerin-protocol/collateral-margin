/**
 * Scale quote size by futures expiry rank (0 = nearest).
 *
 *   scale(i) = expirySizeDecay^i
 *
 * Nearest keeps full size; each further expiry is `decay` × the previous.
 * `decay = 1` disables the schedule.
 */

import Fraction from "fraction.js";
import { toBigint } from "../rational.ts";

/** Multiplier in [0, 1] for expiry index `i` under geometric decay. */
export function expirySizeScale(expiryIndex: number, expirySizeDecay: number): number {
  if (!Number.isFinite(expiryIndex) || expiryIndex <= 0) return 1;
  if (!Number.isFinite(expirySizeDecay) || expirySizeDecay >= 1) return 1;
  if (expirySizeDecay <= 0) return 0;
  let scale = 1;
  for (let i = 0; i < expiryIndex; i++) scale *= expirySizeDecay;
  return scale;
}

/**
 * Apply a size scale to a venue-native base quantity.
 * Floors at 1 when `baseQuantity > 0` so a far expiry still quotes something.
 */
export function scaleBaseQuantity(baseQuantity: bigint, scale: number): bigint {
  if (baseQuantity <= 0n) return 0n;
  if (!Number.isFinite(scale) || scale >= 1) return baseQuantity;
  if (scale <= 0) return 1n;
  const scaled = toBigint(
    new Fraction(baseQuantity).mul(new Fraction(Math.round(scale * 1_000_000), 1_000_000)),
    1n,
    "nearest",
  );
  return scaled < 1n ? 1n : scaled;
}
