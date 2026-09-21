/**
 * # Geometric-taper sizing
 *
 * Each successive level is `ratio` of the previous one. Total inventory
 * across all levels equals `totalQuantity`.
 *
 *   q_k = totalQuantity · ratio^k · (1 − ratio) / (1 − ratio^N)
 *
 * The `(1 − ratio) / (1 − ratio^N)` factor normalises so that Σq_k = totalQuantity
 * (geometric series sum). For ratio = 0.5 the sizes are
 *   { Q/2, Q/4, Q/8, ... } / (1 − 0.5^N) ≈ { Q/2, Q/4, Q/8, ... }
 * for large N. As ratio → 1 sizes flatten toward Q/N each.
 *
 * Used on futures multi-level books — every level needs a distinct fill
 * probability profile, and the front level should be the largest because it
 * has the highest hit rate.
 *
 * ## Edge cases
 *
 *   ratio = 0  → throws (degenerate; only level 0 has any size)
 *   ratio = 1  → throws (geometric-series formula divides by zero;
 *                use linearSizes if you want flat)
 *   numLevels < 1 → throws
 *
 * ## Worked example
 *
 *   totalQuantity = 600_000_000 (600 USDC), ratio = 0.6, numLevels = 4.
 *
 *   powers = { 1, 0.6, 0.36, 0.216 }
 *   denom  = 2.176
 *   q_0    = 600M · 1     / 2.176 ≈ 275_735_294
 *   q_1    = 600M · 0.6   / 2.176 ≈ 165_441_176
 *   q_2    = 600M · 0.36  / 2.176 ≈  99_264_705
 *   q_3    = 600M · 0.216 / 2.176 ≈  59_558_823
 *   sum    = 599_999_998 (rounds to total within 1 unit per level)
 */

import Fraction from "fraction.js";
import { toBigint } from "../rational.ts";

export function geometricTaperSizes(totalQuantity: bigint, ratio: number, numLevels: number): bigint[] {
  if (numLevels < 1) throw new Error("numLevels must be >= 1");
  if (!(ratio > 0 && ratio < 1)) throw new Error("ratio must be in (0, 1)");
  const r = new Fraction(Math.round(ratio * 1_000_000), 1_000_000);
  const one = new Fraction(1n);
  // ratio^k for k in [0, numLevels)
  const powers: Fraction[] = [];
  let p = one;
  for (let k = 0; k < numLevels; k++) {
    powers.push(p);
    p = p.mul(r);
  }
  let denom = new Fraction(0n);
  for (const x of powers) denom = denom.add(x);
  const totalQ = new Fraction(totalQuantity);
  const out: bigint[] = [];
  for (const pk of powers) {
    const qFrac = totalQ.mul(pk).div(denom);
    out.push(toBigint(qFrac, 1n, "floor"));
  }
  return out;
}
