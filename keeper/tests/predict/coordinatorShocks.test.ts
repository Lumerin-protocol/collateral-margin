import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { PredictiveCoordinator } from "../../src/predict/coordinator.ts";
import { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import type { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import type { PriceFeed } from "../../src/oracle/priceFeed.ts";
import type { ParticipantSource } from "../../src/discovery/types.ts";

const PME = "0x000000000000000000000000000000000000aa04" as Address;

describe("predict/coordinator: ShocksUpdated", () => {
  it("re-reads MM params as soon as the PME emits ShocksUpdated", async () => {
    let paramReads = 0;
    const watchers = new Map<string, (logs: unknown[]) => void>();
    const chain = {
      publicClient: {
        readContract: async () => "0x000000000000000000000000000000000000aa05",
        multicall: async () => {
          paramReads++;
          return [10n ** 17n, 5n * 10n ** 16n, 6, 6];
        },
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
          return () => watchers.delete(`${address.toLowerCase()}:${eventName ?? "*"}`);
        },
      },
    } as unknown as Chain;
    const config = {
      vault: { address: "0x000000000000000000000000000000000000aa03" },
      pme: { address: PME },
      perps: { address: "0x000000000000000000000000000000000000aa05" },
      oracle: { priceMoveTriggerBps: 0 },
    } as unknown as Config;
    const tracker = {
      onAdded: () => () => {},
      onChanged: () => () => {},
      list: () => [],
      size: () => 0,
      has: () => false,
    } as unknown as ParticipantSource;
    const priceFeed = {
      onUpdate: () => () => {},
      current: () => undefined,
    } as unknown as PriceFeed;

    const predictor = new PredictiveCoordinator(
      chain,
      config,
      tracker,
      new CoordinatorQueue(),
      { kick: () => {} } as unknown as CoordinatorExecutor,
      priceFeed,
      pino({ level: "silent" }),
    );
    try {
      await predictor.start();
      assert.equal(paramReads, 1, "startup read");

      watchers.get(`${PME.toLowerCase()}:ShocksUpdated`)?.([{}]);
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      assert.equal(paramReads, 2, "ShocksUpdated triggers an immediate re-read");
    } finally {
      predictor.stop();
    }
  });
});
