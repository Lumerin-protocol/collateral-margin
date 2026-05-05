import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realizedVolatility } from "../src/helpers.ts";

describe("realizedVolatility", () => {
  it("returns 0 for empty array", () =>
    assert.deepStrictEqual(realizedVolatility([]), { sigmaPerStep: 0 }));

  it("returns 0 for single price point", () =>
    assert.deepStrictEqual(realizedVolatility([{ date: 1000, price: 100n }]), { sigmaPerStep: 0 }));

  it("returns NaN for two prices with sample variance (division by zero)", () => {
    // 2 prices → 1 return → sample variance divides by (n-1) = 0
    const result = realizedVolatility([
      { date: 1000, price: 100n },
      { date: 2000, price: 100n },
    ]);
    assert.ok(Number.isNaN(result.sigmaPerStep));
  });

  it("returns 0 for two equal prices with population variance", () => {
    const result = realizedVolatility(
      [{ date: 1000, price: 100n }, { date: 2000, price: 100n }],
      false,
    );
    assert.strictEqual(result.sigmaPerStep, 0);
  });

  it("returns 0 for multiple equal prices", () => {
    const result = realizedVolatility([
      { date: 1000, price: 50n },
      { date: 2000, price: 50n },
      { date: 3000, price: 50n },
      { date: 4000, price: 50n },
    ]);
    assert.strictEqual(result.sigmaPerStep, 0);
  });

  it("computes non-zero volatility for varying prices", () => {
    const result = realizedVolatility([
      { date: 1000, price: 100n },
      { date: 2000, price: 110n },
      { date: 3000, price: 100n },
      { date: 4000, price: 110n },
    ]);
    assert.ok(result.sigmaPerStep > 0, `expected > 0, got ${result.sigmaPerStep}`);
  });

  it("sample variance is larger than population variance", () => {
    const prices = [
      { date: 1000, price: 100n },
      { date: 2000, price: 120n },
      { date: 3000, price: 90n },
      { date: 4000, price: 110n },
    ];
    const sample = realizedVolatility(prices, true);
    const population = realizedVolatility(prices, false);
    assert.ok(sample.sigmaPerStep > population.sigmaPerStep);
  });

  it("sorts unsorted input by date", () => {
    const sorted = realizedVolatility([
      { date: 1000, price: 100n },
      { date: 2000, price: 110n },
      { date: 3000, price: 105n },
    ]);
    const unsorted = realizedVolatility([
      { date: 3000, price: 105n },
      { date: 1000, price: 100n },
      { date: 2000, price: 110n },
    ]);
    // Within floating-point tolerance
    assert.ok(
      Math.abs(sorted.sigmaPerStep - unsorted.sigmaPerStep) < 1e-10,
      `sorted=${sorted.sigmaPerStep}, unsorted=${unsorted.sigmaPerStep}`,
    );
  });

  it("defaults to sample variance when parameter omitted", () => {
    const prices = [
      { date: 1000, price: 100n },
      { date: 2000, price: 120n },
      { date: 3000, price: 90n },
    ];
    const def = realizedVolatility(prices);
    const explicit = realizedVolatility(prices, true);
    assert.ok(Math.abs(def.sigmaPerStep - explicit.sigmaPerStep) < 1e-12);
  });

  it("throws for price <= 0", () => {
    assert.throws(() => realizedVolatility([{ date: 1000, price: 0n }]), /Invalid p\.price/);
    assert.throws(() => realizedVolatility([{ date: 1000, price: -1n }]), /Invalid p\.price/);
  });

  it("throws for invalid date (NaN)", () =>
    assert.throws(() => realizedVolatility([{ date: NaN, price: 100n }]), /Invalid p\.date/));

  it("throws for date <= 0", () => {
    assert.throws(() => realizedVolatility([{ date: 0, price: 100n }]), /Invalid p\.date/);
    assert.throws(() => realizedVolatility([{ date: -1000, price: 100n }]), /Invalid p\.date/);
  });

  it("throws for Infinity date", () =>
    assert.throws(() => realizedVolatility([{ date: Infinity, price: 100n }]), /Invalid p\.date/));

  it("handles large price values without overflow", () => {
    const result = realizedVolatility([
      { date: 1000, price: 1_000_000_000_000_000_000n },
      { date: 2000, price: 1_100_000_000_000_000_000n },
      { date: 3000, price: 1_050_000_000_000_000_000n },
    ]);
    assert.ok(Number.isFinite(result.sigmaPerStep));
    assert.ok(result.sigmaPerStep > 0);
  });
});
