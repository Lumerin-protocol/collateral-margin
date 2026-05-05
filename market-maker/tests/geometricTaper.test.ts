import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { geometricTaperSizes } from "../src/sizing/geometricTaper.ts";

/**
 * geometricTaperSizes(totalQuantity, ratio, numLevels) distributes totalQuantity
 * across numLevels so that level k has weight ratio^k / sum(ratio^0..ratio^(N-1)).
 * Equivalent to the futures geometricTaperAllocations but operating on bigint
 * quantities directly.
 */
describe("geometricTaperSizes", () => {
  it("throws for numLevels < 1", () =>
    assert.throws(() => geometricTaperSizes(1000n, 0.5, 0), /numLevels must be >= 1/));

  it("throws for ratio <= 0", () =>
    assert.throws(() => geometricTaperSizes(1000n, 0, 4), /ratio must be in/));

  it("throws for ratio >= 1", () =>
    assert.throws(() => geometricTaperSizes(1000n, 1, 4), /ratio must be in/));

  it("returns single element equal to total for numLevels=1", () => {
    assert.deepStrictEqual(geometricTaperSizes(1000n, 0.5, 1), [1000n]);
  });

  it("returns numLevels elements", () => {
    assert.strictEqual(geometricTaperSizes(1000n, 0.5, 5).length, 5);
  });

  it("sum of sizes does not exceed totalQuantity", () => {
    for (const levels of [3, 5, 7]) {
      for (const ratio of [0.3, 0.5, 0.7]) {
        const sizes = geometricTaperSizes(100_000n, ratio, levels);
        const total = sizes.reduce((a, b) => a + b, 0n);
        assert.ok(total <= 100_000n, `sum ${total} > 100_000n (levels=${levels}, ratio=${ratio})`);
      }
    }
  });

  it("truncation loss is bounded by numLevels", () => {
    const budget = 1_000_000n;
    const levels = 5;
    const sizes = geometricTaperSizes(budget, 0.6, levels);
    const loss = budget - sizes.reduce((a, b) => a + b, 0n);
    assert.ok(loss <= BigInt(levels), `loss ${loss} > ${levels}`);
  });

  it("sizes are non-negative", () => {
    const sizes = geometricTaperSizes(1000n, 0.4, 6);
    for (const s of sizes) assert.ok(s >= 0n);
  });

  it("sizes are decreasing for ratio < 1", () => {
    const sizes = geometricTaperSizes(100_000n, 0.5, 5);
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] <= sizes[i - 1], `sizes[${i}]=${sizes[i]} > sizes[${i - 1}]=${sizes[i - 1]}`);
    }
  });

  it("ratio=0.5: first size is roughly double second size", () => {
    const sizes = geometricTaperSizes(1_000_000n, 0.5, 5);
    // w[0]/w[1] = 1/0.5 = 2 exactly; bigint floor might shift by 1
    const ratio = Number(sizes[0]) / Number(sizes[1]);
    assert.ok(ratio > 1.9 && ratio < 2.1, `ratio=${ratio}`);
  });

  it("handles zero budget", () => {
    assert.deepStrictEqual(geometricTaperSizes(0n, 0.5, 4), [0n, 0n, 0n, 0n]);
  });

  it("handles large budget", () => {
    const sizes = geometricTaperSizes(1_000_000_000_000n, 0.6, 5);
    assert.strictEqual(sizes.length, 5);
    for (const s of sizes) assert.ok(s > 0n);
  });
});
