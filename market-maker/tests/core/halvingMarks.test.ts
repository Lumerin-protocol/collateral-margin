import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OracleTracker } from "../../src/core/oracleTracker.ts";
import type { InstrumentAdapter } from "../../src/core/adapter.ts";

/**
 * CF-321: a futures date settling after the halving is worth about half the index, and the
 * venue values it at its mark range (perps at the glide). Quotes built around the index
 * would bid about twice the date's fair price; they have to center on the instrument's mark.
 */

const ORACLE = "0xf30a6489f20630bf5b1a76f0c56aadc364d031f3" as const;
const noop = () => {};
const logger = {
  child: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
} as never;

/** An instrument whose venue values it at `mark` while the index reads `index`. */
function instrumentAt(index: bigint, mark: bigint): InstrumentAdapter {
  return {
    id: "futures-post-halving",
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
    getIndexPrice: async () => index,
    getMarkPrice: async () => mark,
    getOracleScale: async () => ({ address: ORACLE, decimals: 6 }),
    getPosition: async () => ({ netQuantity: 0n, entryPrice: 0n }),
    getContext: async () => ({}),
    encodeCreate: () => "0x",
    encodeUpdateOrders: () => "0x",
    encodeCancel: () => "0x",
    executeOrders: async () => ({ receipts: [], errors: [] }),
    estimateOrderMargin: () => 0n,
    estimateCreateGas: async () => 0n,
  } as InstrumentAdapter;
}

describe("CF-321 — quotes center on the instrument's mark", () => {
  it("prices a post-halving futures date at its mark, not the index", async () => {
    const tracker = new OracleTracker(
      instrumentAt(42_330_000n, 21_380_000n),
      logger,
    );
    await tracker.initialize();
    assert.equal(tracker.currentPrice, 21_380_000n);
  });
});
