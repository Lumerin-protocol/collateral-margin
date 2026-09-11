import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import type pino from "pino";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import { FuturesExpiryIndex } from "../../src/discovery/futuresExpiryIndex.ts";

const FUTURES = "0x000000000000000000000000000000000000F00d" as Address;
const SIGNER = "0x0000000000000000000000000000000000009999" as Address;
const USER_A = "0x00000000000000000000000000000000000000A1" as Address;
const USER_B = "0x00000000000000000000000000000000000000B2" as Address;
const USER_C = "0x00000000000000000000000000000000000000C3" as Address;
const DAY = 86_400n;
const ACTIVE_A = 1_000_000n;
const ACTIVE_B = ACTIVE_A + DAY;
const PREVIOUS = ACTIVE_A - DAY;

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

interface StubState {
  activeExpiries: bigint[];
  watchers: Record<string, (logs: readonly unknown[]) => void>;
}

function makeConfig(): Config {
  return {
    chain: { backfillChunkSize: 1_000n },
    futures: { address: FUTURES },
    delivery: {
      bootstrapUsers: [],
      sweepIntervalMs: 1_000_000,
    },
  } as unknown as Config;
}

function makeChain(state: StubState): Chain {
  return {
    account: { address: SIGNER },
    publicClient: {
      watchContractEvent: ({
        eventName,
        onLogs,
      }: {
        eventName: string;
        onLogs: (logs: readonly unknown[]) => void;
      }) => {
        state.watchers[eventName] = onLogs;
        return () => undefined;
      },
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (functionName === "getExpirationDates") return state.activeExpiries;
        if (functionName === "expirationIntervalDays") return 1;
        if (functionName === "futureExpirationDatesCount") return 2;
        if (functionName === "getActiveExpirationDates") return [];
        if (functionName === "getUserPosition") {
          const user = getAddress(args?.[0] as Address);
          return {
            netQuantity: user === getAddress(USER_A) ? 1n : 0n,
            netEntryValue: 1n,
          };
        }
        throw new Error(`unexpected readContract ${functionName}`);
      },
      getBlockNumber: async () => 100n,
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
        timestamp: (blockNumber ?? 100n) * 10_000n,
      }),
      getContractEvents: async ({ eventName }: { eventName: string }) => {
        if (eventName === "OrderCreated") {
          return [
            {
              blockNumber: 80n,
              logIndex: 0,
              args: { participant: USER_C, expirationAt: ACTIVE_A },
            },
          ];
        }
        if (eventName === "OrderMatched") {
          return [
            {
              blockNumber: 81n,
              logIndex: 0,
              args: {
                maker: USER_A,
                taker: USER_B,
                expirationAt: PREVIOUS,
                makerNetQtyAfter: 1n,
                takerNetQtyAfter: -1n,
              },
            },
          ];
        }
        if (eventName === "PositionSettled") {
          return [
            {
              blockNumber: 82n,
              logIndex: 0,
              args: { user: USER_B, expirationAt: PREVIOUS },
            },
          ];
        }
        return [];
      },
      multicall: async ({ contracts }: { contracts: readonly unknown[] }) =>
        contracts.map(() => ({ netQuantity: 1n, netEntryValue: 1n })),
    },
  } as unknown as Chain;
}

describe("FuturesExpiryIndex", () => {
  it("replays active and previous expiries and partitions participants", async () => {
    const state: StubState = {
      activeExpiries: [ACTIVE_A, ACTIVE_B],
      watchers: {},
    };
    const index = new FuturesExpiryIndex(
      makeChain(state),
      makeConfig(),
      silentLogger,
    );
    await index.start();

    assert.equal(index.has(USER_A), true);
    assert.equal(index.has(USER_B), true);
    assert.equal(index.has(USER_C), true);
    assert.deepEqual(index.positionEntries(), [
      { user: getAddress(USER_A), expirationAt: PREVIOUS },
    ]);
    assert.equal(index.stats().caches, 3);
    assert.equal(index.stats().replayHeadBlock, 100n);
    index.stop();
  });

  it("updates position candidates from live matches and settlements", async () => {
    const state: StubState = {
      activeExpiries: [ACTIVE_A],
      watchers: {},
    };
    const index = new FuturesExpiryIndex(
      makeChain(state),
      makeConfig(),
      silentLogger,
    );
    await index.start();

    state.watchers.OrderMatched?.([
      {
        args: {
          maker: USER_A,
          taker: USER_B,
          expirationAt: ACTIVE_A,
          makerNetQtyAfter: 2n,
          takerNetQtyAfter: -2n,
        },
      },
    ]);
    assert.equal(
      index.positionEntries().filter((entry) => entry.expirationAt === ACTIVE_A)
        .length,
      2,
    );

    state.watchers.PositionSettled?.([
      { args: { user: USER_A, expirationAt: ACTIVE_A } },
    ]);
    assert.equal(
      index
        .positionEntries()
        .some(
          (entry) =>
            entry.user === getAddress(USER_A) &&
            entry.expirationAt === ACTIVE_A,
        ),
      false,
    );
    index.stop();
  });

  it("retains an older expiry while it still has an unresolved position", async () => {
    const state: StubState = {
      activeExpiries: [ACTIVE_A],
      watchers: {},
    };
    const index = new FuturesExpiryIndex(
      makeChain(state),
      makeConfig(),
      silentLogger,
    );
    await index.start();

    state.watchers.OrderMatched?.([
      {
        args: {
          maker: USER_A,
          taker: USER_B,
          expirationAt: PREVIOUS,
          makerNetQtyAfter: 1n,
          takerNetQtyAfter: 0n,
        },
      },
    ]);
    state.activeExpiries = [ACTIVE_B];
    await index.refresh();

    assert.equal(
      index
        .positionEntries()
        .some((entry) => entry.expirationAt === PREVIOUS),
      true,
    );
    index.stop();
  });
});
