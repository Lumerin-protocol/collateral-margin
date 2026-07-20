import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { PredictiveCoordinator } from "../../src/predict/coordinator.ts";
import { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import { PriceFeed } from "../../src/oracle/priceFeed.ts";
import { Notifier, type WebhookPoster } from "../../src/alert/notifier.ts";
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

interface Wired {
  setOracleAnswer: (answer: bigint) => void;
  fireAnswerUpdated: () => Promise<void>;
  fireAdded: (user: Address) => void;
  posted: Array<{ url: string; payload: unknown }>;
  predictor: PredictiveCoordinator;
  priceFeed: PriceFeed;
  notifier: Notifier;
}

/**
 * Same shape as `coordinator.test.ts` harness but the multicall handler
 * returns IM in the warn/critical band so we can assert the alert path.
 *
 * `imAtPriceTokens(price)` computes the IM the on-chain `computePortfolioIM`
 * would return for our long-1 contract @ entry $100 user, mirroring the
 * off-chain math: imRequired = stress(P) + (entry - P) for P < entry.
 * The harness drives both `imRequired` (alerts) and `mmRequired` (queue)
 * off the same formula so the predictor-→ on-chain handoff is consistent.
 */
function buildHarness({ balance, perpEntry }: { balance: bigint; perpEntry: bigint }): Wired {
  let oracleAnswer = 10_000_000_000n; // $100 at 8 decimals
  let onLogs: (() => void) | undefined;
  const PERP_QTY_DECIMALS = 6n;
  const TOKEN_DECIMALS = 6n;
  const IM_SHOCK = 10n ** 17n; // 10%

  function imAtPriceTokens(P: bigint): bigint {
    // stress for 1 contract long: |1e18| * 0.10e18 * P*1e12 / 1e36 / 1e12 = 0.10*P
    const stress = (IM_SHOCK * P) / 10n ** 18n;
    const loss = P < perpEntry ? perpEntry - P : 0n;
    return stress + loss;
  }
  function mmAtPriceTokens(P: bigint): bigint {
    const MM_SHOCK = 5n * 10n ** 16n;
    const stress = (MM_SHOCK * P) / 10n ** 18n;
    const loss = P < perpEntry ? perpEntry - P : 0n;
    return stress + loss;
  }

  const chain = {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "decimals") return 8;
        // Contract-size rebase reads (PriceFeed.start). Equal values → 1×
        // passthrough, so the streamed price stays $100 and matches the IM/MM
        // the harness derives from the same answer.
        if (functionName === "CONTRACT_SIZE_HPS_DAY") return 100n * 10n ** 12n;
        if (functionName === "ORACLE_UNIT_HPS_DAY") return 100n * 10n ** 12n;
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
        const currentPrice = oracleAnswer / 100n; // 8→6 decimals
        return contracts.map((c) => {
          switch (c.functionName) {
            case "imSpotShock":
              return IM_SHOCK;
            case "mmSpotShock":
              return 5n * 10n ** 16n;
            case "decimals":
              return Number(TOKEN_DECIMALS);
            case "QUANTITY_DECIMALS":
              return Number(PERP_QTY_DECIMALS);
            case "balanceOf":
              return balance;
            case "getUserPosition":
              return { netQuantity: 1_000_000n, aggregatedEntryPrice: perpEntry };
            case "getOrderMargin":
              return 0n;
            case "getPendingFunding":
              return 0n;
            case "getFuturesOrderMargin":
              return 0n;
            case "getActiveDeliveryDates":
              return [];
            case "computePortfolioIM":
              return imAtPriceTokens(currentPrice);
            case "computePortfolioMM":
              return mmAtPriceTokens(currentPrice);
            default:
              throw new Error(`unexpected multicall: ${c.functionName}`);
          }
        });
      },
    },
  } as unknown as Chain;

  const config = {
    oracle: {
      hashpriceUsdcAddress: HASHPRICE,
      btcUsdcFeedAddress: BTC_FEED,
      priceMoveTriggerBps: 0,
    },
    vault: { address: VAULT },
    pme: { address: PME },
    perps: { address: PERPS },
    futures: { address: FUTURES },
    alerts: {
      webhookUrl: "https://example.test/hook",
      dedupeMs: 60_000,
      imWarnUtilization: 0.85,
      imCriticalUtilization: 0.95,
    },
  } as Config;

  const queue = new CoordinatorQueue();
  const executor = { kick: () => {} } as unknown as CoordinatorExecutor;
  const addedListeners: TrackerListener[] = [];
  const tracker = {
    onAdded: (l: TrackerListener) => {
      addedListeners.push(l);
      return () => {};
    },
    onChanged: () => () => {},
    size: () => 1,
  } as unknown as ParticipantTracker;

  const posted: Array<{ url: string; payload: unknown }> = [];
  const poster: WebhookPoster = async (url, payload) => {
    posted.push({ url, payload });
  };
  const notifier = new Notifier(config, silentLogger, { poster });
  const priceFeed = new PriceFeed(chain, config, silentLogger, 6);
  const predictor = new PredictiveCoordinator(
    chain,
    config,
    tracker,
    queue,
    executor,
    priceFeed,
    silentLogger,
    notifier,
  );

  return {
    setOracleAnswer: (answer) => {
      oracleAnswer = answer;
    },
    fireAnswerUpdated: async () => {
      if (onLogs === undefined) throw new Error("watcher not registered");
      onLogs();
      // Three ticks: refresh → handlePriceUpdate → handleCrossings →
      // notifier.drain. Each `await` settles one promise hop.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
    fireAdded: (user: Address) => addedListeners.forEach((l) => void l(user)),
    posted,
    predictor,
    priceFeed,
    notifier,
  };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("predict/coordinator: predictive alerts", () => {
  it("fires a critical alert when price crosses the predicted IM-critical threshold", async () => {
    // Long, balance=$50, entry=$100. critDown ≈ $58.33.
    const harness = buildHarness({
      balance: 50_000_000n,
      perpEntry: 100_000_000n,
    });
    await harness.priceFeed.start();
    await harness.predictor.start();
    harness.fireAdded(USER);
    await settle();
    await settle();
    assert.equal(harness.predictor.critSize(), 1, "critIndex should hold the user");

    // Drop spot to $55 — below crit ($58.3), still above liq.
    harness.setOracleAnswer(5_500_000_000n);
    await harness.fireAnswerUpdated();

    assert.ok(harness.posted.length >= 1, `expected ≥1 alert posted, got ${harness.posted.length}`);
    const payload = harness.posted[0]?.payload as { severity: string };
    assert.equal(payload.severity, "critical");

    harness.predictor.stop();
    harness.priceFeed.stop();
  });

  it("fires a warn alert (not critical) when price only crosses the warn threshold", async () => {
    // Balance=$50, entry=$100. warnDown ≈ $63.9, critDown ≈ $58.3.
    const harness = buildHarness({
      balance: 50_000_000n,
      perpEntry: 100_000_000n,
    });
    await harness.priceFeed.start();
    await harness.predictor.start();
    harness.fireAdded(USER);
    await settle();
    await settle();
    assert.equal(harness.predictor.warnSize(), 1);

    // Drop to $62 — between warn and crit.
    harness.setOracleAnswer(6_200_000_000n);
    await harness.fireAnswerUpdated();

    assert.ok(harness.posted.length >= 1, `expected ≥1 alert, got ${harness.posted.length}`);
    const payload = harness.posted[0]?.payload as { severity: string };
    assert.equal(payload.severity, "warn");

    harness.predictor.stop();
    harness.priceFeed.stop();
  });

  it("does not fire alerts before the user is added (index empty)", async () => {
    const harness = buildHarness({ balance: 50_000_000n, perpEntry: 100_000_000n });
    await harness.priceFeed.start();
    await harness.predictor.start();
    // No fireAdded() — index stays empty.

    harness.setOracleAnswer(5_500_000_000n);
    await harness.fireAnswerUpdated();

    assert.equal(harness.posted.length, 0);

    harness.predictor.stop();
    harness.priceFeed.stop();
  });
});
