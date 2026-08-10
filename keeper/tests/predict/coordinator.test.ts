import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { PredictiveCoordinator } from "../../src/predict/coordinator.ts";
import { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import { PriceFeed } from "../../src/oracle/priceFeed.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import type { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import type { ParticipantTracker, TrackerListener } from "../../src/discovery/tracker.ts";

const HASHPRICE = "0x000000000000000000000000000000000000aa01" as Address;
const BTC_FEED = "0x000000000000000000000000000000000000aa02" as Address;
const VAULT = "0x000000000000000000000000000000000000aa03" as Address;
const PME = "0x000000000000000000000000000000000000aa04" as Address;
const PERPS = "0x000000000000000000000000000000000000aa05" as Address;
const FUTURES = "0x000000000000000000000000000000000000aa06" as Address;

const USER = "0x1111111111111111111111111111111111111111" as Address;

const silentLogger = pino({ level: "silent" });

function makeConfig(priceMoveTriggerBps = 0): Config {
  return {
    oracle: {
      hashpriceUsdcAddress: HASHPRICE,
      btcUsdcFeedAddress: BTC_FEED,
      priceMoveTriggerBps,
    },
    vault: { address: VAULT },
    pme: { address: PME },
    perps: { address: PERPS },
    futures: { address: FUTURES },
  } as Config;
}

interface Wired {
  chain: Chain;
  config: Config;
  tracker: {
    instance: ParticipantTracker;
    fireAdded: (user: Address) => void;
    fireChanged: (user: Address) => void;
  };
  queue: CoordinatorQueue;
  executor: { instance: CoordinatorExecutor; kicks: number };
  priceFeed: PriceFeed;
  setOracleAnswer: (answer: bigint) => void;
  fireAnswerUpdated: () => Promise<void>;
}

/**
 * Builds the full predictive stack against in-memory stubs:
 *   - Chain stub: routes `readContract` and `multicall` to scripted handlers.
 *   - Tracker stub: only `onAdded` / `onChanged` / `size` are exercised.
 *   - Executor stub: counts `kick()` invocations.
 *
 * The test harness has scripted answers for each PME / venue method the
 * snapshot reader and health reader call, so the predictor exercises its
 * full path end-to-end without touching a real RPC.
 */
function buildHarness({
  balance,
  perpNetQty,
  perpEntry,
  underwaterAtPrice,
}: {
  balance: bigint;
  perpNetQty: bigint;
  perpEntry: bigint;
  /**
   * The fake on-chain `computePortfolioMM` returns `balance + 1` (i.e. 1 wei
   * underwater) when the latest spot is at or below this price; otherwise
   * `balance - 1` (1 wei healthy). Lets us script the planner to flip on a
   * specific tick.
   */
  underwaterAtPrice: bigint;
}): Wired {
  // Mutable "current price" is what `latestRoundData` returns; the harness
  // also uses it to decide what `computePortfolioMM` returns (above logic).
  // Default $100 at 8 decimals → token-decimal (6) price = 100_000_000.
  let oracleAnswer = 10_000_000_000n;
  let onLogs: (() => void) | undefined;

  const chain = {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "collateralToken") {
          return "0x000000000000000000000000000000000000aa05";
        }
        if (functionName === "decimals") return 8;
        if (functionName === "latestRoundData") {
          return [1n, oracleAnswer, 1_000n, 1_000n, 1n] as const;
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      watchContractEvent: ({ onLogs: cb }: { onLogs: () => void }) => {
        onLogs = cb;
        return () => {
          onLogs = undefined;
        };
      },
      multicall: async ({ contracts }: { contracts: readonly { functionName: string }[] }) => {
        // The harness inspects `functionName` on each contract and assembles
        // a matching response array. Snapshot-read calls and health-read
        // calls share the same multicall path, so one handler covers both.
        return contracts.map((c) => {
          switch (c.functionName) {
            case "imSpotShock":
              return 10n ** 17n;
            case "mmSpotShock":
              return 5n * 10n ** 16n;
            case "decimals":
              return 6;
            case "QUANTITY_DECIMALS":
              return 6;
            case "balanceOf":
              return balance;
            case "getUserPosition":
              return {
                netQuantity: perpNetQty,
                netEntryValue: (perpNetQty * perpEntry) / 1_000_000n,
              };
            case "getRiskView":
              return {
                netPositionDelta: 0n,
                unrealizedPnl: 0n,
                pendingFunding: 0n,
                buyOrderDelta: 0n,
                sellOrderDelta: 0n,
                buyOrderFillLoss: 0n,
                sellOrderFillLoss: 0n,
              };
            case "getOrderAggregate":
              return { buyQty: 0n, sellQty: 0n, buyValue: 0n, sellValue: 0n };
            case "getOrderAggregateAtExpiration":
              return { buyQty: 0n, sellQty: 0n, buyValue: 0n, sellValue: 0n };
            case "getActiveExpirationDates":
              return [];
            case "getExpirationDates":
              return [];
            case "computePortfolioIM":
              return balance / 2n;
            case "computePortfolioMM": {
              // Token-decimal current price: oracleAnswer / 100 (8 → 6 dec).
              const currentPriceTokens = oracleAnswer / 100n;
              return currentPriceTokens <= underwaterAtPrice ? balance + 1n : balance - 1n;
            }
            default:
              throw new Error(`unexpected multicall functionName: ${c.functionName}`);
          }
        });
      },
    },
  } as unknown as Chain;

  const config = makeConfig();
  const queue = new CoordinatorQueue();

  let kicks = 0;
  const executor = {
    instance: { kick: () => void kicks++ } as unknown as CoordinatorExecutor,
    get kicks() {
      return kicks;
    },
  };

  const addedListeners: TrackerListener[] = [];
  const changedListeners: TrackerListener[] = [];
  const tracker = {
    instance: {
      onAdded: (l: TrackerListener) => {
        addedListeners.push(l);
        return () => {};
      },
      onChanged: (l: TrackerListener) => {
        changedListeners.push(l);
        return () => {};
      },
      size: () => 1,
    } as unknown as ParticipantTracker,
    fireAdded: (user: Address) => addedListeners.forEach((l) => void l(user)),
    fireChanged: (user: Address) => changedListeners.forEach((l) => void l(user)),
  };

  const priceFeed = new PriceFeed(chain, config, silentLogger, 6);

  return {
    chain,
    config,
    tracker,
    queue,
    executor,
    priceFeed,
    setOracleAnswer: (answer) => {
      oracleAnswer = answer;
    },
    fireAnswerUpdated: async () => {
      if (onLogs === undefined) throw new Error("watcher not registered");
      onLogs();
      // Allow the chain of `void this.refresh(...)` → listeners → async
      // `enqueueCrossed` to settle. Two ticks is empirically enough.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("predict/coordinator: end-to-end", () => {
  it("on price drop crossing a user's threshold, enqueues them and kicks the executor", async () => {
    // Long position with balance=$20, entry=$100, qty=1. mmShock=5%.
    // Predicted liquidation price ≈ $84.21 (≈ 84_210_526 in 6-decimal tokens).
    // Drop oracle from $100 → $80.
    const harness = buildHarness({
      balance: 20_000_000n,
      perpNetQty: 1n * 10n ** 6n,
      perpEntry: 100_000_000n,
      // Underwater whenever spot ≤ $84 → 84_000_000n (token decimals).
      underwaterAtPrice: 84_000_000n,
    });

    await harness.priceFeed.start();
    const predictor = new PredictiveCoordinator(
      harness.chain,
      harness.config,
      harness.tracker.instance,
      harness.queue,
      harness.executor.instance,
      harness.priceFeed,
      silentLogger,
    );
    await predictor.start();

    // Add the user — predictor will read their snapshot and index thresholds.
    harness.tracker.fireAdded(USER);
    // Let the rebuild run.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(predictor.size(), 1, "user should be indexed after rebuild");

    // Drop oracle to $80 — well below the predicted threshold (~$84.21).
    harness.setOracleAnswer(8_000_000_000n);
    await harness.fireAnswerUpdated();

    assert.equal(harness.queue.size(), 1, "user should land in the coordinator queue");
    assert.equal(harness.queue.peek()?.user, USER);
    assert.ok(harness.executor.kicks >= 1, "executor should have been kicked");

    predictor.stop();
    harness.priceFeed.stop();
  });

  it("does not enqueue if on-chain mmSurplus is still healthy (model drift safety net)", async () => {
    // Same setup but `underwaterAtPrice` is $50 — even though the predictor
    // says we crossed at $84.21, the on-chain truth says still healthy.
    const harness = buildHarness({
      balance: 20_000_000n,
      perpNetQty: 1n * 10n ** 6n,
      perpEntry: 100_000_000n,
      underwaterAtPrice: 50_000_000n,
    });
    await harness.priceFeed.start();
    const predictor = new PredictiveCoordinator(
      harness.chain,
      harness.config,
      harness.tracker.instance,
      harness.queue,
      harness.executor.instance,
      harness.priceFeed,
      silentLogger,
    );
    await predictor.start();

    harness.tracker.fireAdded(USER);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    harness.setOracleAnswer(8_000_000_000n);
    await harness.fireAnswerUpdated();

    // Predictor crossed thresholds (the 1 RPC was spent), but the queue
    // upsert dropped the snapshot since `mmSurplus >= 0`.
    assert.equal(harness.queue.size(), 0);

    predictor.stop();
    harness.priceFeed.stop();
  });

  it("respects priceMoveTriggerBps — sub-threshold ticks skip evaluation", async () => {
    const harness = buildHarness({
      balance: 20_000_000n,
      perpNetQty: 1n * 10n ** 6n,
      perpEntry: 100_000_000n,
      underwaterAtPrice: 84_000_000n,
    });
    // Override config to require ≥ 100 bps move (1%).
    harness.config.oracle.priceMoveTriggerBps = 100;

    await harness.priceFeed.start();
    const predictor = new PredictiveCoordinator(
      harness.chain,
      harness.config,
      harness.tracker.instance,
      harness.queue,
      harness.executor.instance,
      harness.priceFeed,
      silentLogger,
    );
    await predictor.start();
    harness.tracker.fireAdded(USER);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // 0.5% move ($100 → $99.50) — below the 1% trigger.
    harness.setOracleAnswer(9_950_000_000n);
    await harness.fireAnswerUpdated();
    assert.equal(harness.queue.size(), 0);
    assert.equal(harness.executor.kicks, 0);

    predictor.stop();
    harness.priceFeed.stop();
  });
});
