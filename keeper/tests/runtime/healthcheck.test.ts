import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { Healthcheck } from "../../src/runtime/healthcheck.ts";
import type { Config } from "../../src/config.ts";
import type { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import type { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import type { ParticipantTracker } from "../../src/discovery/tracker.ts";
import type { PriceFeed } from "../../src/oracle/priceFeed.ts";
import type {
  PredictedThresholds,
  PredictiveCoordinator,
} from "../../src/predict/coordinator.ts";
import type { AccountHealth } from "../../src/pme/health.ts";

const silentLogger = pino({ level: "silent" });

const SIGNER: Address = "0x000000000000000000000000000000000000005C";
const STUB_CONFIG: Config = {
  chain: {
    network: "hardhat",
    rpcUrl: "http://stub",
    discoveryMode: "events",
    backfillChunkSize: 10_000n,
  },
  vault: { address: "0x0000000000000000000000000000000000000001" },
  perps: { address: "0x0000000000000000000000000000000000000002" },
  futures: { address: "0x0000000000000000000000000000000000000003" },
  pme: { address: "0x0000000000000000000000000000000000000004" },
  oracle: {
    hashpriceUsdcAddress: "0x0000000000000000000000000000000000000005",
    btcUsdcFeedAddress: "0x0000000000000000000000000000000000000006",
    priceMoveTriggerBps: 0,
  },
  keeper: {
    privateKey: "0x" + "00".repeat(32) as `0x${string}`,
    dryRun: false,
    minProfitMargin: 0n,
  },
  alerts: { dedupeMs: 0, imWarnUtilization: 0.8, imCriticalUtilization: 0.95 },
  triggers: { webhookPort: 0 },
  coordinator: { maxConcurrentAccounts: 1, confirmationBlocks: 0 },
  runtime: {
    sweepIntervalMs: 60_000,
    healthPort: 0,
    logLevel: "warn",
    balanceCheckIntervalMs: 300_000,
    balanceLowWei: 10_000_000_000_000_000n,
    balanceCriticalWei: 1_000_000_000_000_000n,
  },
  outdatedOrders: {
    sweepIntervalMs: 0,
    maxBatchSize: 50,
  },
  delivery: {
    enabled: false,
    blameSeller: true,
    sweepIntervalMs: 60_000,
    settleDelayMs: 0,
    bootstrapUsers: [],
    maxBatchSize: 50,
  },
};

interface Knobs {
  executorRunning: boolean;
  inflight: number;
  /** Tracked roster — `tracker.size()` mirrors the array length. */
  trackedList?: readonly Address[];
  /** Underwater queue, head-first. Drives `peek()` and `snapshot()`. */
  queueEntries?: ReadonlyArray<{ user: Address; mmSurplus: bigint }>;
  /** When defined, the predictor is wired with these per-user thresholds. */
  predictor?: {
    /** Per-user combined thresholds returned by `predictor.thresholds()`. */
    thresholds?: readonly PredictedThresholds[];
    /** Users with an in-flight predictive rebuild. */
    inflight?: readonly Address[];
  };
  currentPrice?: bigint;
}

function makeStubs(knobs: Knobs) {
  const trackedList = knobs.trackedList ?? [];
  const tracker = {
    size: () => trackedList.length,
    list: () => [...trackedList],
  } as unknown as ParticipantTracker;
  const executor = {
    isRunning: () => knobs.executorRunning,
    inflightCount: () => knobs.inflight,
  } as unknown as CoordinatorExecutor;
  const queueEntries = knobs.queueEntries ?? [];
  const queue = {
    size: () => queueEntries.length,
    peek: () =>
      queueEntries[0] === undefined
        ? undefined
        : ({
            user: queueEntries[0].user,
            mmSurplus: queueEntries[0].mmSurplus,
          } as AccountHealth),
    snapshot: () =>
      queueEntries.map(
        (e) => ({ user: e.user, mmSurplus: e.mmSurplus }) as AccountHealth,
      ),
  } as unknown as CoordinatorQueue;
  const predictor =
    knobs.predictor !== undefined
      ? ({
          // size/warnSize/critSize/inflight are still consumed elsewhere
          // (index.ts, predict tests). Not asserted here directly.
          size: () => knobs.predictor?.thresholds?.length ?? 0,
          warnSize: () => 0,
          critSize: () => 0,
          inflight: () => knobs.predictor?.inflight?.length ?? 0,
          inflightUsers: () => [...(knobs.predictor?.inflight ?? [])],
          thresholds: () => [...(knobs.predictor?.thresholds ?? [])],
        } as unknown as PredictiveCoordinator)
      : undefined;
  const priceFeed =
    knobs.currentPrice !== undefined
      ? ({ current: () => knobs.currentPrice } as unknown as PriceFeed)
      : undefined;
  return { config: STUB_CONFIG, tracker, executor, queue, predictor, priceFeed };
}

/** Reads the listening port back off the underlying http.Server. */
function portOf(hc: Healthcheck): number {
  const srv = (hc as unknown as { server: { address(): { port: number } } }).server;
  return srv.address().port;
}

describe("runtime/healthcheck: snapshot", () => {
  it("returns tracked / underwater / per-user predicted thresholds when wired", () => {
    const a: Address = "0x00000000000000000000000000000000000000a1";
    const b: Address = "0x00000000000000000000000000000000000000a2";
    const c: Address = "0x00000000000000000000000000000000000000a3";
    const thresholds: PredictedThresholds[] = [
      {
        user: a,
        liq: { down: "1000", up: null },
        warn: { down: "1500", up: null },
        crit: { down: "1200", up: null },
      },
      {
        user: b,
        liq: { down: null, up: null },
        warn: { down: null, up: null },
        crit: { down: "9999", up: null },
      },
    ];
    const { config, tracker, executor, queue, predictor, priceFeed } = makeStubs({
      executorRunning: true,
      inflight: 0,
      trackedList: [a, b, c],
      queueEntries: [
        { user: b, mmSurplus: -42_000_000n }, // most underwater → head
        { user: c, mmSurplus: -1_000_000n },
      ],
      predictor: { thresholds, inflight: [c] },
      currentPrice: 100_000_000n,
    });
    const hc = new Healthcheck(
      config,
      SIGNER,
      tracker,
      executor,
      queue,
      silentLogger,
      predictor,
      priceFeed,
    );
    const snap = hc.snapshot();
    assert.equal(snap.executorRunning, 1);
    assert.equal(snap.queueDepth, 2);
    assert.equal(snap.queueHeadUser, b);
    assert.equal(snap.queueHeadMmDeficit, "42000000");
    assert.equal(snap.currentPrice, "100000000");
    assert.deepEqual(snap.trackedUsers, [a, b, c]);
    assert.deepEqual(snap.underwater, [
      { user: b, mmDeficit: "42000000" },
      { user: c, mmDeficit: "1000000" },
    ]);
    assert.deepEqual(snap.predictedThresholds, thresholds);
    assert.deepEqual(snap.predictorInflight, [c]);
  });

  it("returns empty roster arrays when predictor / priceFeed are not wired", () => {
    const { config, tracker, executor, queue } = makeStubs({
      executorRunning: false,
      inflight: 0,
    });
    const hc = new Healthcheck(config, SIGNER, tracker, executor, queue, silentLogger);
    const snap = hc.snapshot();
    assert.equal(snap.executorRunning, 0);
    assert.deepEqual(snap.trackedUsers, []);
    assert.deepEqual(snap.underwater, []);
    assert.deepEqual(snap.predictedThresholds, []);
    assert.deepEqual(snap.predictorInflight, []);
    assert.equal(snap.currentPrice, null);
    assert.equal(snap.queueHeadUser, null);
    assert.equal(snap.queueHeadMmDeficit, 0);
  });
});

describe("runtime/healthcheck: info", () => {
  it("reports network, signer, and every contract address", () => {
    const { config, tracker, executor, queue } = makeStubs({
      executorRunning: true,
      inflight: 0,
    });
    const hc = new Healthcheck(config, SIGNER, tracker, executor, queue, silentLogger);
    assert.deepEqual(hc.info(), {
      network: "hardhat",
      discoveryMode: "events",
      dryRun: "false",
      signer: SIGNER,
      vault: config.vault.address,
      perps: config.perps.address,
      futures: config.futures.address,
      pme: config.pme.address,
      hashpriceUsdcFeed: config.oracle.hashpriceUsdcAddress,
      btcUsdcFeed: config.oracle.btcUsdcFeedAddress,
    });
  });
});

/**
 * `before/after` hooks would leak the http server when an assertion
 * fails before `after` runs (event loop never drains, suite hangs).
 * Use a small `withServer` helper instead so each test owns its
 * setup/teardown via try/finally.
 */
const SERVER_TRACKED: Address[] = [
  "0x00000000000000000000000000000000000000b1",
  "0x00000000000000000000000000000000000000b2",
  "0x00000000000000000000000000000000000000b3",
  "0x00000000000000000000000000000000000000b4",
  "0x00000000000000000000000000000000000000b5",
];

const SERVER_THRESHOLDS: PredictedThresholds[] = [
  {
    user: SERVER_TRACKED[0] as Address,
    liq: { down: "100", up: null },
    warn: { down: "200", up: null },
    crit: { down: "150", up: null },
  },
  {
    user: SERVER_TRACKED[2] as Address,
    liq: { down: null, up: "5000" },
    warn: { down: null, up: "4500" },
    crit: { down: null, up: "4900" },
  },
];

async function withServer<T>(
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const { config, tracker, executor, queue, predictor, priceFeed } = makeStubs({
    executorRunning: true,
    inflight: 0,
    trackedList: SERVER_TRACKED,
    queueEntries: [
      { user: SERVER_TRACKED[1] as Address, mmSurplus: -7n },
      { user: SERVER_TRACKED[3] as Address, mmSurplus: -3n },
    ],
    predictor: { thresholds: SERVER_THRESHOLDS, inflight: [] },
    currentPrice: 250_000_000n,
  });
  const hc = new Healthcheck(
    config,
    SIGNER,
    tracker,
    executor,
    queue,
    silentLogger,
    predictor,
    priceFeed,
  );
  hc.start();
  try {
    return await fn(portOf(hc));
  } finally {
    await hc.stop();
  }
}

describe("runtime/healthcheck: HTTP endpoints", () => {
  it("GET /health returns 200 with the full snapshot + info block when running", async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.status, "ok");
      assert.deepEqual(body.trackedUsers, SERVER_TRACKED);
      assert.deepEqual(body.predictedThresholds, SERVER_THRESHOLDS);
      assert.deepEqual(body.predictorInflight, []);
      assert.deepEqual(body.underwater, [
        { user: SERVER_TRACKED[1], mmDeficit: "7" },
        { user: SERVER_TRACKED[3], mmDeficit: "3" },
      ]);
      assert.equal(body.currentPrice, "250000000");
      const info = body.info as Record<string, string>;
      assert.equal(info.network, "hardhat");
      assert.equal(info.signer, SIGNER);
      assert.equal(info.vault, STUB_CONFIG.vault.address);
      assert.equal(info.perps, STUB_CONFIG.perps.address);
    });
  });

  it("GET /metrics returns Prometheus exposition with keeper_ prefix", async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      const body = await res.text();
      assert.match(body, /keeper_executor_running 1/);
      // Address-list snapshot fields collapse to their length in Prometheus.
      assert.match(body, /keeper_tracked_users 5/);
      assert.match(body, /keeper_queue_depth 2/);
      assert.match(body, /keeper_predicted_thresholds 2/);
      assert.match(body, /keeper_predictor_inflight 0/);
      assert.match(body, /keeper_oracle_price_token 250000000/);
      assert.match(body, /keeper_info\{[^}]*network="hardhat"[^}]*\} 1/);
      assert.match(body, new RegExp(`signer="${SIGNER}"`));
      assert.match(body, new RegExp(`vault="${STUB_CONFIG.vault.address}"`));
    });
  });

  it("GET to an unknown path returns 404", async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      assert.equal(res.status, 404);
    });
  });
});

describe("runtime/healthcheck: degraded executor", () => {
  it("returns 503 when the executor is stopped", async () => {
    const { config, tracker, executor, queue } = makeStubs({
      executorRunning: false,
      inflight: 0,
    });
    const hc = new Healthcheck(config, SIGNER, tracker, executor, queue, silentLogger);
    hc.start();
    const port = portOf(hc);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.status, "degraded");
    } finally {
      await hc.stop();
    }
  });

  it("/metrics omits keeper_oracle_price_token when the feed is uninitialised", async () => {
    const { config, tracker, executor, queue } = makeStubs({
      executorRunning: true,
      inflight: 0,
      predictor: { thresholds: [], inflight: [] },
    });
    // No priceFeed provided → snapshot returns currentPrice: null.
    const hc = new Healthcheck(config, SIGNER, tracker, executor, queue, silentLogger);
    hc.start();
    const port = portOf(hc);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      const body = await res.text();
      assert.doesNotMatch(body, /keeper_oracle_price_token/);
    } finally {
      await hc.stop();
    }
  });
});
