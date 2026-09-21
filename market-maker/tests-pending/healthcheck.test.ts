import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HealthCheck } from "../src/healthcheck.ts";
import type { MakerConfig } from "../src/config.ts";
import type { OracleTracker } from "../src/oracleTracker.ts";
import type { InventoryManager } from "../src/inventoryManager.ts";
import type { BookTracker } from "../src/bookTracker.ts";
import type { GasTracker } from "../src/gasTracker.ts";
import type { RiskManager } from "../src/riskManager.ts";
import pino from "pino";

const noop = () => {};
function makeLogger(): never {
  return { info: noop, warn: noop, error: noop, child: () => makeLogger() } as never;
}

let nextPort = 19000;

function makeDeps() {
  const port = nextPort++;
  const config = {
    healthPort: port,
    network: "hardhat",
    nodeEnv: "development",
    perpsAddress: "0x1234",
    dryRun: false,
    logLevel: "info",
    commitHash: "abc123",
    numLevelsPerSide: 5,
    baseQuantity: 1_000_000n,
    minSpreadBps: 10,
    volatilityMultiplier: 2.0,
    inventorySkewGamma: 0.5,
    maxSkewTicks: 20,
    ethPriceFeedAddress: undefined,
    gasSpikeThresholdPct: 200,
    gasCapMultiplier: 2.0,
    gasPenaltyBps: 5,
    maxGasBudgetPerHourUsd: 50_000_000n,
    maxGasBudgetPerDayUsd: 500_000_000n,
    urgentRequoteThresholdTicks: 10,
    maxPositionSize: 100_000_000n,
    maxUtilizationPct: 80,
    minCollateralBalance: 100_000_000n,
    maxDailyLossUsd: 1_000_000_000n,
    pollIntervalMs: 3000,
    requoteThresholdTicks: 2,
    requoteCooldownMs: 1000,
    resyncIntervalMs: 60_000,
  } as MakerConfig;
  const oracle = { currentPrice: 100_000_000n, volatility: 0.005 } as OracleTracker;
  const inventory = {
    netQuantity: 5_000_000n,
    collateralBalance: 500_000_000n,
    inventorySkew: 0.05,
    utilizationPct: 15,
    tokenBalance: 500_000_000n,
    ethBalance: 500_000_000n,
  } as InventoryManager;
  const book = {
    ownOrders: new Map(),
    bestBid: 99_000_000n,
    bestAsk: 101_000_000n,
  } as unknown as BookTracker;
  const gas = {
    currentGasPrice: 1_000_000_000n,
    isGasSpiking: false,
    gasSpikePct: 10,
  } as GasTracker;
  const risk = {
    halted: false,
    haltReason: null,
    throttled: false,
    throttleReason: "none",
    cumulativeGasCostUsd: 50_000n,
  } as unknown as RiskManager;

  return { config, oracle, inventory, book, gas, risk, port };
}

describe("HealthCheck", () => {
  let health: HealthCheck | null = null;

  afterEach(async () => {
    await health?.stop();
    health = null;
  });

  it("starts and responds to /health with JSON", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, pino());
    health.status = "running";
    console.log("starting health");
    await health.start();
    console.log("health started", port);

    const res = await fetch(`http://localhost:${port}/health`);
    console.log("===========", res);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");

    const body = await res.json();
    assert.equal(body.status, "running");
    assert.ok(typeof body.uptimeSeconds === "number");

    assert.equal(body.config.network, "hardhat");
    assert.equal(body.config.dryRun, false);
    assert.equal(body.config.commitHash, "abc123");
    assert.equal(body.config.quoting.numLevelsPerSide, 5);
    assert.equal(body.config.quoting.baseQuantity, "1000000");
    assert.equal(body.config.quoting.minSpreadBps, 10);
    assert.equal(body.config.gas.gasSpikeThresholdPct, 200);
    assert.equal(body.config.risk.maxPositionSize, "100000000");
    assert.equal(body.config.timing.pollIntervalMs, 3000);

    assert.equal(body.market.oraclePrice, "100000000");
    assert.equal(body.market.bestBid, "99000000");
    assert.equal(body.market.bestAsk, "101000000");

    assert.equal(body.inventory.netPosition, "5000000");
    assert.equal(body.inventory.collateralBalance, "500000000");
    assert.equal(body.inventory.ethBalance, "500000000");
    assert.equal(body.inventory.tokenBalance, "500000000");
    assert.equal(body.inventory.inventorySkew, 0.05);
    assert.equal(body.inventory.utilizationPct, 15);

    assert.equal(body.gas.gasSpiking, false);
    assert.equal(body.risk.throttled, false);
  });

  it("reports initializing status before init completes", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(body.status, "initializing");
    assert.equal(body.lastError, null);
  });

  it("reports init-error status with lastError on init failure", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "init-error";
    health.lastError = { message: "insufficient funds for gas" };
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(body.status, "init-error");
    assert.equal(body.lastError.message, "insufficient funds for gas");
  });

  it("reports error status when tick fails", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "error";
    health.lastError = { message: "execution reverted" };
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(body.status, "error");
    assert.equal(body.lastError.message, "execution reverted");
  });

  it("reports error status when risk is halted", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "error";
    health.lastError = { message: "collateral below minimum", balance: "0", min: "100000000" };
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(body.status, "error");
    assert.equal(body.lastError.message, "collateral below minimum");
    assert.equal(body.lastError.balance, "0");
  });

  it("returns 404 for non-health paths", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/other`);
    assert.equal(res.status, 404);
  });

  it("returns 404 for POST to /health", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("stop is idempotent", async () => {
    const { config, oracle, inventory, book, gas, risk } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();
    await health.stop();
    await health.stop();
    health = null;
  });

  it("stop without start does not throw", async () => {
    const { config, oracle, inventory, book, gas, risk } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.stop();
    health = null;
  });

  it("POST /stop sets status to stopped and paused flag", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    await health.start();

    const res = await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "stopped");

    assert.equal(health.paused, true);
    assert.equal(health.status, "stopped");

    const healthRes = await fetch(`http://localhost:${port}/health`);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, "stopped");
  });

  it("POST /start resumes from stopped state", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    await health.start();

    await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    assert.equal(health.paused, true);

    const res = await fetch(`http://localhost:${port}/start`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "running");

    assert.equal(health.paused, false);
    assert.equal(health.status, "running");
  });

  it("POST /stop is idempotent", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    await health.start();

    const res1 = await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    assert.equal(res1.status, 200);

    const res2 = await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    assert.equal(res2.status, 200);
    assert.equal(health.paused, true);
  });

  it("POST /start when already running is a no-op", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    await health.start();

    const res = await fetch(`http://localhost:${port}/start`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "running");
    assert.equal(health.paused, false);
  });

  it("POST /stop calls onStop callback", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    let callbackCalled = false;
    health.onStop = async () => {
      callbackCalled = true;
    };
    await health.start();

    const res = await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(callbackCalled, true);
  });

  it("POST /start calls onStart callback", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    let callbackCalled = false;
    health.onStart = async () => {
      callbackCalled = true;
    };
    await health.start();

    await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    const res = await fetch(`http://localhost:${port}/start`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(callbackCalled, true);
  });

  it("POST /stop returns 500 when onStop callback fails", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    health.onStop = async () => {
      throw new Error("cancel failed");
    };
    await health.start();

    const res = await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("GET /stop returns 404", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/stop`);
    assert.equal(res.status, 404);
  });

  it("GET /start returns 404", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/start`);
    assert.equal(res.status, 404);
  });
});
