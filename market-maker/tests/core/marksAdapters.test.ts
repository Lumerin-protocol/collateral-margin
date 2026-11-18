import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FuturesInstrumentAdapter } from "../../src/adapters/futures/instrument.ts";
import type { FuturesVenueAdapter } from "../../src/adapters/futures/venue.ts";
import { PerpsInstrumentAdapter } from "../../src/adapters/perps/instrument.ts";
import type { PerpsVenueAdapter } from "../../src/adapters/perps/venue.ts";

/** CF-321: each adapter supplies the mark its venue values the instrument at. */

const noop = () => {};
const logger = {
  child: () => ({
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }),
} as never;
const INDEX = 42_000_000n;
const EXPIRY = 1_756_416_000n;
const SHOCK = 15n * 10n ** 16n; // 15%

function futuresAt(low: bigint, high: bigint) {
  const venue = {
    readBatchSize: 50,
    getRawMarkRange: async (expirationAt: bigint) => {
      assert.equal(expirationAt, EXPIRY);
      return [low, high] as const;
    },
    getRawMarketPrice: async () => INDEX,
    cachedMarketPrice: () => INDEX,
    cachedImSpotShock: () => SHOCK,
  } as unknown as FuturesVenueAdapter;
  return new FuturesInstrumentAdapter(venue, EXPIRY, logger);
}

describe("CF-321 — adapter marks", () => {
  it("quotes a window date at the middle of its range and charges each side at its own end", async () => {
    const instrument = futuresAt(21_000_000n, INDEX);
    assert.equal(await instrument.getMarkPrice(), 31_500_000n);
    assert.equal(await instrument.getIndexPrice(), INDEX);
    // 10 contracts at their side's mark: stress 15% of the mark, no fill loss.
    const bid = instrument.estimateOrderMargin({
      side: "buy",
      price: 21_000_000n,
      size: 10n,
    });
    const ask = instrument.estimateOrderMargin({
      side: "sell",
      price: INDEX,
      size: 10n,
    });
    assert.equal(bid, (21_000_000n * 10n * SHOCK) / 10n ** 18n);
    assert.equal(ask, (INDEX * 10n * SHOCK) / 10n ** 18n);
  });

  it("quotes perps at its mark and samples volatility from the index behind it", async () => {
    const venue = {
      getRawIndexPrice: async () => INDEX,
      getRawMarketPrice: async () => 30_000_000n,
    } as unknown as PerpsVenueAdapter;
    const instrument = new PerpsInstrumentAdapter(venue);
    assert.equal(await instrument.getIndexPrice(), INDEX);
    assert.equal(await instrument.getMarkPrice(), 30_000_000n);
  });
});
