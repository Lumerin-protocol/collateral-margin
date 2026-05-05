import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OracleTracker } from "../src/oracleTracker.ts";
import type { InstrumentAdapter } from "../src/adapter.ts";

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

function makeInstrument(prices: bigint[]): InstrumentAdapter {
  let i = 0;
  return {
    id: "test",
    venue: {} as InstrumentAdapter["venue"],
    getIndexPrice: async () => prices[Math.min(i++, prices.length - 1)],
    getMinTick: async () => 1n,
    getOwnOrders: async () => [],
    getPosition: async () => ({ netQuantity: 0n, entryPrice: 0n }),
    getContext: async () => ({}),
    getOrderBookSnapshot: async () => ({ bids: [], asks: [] }),
    buildCancelCalldata: () => "0x",
    buildCreateCalldata: () => "0x",
    estimateCreateGas: async () => 0n,
  };
}

describe("OracleTracker", () => {
  it("starts with zero price and zero volatility", () => {
    const tracker = new OracleTracker(makeInstrument([0n]), makeLogger());
    assert.equal(tracker.currentPrice, 0n);
    assert.equal(tracker.volatility.valueOf(), 0);
  });

  it("updates price from instrument", async () => {
    const tracker = new OracleTracker(makeInstrument([100_000_000n]), makeLogger());
    await tracker.update();
    assert.equal(tracker.currentPrice, 100_000_000n);
  });

  it("computes non-zero volatility from varying samples", async () => {
    const prices = [100_000_000n, 101_000_000n, 99_000_000n, 102_000_000n];
    const tracker = new OracleTracker(makeInstrument(prices), makeLogger());
    for (let i = 0; i < prices.length; i++) await tracker.update();
    assert.ok(tracker.volatility.valueOf() > 0, "expected positive vol");
  });

  it("volatility is 0 with fewer than 3 samples", async () => {
    const prices = [100_000_000n, 101_000_000n];
    const tracker = new OracleTracker(makeInstrument(prices), makeLogger());
    await tracker.update();
    await tracker.update();
    assert.equal(tracker.volatility.valueOf(), 0);
  });

  it("ignores zero/negative prices in the window", async () => {
    const prices = [0n, 0n, 0n, 100_000_000n];
    const tracker = new OracleTracker(makeInstrument(prices), makeLogger());
    for (let i = 0; i < prices.length; i++) await tracker.update();
    assert.equal(tracker.volatility.valueOf(), 0);
  });
});
