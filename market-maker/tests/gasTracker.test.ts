import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { GasTracker, type GasTrackerConfig } from "../src/gasTracker.ts";

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

function makeConfig(overrides: Partial<GasTrackerConfig> = {}): GasTrackerConfig {
  return {
    gasSpikeThresholdPct: 200,
    gasCapMultiplier: 2.0,
    ...overrides,
  };
}

describe("GasTracker (defaults)", () => {
  it("starts with zeros and default gas-unit estimates", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    assert.equal(tracker.currentGasPrice, 0n);
    assert.equal(tracker.medianGasPrice, 0n);
    assert.equal(tracker.gasSpikePct.valueOf(), 0);
    assert.equal(tracker.isGasSpiking, false);
    assert.equal(tracker.ethPriceUsd, 0n);
    assert.equal(tracker.estimatedCreateGas, 300_000n);
    assert.equal(tracker.estimatedCancelGas, 100_000n);
  });
});

describe("GasTracker.update", () => {
  it("reads gas price and detects spike vs median", async () => {
    let i = 0;
    const prices = [
      1_000_000_000n,
      1_000_000_000n,
      1_000_000_000n,
      1_000_000_000n,
      5_000_000_000n,
    ];
    const client = { getGasPrice: async () => prices[i++] } as PublicClient;
    const tracker = new GasTracker(client, makeConfig(), makeLogger());
    for (let j = 0; j < prices.length; j++) await tracker.update();
    assert.equal(tracker.currentGasPrice, 5_000_000_000n);
    assert.ok(tracker.gasSpikePct.valueOf() > 100, "should detect spike");
    assert.equal(tracker.isGasSpiking, true);
  });

  it("reports no spike when prices are stable", async () => {
    const client = { getGasPrice: async () => 1_000_000_000n } as PublicClient;
    const tracker = new GasTracker(client, makeConfig(), makeLogger());
    for (let i = 0; i < 10; i++) await tracker.update();
    assert.equal(tracker.isGasSpiking, false);
  });

  it("handles first sample (median = 0) gracefully", async () => {
    let first = true;
    const client = {
      getGasPrice: async () => {
        if (first) {
          first = false;
          return 0n;
        }
        return 1_000_000_000n;
      },
    } as PublicClient;
    const tracker = new GasTracker(client, makeConfig(), makeLogger());
    await tracker.update();
    assert.equal(tracker.gasSpikePct.valueOf(), 0);
  });
});

describe("GasTracker.calibrate", () => {
  it("updates estimatedCreateGas on success", async () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    await tracker.calibrate(async () => 250_000n);
    assert.equal(tracker.estimatedCreateGas, 250_000n);
  });

  it("keeps defaults when estimator throws", async () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    await tracker.calibrate(async () => {
      throw new Error("no order");
    });
    assert.equal(tracker.estimatedCreateGas, 300_000n);
  });

  it("ignores zero return", async () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    await tracker.calibrate(async () => 0n);
    assert.equal(tracker.estimatedCreateGas, 300_000n);
  });
});

describe("GasTracker cost calculations", () => {
  it("returns 0 USD costs when ethPriceUsd is 0", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    assert.equal(tracker.placeCostUsd, 0n);
    assert.equal(tracker.cancelCostUsd, 0n);
    assert.equal(tracker.roundTripCostUsd, 0n);
  });

  it("computes place/cancel/round-trip USD cost", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    tracker.ethPriceUsd = 2_000_000_000n; // $2000 (6 decimals)
    tracker.currentGasPrice = 1_000_000_000n; // 1 gwei
    // 300k * 1e9 * 2e9 / 1e18 = 600_000
    assert.equal(tracker.placeCostUsd, 600_000n);
    assert.equal(tracker.cancelCostUsd, 200_000n);
    assert.equal(tracker.roundTripCostUsd, 800_000n);
    assert.equal(tracker.requoteCycleCostUsd(10), 8_000_000n);
  });
});

describe("GasTracker.cappedGasPrice", () => {
  it("uses cap when current < cap (median * multiplier)", () => {
    const tracker = new GasTracker(
      {} as never,
      makeConfig({ gasCapMultiplier: 2.0 }),
      makeLogger(),
    );
    tracker.currentGasPrice = 1_000_000_000n;
    tracker.medianGasPrice = 1_000_000_000n;
    assert.equal(tracker.cappedGasPrice(), 2_000_000_000n);
  });

  it("never below current (cap raised to current to avoid base-fee underrun)", () => {
    const tracker = new GasTracker({} as never, makeConfig({ gasCapMultiplier: 2.0 }), makeLogger());
    tracker.currentGasPrice = 10_000_000_000n;
    tracker.medianGasPrice = 1_000_000_000n;
    assert.equal(tracker.cappedGasPrice(), 10_000_000_000n);
  });

  it("returns current when median is 0", () => {
    const tracker = new GasTracker({} as never, makeConfig({ gasCapMultiplier: 2.0 }), makeLogger());
    tracker.currentGasPrice = 1_000_000_000n;
    tracker.medianGasPrice = 0n;
    assert.equal(tracker.cappedGasPrice(), 1_000_000_000n);
  });
});
