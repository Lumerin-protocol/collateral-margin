import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { EthUsdFeed } from "../../src/oracle/ethUsdFeed.ts";
import type { Chain } from "../../src/chain.ts";

const FEED_ADDR: Address = "0x00000000000000000000000000000000000000F0";
const SILENT = pino({ level: "silent" });

interface FakeReads {
  /** Per-call answer queue; falls back to last entry when exhausted. */
  answers: bigint[];
  decimals?: number;
  /** Optional callbacks to simulate per-call failures. */
  failNextDecimalsRead?: boolean;
  failNextAnswerReadCount?: number;
}

function makeChain(reads: FakeReads): {
  chain: Chain;
  calls: { decimals: number; latest: number };
} {
  const calls = { decimals: 0, latest: 0 };
  const decimals = reads.decimals ?? 8;
  const chain = {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "decimals") {
          calls.decimals++;
          if (reads.failNextDecimalsRead) {
            reads.failNextDecimalsRead = false;
            throw new Error("decimals rpc failed");
          }
          return decimals;
        }
        if (functionName === "latestRoundData") {
          calls.latest++;
          if ((reads.failNextAnswerReadCount ?? 0) > 0) {
            reads.failNextAnswerReadCount =
              (reads.failNextAnswerReadCount ?? 0) - 1;
            throw new Error("latestRoundData rpc failed");
          }
          const i = Math.min(calls.latest - 1, reads.answers.length - 1);
          return [0n, reads.answers[i] as bigint, 0n, 0n, 0n] as const;
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
    },
  } as unknown as Chain;
  return { chain, calls };
}

describe("EthUsdFeed", () => {
  it("current() is undefined until the first refresh succeeds", async () => {
    const { chain } = makeChain({
      answers: [],
      failNextAnswerReadCount: 1,
      failNextDecimalsRead: false,
    });
    const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
    await feed.refresh();
    assert.equal(feed.current(), undefined);
    feed.stop();
  });

  it("populates current() and updatedAt() after a successful refresh", async () => {
    const before = Date.now();
    const { chain, calls } = makeChain({
      answers: [3000_00000000n],
      decimals: 8,
    });
    const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
    await feed.refresh();
    assert.equal(feed.current(), 3000_00000000n);
    assert.ok((feed.updatedAt() ?? 0) >= before);
    assert.equal(calls.decimals, 1);
    assert.equal(calls.latest, 1);
    feed.stop();
  });

  it("reads decimals only once and reuses it across refreshes", async () => {
    const { chain, calls } = makeChain({
      answers: [2500_00000000n, 2600_00000000n],
    });
    const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
    await feed.refresh();
    await feed.refresh();
    assert.equal(
      calls.decimals,
      1,
      "decimals are immutable on Chainlink — read once",
    );
    assert.equal(calls.latest, 2);
    feed.stop();
  });

  it("keeps the previous price when latestRoundData returns a non-positive answer", async () => {
    const { chain } = makeChain({ answers: [3000_00000000n, 0n] });
    const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
    await feed.refresh();
    await feed.refresh();
    assert.equal(
      feed.current(),
      3000_00000000n,
      "non-positive answer should NOT clobber the price",
    );
    feed.stop();
  });

  it("keeps the previous price when the RPC throws — feed is never fatal for logging", async () => {
    const { chain } = makeChain({
      answers: [3000_00000000n],
      failNextAnswerReadCount: 0,
    });
    const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
    await feed.refresh();
    chain.publicClient.readContract = async ({ functionName }) => {
      if (functionName === "decimals") return 8 as any;
      throw new Error("rpc down");
    };
    // Next refresh fails, but `current()` should still report the prior price.
    await feed.refresh();
    assert.equal(feed.current(), 3000_00000000n);
    feed.stop();
  });

  describe("weiToUsd", () => {
    it("returns undefined before the first successful refresh", () => {
      const { chain } = makeChain({ answers: [] });
      const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
      assert.equal(feed.weiToUsd(10n ** 18n), undefined);
      feed.stop();
    });

    it("converts wei to USD at the cached oracle price (8 decimals)", async () => {
      // ETH/USD = $3000 with 8 decimals → raw answer 300000000000.
      const { chain } = makeChain({ answers: [300_000_000_000n], decimals: 8 });
      const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
      await feed.refresh();
      // 1 ETH = 1e18 wei → expect 3000 USD.
      assert.equal(feed.weiToUsd(10n ** 18n), 3000);
      // 0.001 ETH = 1e15 wei → expect 3 USD.
      assert.equal(feed.weiToUsd(10n ** 15n), 3);
      feed.stop();
    });

    it("preserves sub-cent resolution for L2-cheap txs", async () => {
      // ETH/USD = $3000, 8 decimals. Realistic Base sweep gas budget:
      // 50k gas at 0.01 gwei = 5e11 wei.
      //   USD = 5e11 * 3000 / 1e18 = 1.5e-3 USD = $0.0015 (one-and-a-half mils).
      // weiToUsd returns the unrounded float; formatGasCost rounds to 6dp.
      const { chain } = makeChain({ answers: [300_000_000_000n], decimals: 8 });
      const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
      await feed.refresh();
      const usd = feed.weiToUsd(500_000_000_000n);
      assert.ok(usd !== undefined);
      // Assert via integer scaling so we're not testing fp soup.
      assert.equal(Math.round((usd as number) * 1_000_000), 1500);
      feed.stop();
    });

    it("does not round tiny tx costs to zero (sub-micro-USD is still representable)", async () => {
      // 1 gwei worth of wei at $3000/ETH = 3e-9 USD. Tiny but non-zero —
      // weiToUsd must preserve it so the rounding decision is up to the
      // log-formatting layer, not silently lost here.
      const { chain } = makeChain({ answers: [300_000_000_000n], decimals: 8 });
      const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
      await feed.refresh();
      const usd = feed.weiToUsd(10n ** 9n);
      assert.ok(usd !== undefined);
      assert.ok(
        (usd as number) > 0,
        "1 gwei equivalent should not round down to zero",
      );
      feed.stop();
    });

    it("handles non-standard oracle decimals (e.g. 18)", async () => {
      // ETH/USD = $3000 with 18 decimals → raw answer 3000e18.
      const { chain } = makeChain({
        answers: [3000n * 10n ** 18n],
        decimals: 18,
      });
      const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
      await feed.refresh();
      assert.equal(feed.weiToUsd(10n ** 18n), 3000);
      feed.stop();
    });
  });

  it("start() runs an immediate read and is idempotent", async () => {
    const { chain, calls } = makeChain({ answers: [3000_00000000n] });
    const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
    await feed.start();
    await feed.start(); // no-op
    feed.stop();
    assert.equal(calls.latest, 1, "exactly one eager read at boot");
  });

  it("stop() is idempotent", () => {
    const { chain } = makeChain({ answers: [] });
    const feed = new EthUsdFeed(chain, FEED_ADDR, SILENT, 60_000);
    feed.stop();
    feed.stop();
  });
});
