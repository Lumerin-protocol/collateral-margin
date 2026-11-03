import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { FuturesVenueAdapter } from "../../src/adapters/futures/venue.ts";
import { PerpsVenueAdapter } from "../../src/adapters/perps/venue.ts";
import { IM_SPOT_SHOCK_REFRESH_MS } from "../../src/core/adapter.ts";

const VENUE = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const ENGINE = "0x4444444444444444444444444444444444444444" as Address;
const TOKEN = "0x5555555555555555555555555555555555555555" as Address;
const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/** A chain whose PME `imSpotShock` the test can change, as `setShocks` would. */
function makeNetwork(shock: () => bigint) {
  const publicClient = {
    multicall: async () => [VAULT, ENGINE],
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "collateralToken") return TOKEN;
      if (functionName === "imSpotShock") return shock();
      throw new Error(`unexpected readContract: ${functionName}`);
    },
    watchContractEvent: () => () => {},
  };
  return {
    publicClient,
    chain: { id: 1, name: "test" },
    transport: {},
  } as unknown as ConstructorParameters<typeof PerpsVenueAdapter>[0]["network"];
}

const wallet = {
  account: { address: "0x1111111111111111111111111111111111111111" },
} as unknown as ConstructorParameters<typeof PerpsVenueAdapter>[0]["wallet"];
const logger = pino({ level: "silent" });

const venues = {
  futures: (network: ReturnType<typeof makeNetwork>) =>
    new FuturesVenueAdapter({
      network,
      wallet,
      address: VENUE,
      multicall3Address: MC3,
      readBatchSize: 100,
      writeBatchSize: 20,
      logger,
    }),
  perps: (network: ReturnType<typeof makeNetwork>) =>
    new PerpsVenueAdapter({
      network,
      wallet,
      address: VENUE,
      multicall3Address: MC3,
      readBatchSize: 100,
      cancelBatchSize: 30,
      createBatchSize: 30,
      logger,
    }),
};

describe("venue IM spot shock refresh", () => {
  for (const [kind, build] of Object.entries(venues)) {
    it(`${kind}: picks up a setShocks IM change without a restart`, async () => {
      mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      try {
        let shock = 10n ** 17n;
        const venue = build(makeNetwork(() => shock));
        assert.equal(await venue.account.imSpotShock(), 10n ** 17n);

        shock = 15n * 10n ** 16n;
        mock.timers.tick(IM_SPOT_SHOCK_REFRESH_MS);
        assert.equal(await venue.account.imSpotShock(), 15n * 10n ** 16n);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

describe("venue IM spot shock refresh from the order-margin path", () => {
  it("futures: a stale cachedImSpotShock() starts a re-read, so quoting picks up setShocks", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    try {
      let shock = 10n ** 17n;
      const venue = venues.futures(makeNetwork(() => shock));
      await venue.fetchImSpotShock();

      shock = 15n * 10n ** 16n;
      mock.timers.tick(IM_SPOT_SHOCK_REFRESH_MS);
      venue.cachedImSpotShock();
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      assert.equal(venue.cachedImSpotShock(), 15n * 10n ** 16n);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("venue IM spot shock from ShocksUpdated", () => {
  for (const [kind, build] of Object.entries(venues)) {
    it(`${kind}: takes the new IM from ShocksUpdated at once`, async () => {
      const watchers = new Map<string, (logs: unknown[]) => void>();
      const network = makeNetwork(() => 10n ** 17n);
      Object.assign(network.publicClient, {
        watchContractEvent: ({
          address,
          eventName,
          onLogs,
        }: {
          address: Address;
          eventName?: string;
          onLogs: (logs: unknown[]) => void;
        }) => {
          watchers.set(`${address.toLowerCase()}:${eventName ?? "*"}`, onLogs);
          return () => {};
        },
      });
      const venue = build(network);
      assert.equal(await venue.fetchImSpotShock(), 10n ** 17n);

      watchers.get(`${ENGINE.toLowerCase()}:ShocksUpdated`)?.([
        {
          eventName: "ShocksUpdated",
          args: { imSpot: 15n * 10n ** 16n, mmSpot: 10n ** 17n, imVol: 10n ** 17n, mmVol: 5n * 10n ** 16n },
        },
      ]);
      assert.equal(venue.cachedImSpotShock(), 15n * 10n ** 16n);
    });
  }
});
