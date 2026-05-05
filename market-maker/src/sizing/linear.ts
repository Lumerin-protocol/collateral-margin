/**
 * Linear ladder sizing: level k gets (k+1) * baseQuantity.
 * level 0 = base, level 1 = 2*base, level 2 = 3*base, ...
 */
export function linearSizes(baseQuantity: bigint, numLevels: number): bigint[] {
  const out: bigint[] = [];
  for (let k = 0; k < numLevels; k++) {
    out.push(baseQuantity * BigInt(k + 1));
  }
  return out;
}
