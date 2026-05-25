import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { PriceFeed, type PriceUpdate } from "../../src/oracle/priceFeed.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const HASHPRICE = "0x000000000000000000000000000000000000aa01" as Address;
const BTC_FEED = "0x000000000000000000000000000000000000aa02" as Address;

function makeConfig(): Config {
  return {
    oracle: {
      hashpriceUsdcAddress: HASHPRICE,
      btcUsdcFeedAddress: BTC_FEED,
      priceMoveTriggerBps: 0,
    },
  } as Config;
}

const silentLogger = pino({ level: "silent" });

interface ChainStub {
  chain: Chain;
  setAnswer: (answer: bigint) => void;
  fireAnswerUpdated: () => Promise<void>;
  reads: number;
}

/**
 * Stub implementing the two methods PriceFeed touches:
 *   - readContract: resolves `decimals` and `latestRoundData` for HashpriceUSD.
 *   - watchContractEvent: registers a synthetic listener; tests trigger events
 *     via `fireAnswerUpdated`.
 *
 * Returns enough of a Chain shape that PriceFeed compiles and runs against it.
 */
function makeChainStub(initialAnswer: bigint, decimals: number): ChainStub {
  let currentAnswer = initialAnswer;
  let onLogs: (() => void) | undefined;
  let reads = 0;
  const chain = {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "decimals") return decimals;
        if (functionName === "latestRoundData") {
          reads++;
          return [1n, currentAnswer, 1_000n, 1_000n, 1n] as const;
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      watchContractEvent: ({ onLogs: cb }: { onLogs: () => void }) => {
        onLogs = cb;
        return () => {
          onLogs = undefined;
        };
      },
    },
  } as unknown as Chain;
  return {
    chain,
    setAnswer: (answer) => {
      currentAnswer = answer;
    },
    fireAnswerUpdated: async () => {
      if (onLogs === undefined) throw new Error("watchContractEvent was not registered");
      onLogs();
      // The watcher dispatches `void this.refresh(...)` — yield to let the
      // promise chain run to completion before the test inspects state.
      await new Promise((r) => setTimeout(r, 0));
    },
    get reads() {
      return reads;
    },
  };
}

describe("oracle/priceFeed: lifecycle + dispatch", () => {
  it("rebases the oracle answer to token decimals on first read", async () => {
    // oracle returns 8-decimal answer ($1.00 = 100_000_000); token is 6-decimal.
    // → rescaled to 1_000_000.
    const stub = makeChainStub(100_000_000n, 8);
    const feed = new PriceFeed(stub.chain, makeConfig(), silentLogger, 6);
    await feed.start();
    assert.equal(feed.current(), 1_000_000n);
    feed.stop();
  });

  it("rejects oracles whose decimals are smaller than the token's", async () => {
    const stub = makeChainStub(1n, 4);
    const feed = new PriceFeed(stub.chain, makeConfig(), silentLogger, 6);
    await assert.rejects(feed.start(), /oracle decimals.*<.*token decimals/);
  });

  it("emits a PriceUpdate when the answer changes after an AnswerUpdated event", async () => {
    const stub = makeChainStub(100_000_000n, 8);
    const feed = new PriceFeed(stub.chain, makeConfig(), silentLogger, 6);
    await feed.start();
    const updates: PriceUpdate[] = [];
    feed.onUpdate((u) => updates.push(u));

    stub.setAnswer(110_000_000n);
    await stub.fireAnswerUpdated();

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.prev, 1_000_000n);
    assert.equal(updates[0]?.next, 1_100_000n);
    feed.stop();
  });

  it("does NOT emit a PriceUpdate when the answer is unchanged", async () => {
    const stub = makeChainStub(100_000_000n, 8);
    const feed = new PriceFeed(stub.chain, makeConfig(), silentLogger, 6);
    await feed.start();
    const updates: PriceUpdate[] = [];
    feed.onUpdate((u) => updates.push(u));

    // Same answer — no listener call.
    await stub.fireAnswerUpdated();
    assert.equal(updates.length, 0);
    feed.stop();
  });

  it("ignores non-positive answers (oracle hiccup) without notifying listeners", async () => {
    const stub = makeChainStub(100_000_000n, 8);
    const feed = new PriceFeed(stub.chain, makeConfig(), silentLogger, 6);
    await feed.start();
    const updates: PriceUpdate[] = [];
    feed.onUpdate((u) => updates.push(u));

    stub.setAnswer(0n);
    await stub.fireAnswerUpdated();
    stub.setAnswer(-1n);
    await stub.fireAnswerUpdated();
    assert.equal(updates.length, 0);
    // current() retains the last good value.
    assert.equal(feed.current(), 1_000_000n);
    feed.stop();
  });

  it("unsubscribe stops further dispatch", async () => {
    const stub = makeChainStub(100_000_000n, 8);
    const feed = new PriceFeed(stub.chain, makeConfig(), silentLogger, 6);
    await feed.start();
    const updates: PriceUpdate[] = [];
    const unsubscribe = feed.onUpdate((u) => updates.push(u));

    stub.setAnswer(110_000_000n);
    await stub.fireAnswerUpdated();
    assert.equal(updates.length, 1);

    unsubscribe();
    stub.setAnswer(120_000_000n);
    await stub.fireAnswerUpdated();
    assert.equal(updates.length, 1, "should not have received second update after unsubscribe");
    feed.stop();
  });
});
