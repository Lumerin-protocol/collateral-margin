import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Fraction from "fraction.js";
import { OracleTracker } from "../../src/core/oracleTracker.ts";
import type { InstrumentAdapter } from "../../src/core/adapter.ts";
import type {
  HistoricalPriceSource,
  PricePoint,
} from "../../src/core/historicalPriceSource.ts";

/** Aggregator both the live oracle mock and the history mock claim by default. */
const ORACLE = "0xf30a6489f20630bf5b1a76f0c56aadc364d031f3" as const;
/** Collateral-token decimals, i.e. the scale `getIndexPrice()` answers in. */
const TOKEN_DECIMALS = 6;

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
    getOracleScale: async () => ({ address: ORACLE, decimals: TOKEN_DECIMALS }),
    getPosition: async () => ({ netQuantity: 0n, entryPrice: 0n }),
    getContext: async () => ({}),
    encodeCreate: () => "0x",
    encodeUpdateOrders: () => "0x",
    encodeCancel: () => "0x",
    executeOrders: async () => ({ receipts: [], errors: [] }),
    estimateOrderMargin: () => 0n,
    estimateCreateGas: async () => 0n,
  };
}

function makeHistory(
  points: PricePoint[],
  opts: { address?: `0x${string}`; decimals?: number } = {},
): HistoricalPriceSource {
  return {
    fetch: async () => ({
      address: opts.address ?? ORACLE,
      decimals: opts.decimals ?? TOKEN_DECIMALS,
      points,
    }),
  };
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

  it("rebases historical samples from the source's decimals onto the live scale", async () => {
    // The subgraph serves the aggregator's 8-decimal answer; live reads arrive
    // rebased to 6-decimal token units. Unrebased, the join between the two
    // contributes ln(1/100) and σ explodes to ~0.45.
    const now = 1_700_000_000;
    const history = makeHistory(
      [
        { timestampSec: now - 900, price: 4_100_000_000n },
        { timestampSec: now - 600, price: 4_095_000_000n },
        { timestampSec: now - 300, price: 4_102_000_000n },
        { timestampSec: now - 30, price: 4_094_000_000n },
      ],
      { decimals: 8 },
    );
    const tracker = new OracleTracker(makeInstrument([40_969_000n]), makeLogger(), {
      history,
      windowSize: 60,
      nowSec: () => now,
    });
    await tracker.initialize();

    const sigma = fracVal(tracker.volatilityPerSecond);
    assert.ok(sigma > 0, "expected the backfill to be used, got σ = 0");
    assert.ok(sigma < 1e-3, `expected σ from a single-scale window, got ${sigma}`);
  });

  it("skips a backfill indexed from a different aggregator", async () => {
    const now = 1_700_000_000;
    const history = makeHistory(
      [
        { timestampSec: now - 300, price: 4_100_000_000n },
        { timestampSec: now - 200, price: 4_095_000_000n },
        { timestampSec: now - 100, price: 4_102_000_000n },
      ],
      { address: "0x1111111111111111111111111111111111111111", decimals: 8 },
    );
    const tracker = new OracleTracker(makeInstrument([40_969_000n]), makeLogger(), {
      history,
      windowSize: 60,
      nowSec: () => now,
    });
    await tracker.initialize();

    assert.equal(tracker.currentPrice, 40_969_000n);
    assert.equal(fracVal(tracker.volatilityPerSecond), 0);
  });

  it("matches the aggregator address case-insensitively", async () => {
    const now = 1_700_000_000;
    const history = makeHistory(
      [
        { timestampSec: now - 900, price: 4_100_000_000n },
        { timestampSec: now - 600, price: 4_095_000_000n },
        { timestampSec: now - 300, price: 4_102_000_000n },
        { timestampSec: now - 30, price: 4_094_000_000n },
      ],
      { address: ORACLE.toUpperCase().replace("0X", "0x") as `0x${string}`, decimals: 8 },
    );
    const tracker = new OracleTracker(makeInstrument([40_969_000n]), makeLogger(), {
      history,
      windowSize: 60,
      nowSec: () => now,
    });
    await tracker.initialize();
    assert.ok(fracVal(tracker.volatilityPerSecond) > 0, "expected the backfill to be used");
  });

  it("sizes the backfill from windowSize alone, bounded by historyMaxAgeSec", async () => {
    // The window de-duplicates, so it holds `windowSize` oracle updates
    // whatever the poll cadence — poll interval must play no part here.
    let seen: { maxPoints: number; maxAgeSec: number } | null = null;
    const history: HistoricalPriceSource = {
      fetch: async (opts) => {
        seen = opts;
        return { address: ORACLE, decimals: TOKEN_DECIMALS, points: [] };
      },
    };
    const tracker = new OracleTracker(makeInstrument([100n]), makeLogger(), {
      history,
      windowSize: 45,
      historyMaxAgeSec: 7200,
      nowSec: makeClock(),
    });
    await tracker.initialize();
    assert.deepEqual(seen, { maxPoints: 45, maxAgeSec: 7200 });
  });

  it("backfill failures fall back gracefully to live warm-up", async () => {
    const failing: HistoricalPriceSource = {
      fetch: async () => {
        throw new Error("subgraph unavailable");
      },
    };
    const tracker = new OracleTracker(makeInstrument([100n]), makeLogger(), {
      history: failing,
      nowSec: makeClock(),
    });
    // initialize() must not throw even when backfill errors out — startup is
    // not allowed to depend on the subgraph being reachable.
    await tracker.initialize();
    assert.equal(tracker.currentPrice, 100n);
    assert.equal(fracVal(tracker.volatilityPerSecond), 0);
  });
});
