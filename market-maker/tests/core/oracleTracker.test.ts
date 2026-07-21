import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Fraction from "fraction.js";
import { OracleTracker } from "../../src/core/oracleTracker.ts";
import type { InstrumentAdapter } from "../../src/core/adapter.ts";
import type {
  HistoricalPriceSource,
  PricePoint,
} from "../../src/core/historicalPriceSource.ts";

const noop = () => {};
function makeLogger(): never {
  return {
    child: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
  } as never;
}

function makeInstrument(prices: bigint[]): InstrumentAdapter {
  let i = 0;
  return {
    id: "test",
    venue: {} as InstrumentAdapter["venue"],
    book: {
      tick: async () => 1n,
      snapshot: async () => ({ bids: [], asks: [] }),
    },
    ownOrders: {
      list: async () => [],
      subscribe: () => () => {},
      bootstrap: async () => {},
    },
    getIndexPrice: async () => prices[Math.min(i++, prices.length - 1)],
    getPosition: async () => ({ netQuantity: 0n, entryPrice: 0n }),
    getContext: async () => ({}),
    encodeCreate: () => "0x",
    encodeUpdateOrders: () => "0x",
    encodeCancel: () => "0x",
    executeOrders: async () => ({ receipts: [], errors: [] }),
    estimateOrderMargin: () => 0n,
    estimateCreateGas: async () => 0n,
    createCallWeight: () => 1,
  };
}

function makeHistory(points: PricePoint[]): HistoricalPriceSource {
  return { fetch: async () => points };
}

/** A monotonically advancing clock so successive updates produce distinct timestamps. */
function makeClock(stepSec = 1): () => number {
  let t = 1_700_000_000;
  return () => {
    const out = t;
    t += stepSec;
    return out;
  };
}

/**
 * `volatilityPerSecond` accumulates a Fraction with very large numerator and
 * denominator (sqrt at 48-bit precision); a naive `.valueOf()` overflows to
 * Infinity/Infinity = NaN. `simplify` collapses the magnitude before the cast.
 */
function fracVal(f: Fraction): number {
  return f.simplify(1e-12).valueOf();
}

describe("OracleTracker", () => {
  it("starts with zero price and zero per-second volatility", () => {
    const tracker = new OracleTracker(makeInstrument([0n]), makeLogger());
    assert.equal(tracker.currentPrice, 0n);
    assert.equal(fracVal(tracker.volatilityPerSecond), 0);
  });

  it("updates price from instrument", async () => {
    const tracker = new OracleTracker(
      makeInstrument([100_000_000n]),
      makeLogger(),
    );
    await tracker.update();
    assert.equal(tracker.currentPrice, 100_000_000n);
  });

  it("computes non-zero per-second volatility from varying samples", async () => {
    const prices = [100_000_000n, 101_000_000n, 99_000_000n, 102_000_000n];
    const tracker = new OracleTracker(makeInstrument(prices), makeLogger(), {
      nowSec: makeClock(),
    });
    for (let i = 0; i < prices.length; i++) await tracker.update();
    assert.ok(
      fracVal(tracker.volatilityPerSecond) > 0,
      "expected positive per-second vol",
    );
  });

  it("volatility is 0 with fewer than 3 samples", async () => {
    const prices = [100_000_000n, 101_000_000n];
    const tracker = new OracleTracker(makeInstrument(prices), makeLogger(), {
      nowSec: makeClock(),
    });
    await tracker.update();
    await tracker.update();
    assert.equal(fracVal(tracker.volatilityPerSecond), 0);
  });

  it("ignores zero/negative prices in the window", async () => {
    const prices = [0n, 0n, 0n, 100_000_000n];
    const tracker = new OracleTracker(makeInstrument(prices), makeLogger(), {
      nowSec: makeClock(),
    });
    for (let i = 0; i < prices.length; i++) await tracker.update();
    assert.equal(fracVal(tracker.volatilityPerSecond), 0);
  });

  it("de-duplicates repeat polls so an unchanging oracle does not bias σ to 0", async () => {
    // The oracle returns the same value 6 times in a row, then ticks twice.
    // Old behaviour pushed all 8 polls and built 7 zero-returns plus 1 nonzero;
    // new behaviour pushes only the 3 distinct prices, so σ is computed from
    // 2 nonzero log returns rather than 7 zeros.
    const prices = [100n, 100n, 100n, 100n, 100n, 100n, 110n, 90n];
    const tracker = new OracleTracker(makeInstrument(prices), makeLogger(), {
      nowSec: makeClock(),
    });
    for (let i = 0; i < prices.length; i++) await tracker.update();
    assert.ok(
      fracVal(tracker.volatilityPerSecond) > 0,
      "expected positive σ — duplicates should not crowd the window",
    );
  });

  it("backfills the window from a historical source on initialize()", async () => {
    // Prices change every step, so the per-step log returns are all non-trivial
    // and σ is well above zero after backfill alone.
    const now = 1_700_000_000;
    const history = makeHistory([
      { timestampSec: now - 30, price: 100n },
      { timestampSec: now - 20, price: 110n },
      { timestampSec: now - 10, price: 95n },
      { timestampSec: now - 5, price: 105n },
    ]);
    const tracker = new OracleTracker(makeInstrument([105n]), makeLogger(), {
      history,
      pollIntervalMs: 10_000,
      windowSize: 60,
      // Live tick lands ~5s after the last backfilled sample so it pushes too.
      nowSec: () => now,
    });
    await tracker.initialize();
    assert.ok(
      fracVal(tracker.volatilityPerSecond) > 0,
      `expected positive σ after backfill, got ${fracVal(tracker.volatilityPerSecond)}`,
    );
  });

  it("backfill failures fall back gracefully to live warm-up", async () => {
    const failing: HistoricalPriceSource = {
      fetch: async () => {
        throw new Error("subgraph unavailable");
      },
    };
    const tracker = new OracleTracker(makeInstrument([100n]), makeLogger(), {
      history: failing,
      pollIntervalMs: 1000,
      nowSec: makeClock(),
    });
    // initialize() must not throw even when backfill errors out — startup is
    // not allowed to depend on the subgraph being reachable.
    await tracker.initialize();
    assert.equal(tracker.currentPrice, 100n);
    assert.equal(fracVal(tracker.volatilityPerSecond), 0);
  });
});
