import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatUsd, parseUsd, secondsToMs } from "../../../src/core/config/units.ts";

describe("formatUsd", () => {
  it("formats whole USDC amounts", () => {
    assert.strictEqual(formatUsd(50_000_000n), "50");
    assert.strictEqual(formatUsd(0n), "0");
  });

  it("formats fractional USDC without trailing zeros", () => {
    assert.strictEqual(formatUsd(500_000n), "0.5");
    assert.strictEqual(formatUsd(1n), "0.000001");
    assert.strictEqual(formatUsd(123_456_789n), "123.456789");
  });

  it("formats negative amounts", () => {
    assert.strictEqual(formatUsd(-50_000_000n), "-50");
    assert.strictEqual(formatUsd(-500_000n), "-0.5");
  });
});

describe("parseUsd", () => {
  it("converts integer USD to 6-decimal bigint", () => {
    assert.strictEqual(parseUsd("50", 6, "x"), 50_000_000n);
    assert.strictEqual(parseUsd(50, 6, "x"), 50_000_000n);
    assert.strictEqual(parseUsd(0, 6, "x"), 0n);
  });

  it("converts decimal USD without precision loss", () => {
    assert.strictEqual(parseUsd("0.5", 6, "x"), 500_000n);
    assert.strictEqual(parseUsd("0.000001", 6, "x"), 1n);
    assert.strictEqual(parseUsd("123.456789", 6, "x"), 123_456_789n);
  });

  it("supports negative values", () => {
    assert.strictEqual(parseUsd("-50", 6, "x"), -50_000_000n);
    assert.strictEqual(parseUsd("-0.5", 6, "x"), -500_000n);
  });

  it("rejects more fractional digits than `decimals`", () => {
    assert.throws(() => parseUsd("0.0000001", 6, "x"), /too many fractional digits/);
  });

  it("rejects malformed input", () => {
    assert.throws(() => parseUsd("abc", 6, "x"), /invalid decimal/);
    assert.throws(() => parseUsd("1.2.3", 6, "x"), /invalid decimal/);
  });

  it("rejects exponent notation", () => {
    assert.throws(() => parseUsd(1e-7, 6, "x"), /exponent notation/);
  });

  it("rejects non-finite numbers", () => {
    assert.throws(() => parseUsd(Number.POSITIVE_INFINITY, 6, "x"), /non-finite/);
    assert.throws(() => parseUsd(Number.NaN, 6, "x"), /non-finite/);
  });
});

describe("secondsToMs", () => {
  it("converts integer seconds", () => {
    assert.strictEqual(secondsToMs("3", "x"), 3000);
    assert.strictEqual(secondsToMs(60, "x"), 60_000);
    assert.strictEqual(secondsToMs(0, "x"), 0);
  });

  it("converts fractional seconds without float drift", () => {
    assert.strictEqual(secondsToMs("0.1", "x"), 100);
    assert.strictEqual(secondsToMs("0.001", "x"), 1);
    assert.strictEqual(secondsToMs("1.5", "x"), 1500);
  });

  it("rejects sub-millisecond precision", () => {
    assert.throws(() => secondsToMs("0.0001", "x"), /sub-millisecond/);
  });

  it("rejects negative values", () => {
    assert.throws(() => secondsToMs("-1", "x"), /invalid non-negative seconds/);
  });
});
