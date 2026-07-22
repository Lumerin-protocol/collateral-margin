import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgeMs,
  formatDurationSec,
  formatEthAmount,
  formatPrice,
  formatTimestampMs,
  formatUsdcAmount,
} from "../../src/core/healthFormat.ts";

describe("healthFormat", () => {
  it("formats USDC with unit suffix", () => {
    assert.equal(formatUsdcAmount(1_500_000_000n), "1500 USDC");
    assert.equal(formatUsdcAmount(5_910_460_671n), "5910.460671 USDC");
  });

  it("formats ETH from wei", () => {
    assert.equal(formatEthAmount(10n ** 18n), "1 ETH");
    assert.equal(formatEthAmount(5n * 10n ** 17n), "0.5 ETH");
  });

  it("formats prices", () => {
    assert.equal(formatPrice(32_797_600n), "32.7976");
  });

  it("formats durations", () => {
    assert.equal(formatDurationSec(0), "0s");
    assert.equal(formatDurationSec(35), "35s");
    assert.equal(formatDurationSec(95), "1m 35s");
    assert.equal(formatDurationSec(3725), "1h 2m 5s");
  });

  it("formats timestamps and ages", () => {
    assert.equal(formatTimestampMs(0), "never");
    assert.equal(formatTimestampMs(1_000), "1970-01-01T00:00:01.000Z");
    assert.equal(formatAgeMs(0), "never");
    assert.equal(formatAgeMs(Date.now() - 5_000, Date.now()), "5s ago");
  });
});
