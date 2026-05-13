import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { Healthcheck } from "../../src/runtime/healthcheck.ts";
import type { Config } from "../../src/config.ts";
import type { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import type { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import type { ParticipantTracker } from "../../src/discovery/tracker.ts";
import type { PriceFeed } from "../../src/oracle/priceFeed.ts";
import type { PredictiveCoordinator } from "../../src/predict/coordinator.ts";

const silentLogger = pino({ level: "silent" });

interface Knobs {
  executorRunning: boolean;
  trackedUsers: number;
  inflight: number;
  queueDepth: number;
  predictedUsers?: number;
  predictorInflight?: number;
  currentPrice?: bigint;
}

function makeStubs(knobs: Knobs) {
  const config = { runtime: { healthPort: 0 } } as Config; // 0 = ephemeral port
  const tracker = { size: () => knobs.trackedUsers } as unknown as ParticipantTracker;
  const executor = {
    isRunning: () => knobs.executorRunning,
    inflightCount: () => knobs.inflight,
  } as unknown as CoordinatorExecutor;
  const queue = { size: () => knobs.queueDepth } as unknown as CoordinatorQueue;
  const predictor =
    knobs.predictedUsers !== undefined
      ? ({
          size: () => knobs.predictedUsers ?? 0,
          warnSize: () => 0,
          critSize: () => 0,
          inflight: () => knobs.predictorInflight ?? 0,
        } as unknown as PredictiveCoordinator)
      : undefined;
  const priceFeed =
    knobs.currentPrice !== undefined
      ? ({ current: () => knobs.currentPrice } as unknown as PriceFeed)
      : undefined;
  return { config, tracker, executor, queue, predictor, priceFeed };
}

/** Reads the listening port back off the underlying http.Server. */
function portOf(hc: Healthcheck): number {
  const srv = (hc as unknown as { server: { address(): { port: number } } }).server;
  return srv.address().port;
}

describe("runtime/healthcheck: snapshot", () => {
  it("includes the predictor + priceFeed when wired", () => {
    const { config, tracker, executor, queue, predictor, priceFeed } = makeStubs({
      executorRunning: true,
      trackedUsers: 3,
      inflight: 0,
      queueDepth: 1,
      predictedUsers: 2,
      predictorInflight: 1,
      currentPrice: 100_000_000n,
    });
    const hc = new Healthcheck(config, tracker, executor, queue, silentLogger, predictor, priceFeed);
    const snap = hc.snapshot();
    assert.equal(snap.executorRunning, 1);
    assert.equal(snap.trackedUsers, 3);
    assert.equal(snap.queueDepth, 1);
    assert.equal(snap.predictedUsers, 2);
    assert.equal(snap.predictorInflight, 1);
    assert.equal(snap.currentPrice, "100000000");
  });

  it("zero-fills predictor metrics when not wired (legacy boot path)", () => {
    const { config, tracker, executor, queue } = makeStubs({
      executorRunning: false,
      trackedUsers: 0,
      inflight: 0,
      queueDepth: 0,
    });
    const hc = new Healthcheck(config, tracker, executor, queue, silentLogger);
    const snap = hc.snapshot();
    assert.equal(snap.executorRunning, 0);
    assert.equal(snap.predictedUsers, 0);
    assert.equal(snap.predictorInflight, 0);
    assert.equal(snap.currentPrice, null);
  });
});

/**
 * `before/after` hooks would leak the http server when an assertion
 * fails before `after` runs (event loop never drains, suite hangs).
 * Use a small `withServer` helper instead so each test owns its
 * setup/teardown via try/finally.
 */
async function withServer<T>(
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const { config, tracker, executor, queue, predictor, priceFeed } = makeStubs({
    executorRunning: true,
    trackedUsers: 5,
    inflight: 0,
    queueDepth: 2,
    predictedUsers: 4,
    predictorInflight: 0,
    currentPrice: 250_000_000n,
  });
  const hc = new Healthcheck(config, tracker, executor, queue, silentLogger, predictor, priceFeed);
  hc.start();
  try {
    return await fn(portOf(hc));
  } finally {
    await hc.stop();
  }
}

describe("runtime/healthcheck: HTTP endpoints", () => {
  it("GET /health returns 200 with the snapshot when executor is running", async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.status, "ok");
      assert.equal(body.trackedUsers, 5);
      assert.equal(body.predictedUsers, 4);
      assert.equal(body.currentPrice, "250000000");
    });
  });

  it("GET /metrics returns Prometheus exposition with keeper_ prefix", async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      const body = await res.text();
      assert.match(body, /keeper_executor_running 1/);
      assert.match(body, /keeper_tracked_users 5/);
      assert.match(body, /keeper_queue_depth 2/);
      assert.match(body, /keeper_predicted_users 4/);
      assert.match(body, /keeper_oracle_price_token 250000000/);
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
      trackedUsers: 0,
      inflight: 0,
      queueDepth: 0,
    });
    const hc = new Healthcheck(config, tracker, executor, queue, silentLogger);
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
      trackedUsers: 0,
      inflight: 0,
      queueDepth: 0,
      predictedUsers: 0,
    });
    // No priceFeed provided → snapshot returns currentPrice: null.
    const hc = new Healthcheck(config, tracker, executor, queue, silentLogger);
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
