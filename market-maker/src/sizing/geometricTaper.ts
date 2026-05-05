import Fraction from "fraction.js";
import { toBigint } from "../rational.ts";

/**
 * Geometric taper sizing: each successive level is `ratio` of the previous one.
 * The total inventory across all levels equals `totalQuantity`.
 *
 *   q_k = totalQuantity * ratio^k * (1 − ratio) / (1 − ratio^N)
 *
 * For ratio=0.5, sizes are { Q/2, Q/4, Q/8, ... }. For ratio→1, sizes flatten.
 *
 * Throws if ratio ∉ (0, 1) or numLevels < 1. Uses Fraction for exactness then
 * floors to bigint per level.
 */
export function geometricTaperSizes(totalQuantity: bigint, ratio: number, numLevels: number): bigint[] {
  if (numLevels < 1) throw new Error("numLevels must be >= 1");
  if (!(ratio > 0 && ratio < 1)) throw new Error("ratio must be in (0, 1)");
  const r = new Fraction(Math.round(ratio * 1_000_000), 1_000_000);
  const one = new Fraction(1n);
  // ratio^k
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
