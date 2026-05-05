import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const REQUIRED_ENV = {
  NETWORK: "hardhat",
  ETH_NODE_ADDRESS: "http://localhost:8545",
  PERPS_ADDRESS: "0x0000000000000000000000000000000000000001",
  MAKER_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
};

describe("loadConfig", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const [k, v] of Object.entries(REQUIRED_ENV)) {
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("loads required fields from env", () => {
    const config = loadConfig();
    assert.equal(config.network, "hardhat");
    assert.equal(config.ethNodeAddress, "http://localhost:8545");
    assert.equal(config.perpsAddress, "0x0000000000000000000000000000000000000001");
    assert.equal(config.makerPrivateKey, "0x0000000000000000000000000000000000000000000000000000000000000001");
  });

  it("throws when required env var is missing", () => {
    delete process.env.NETWORK;
    assert.throws(() => loadConfig(), {
      message: /Missing required environment variable: NETWORK/,
    });
  });

  it("throws for each missing required var", () => {
    for (const key of Object.keys(REQUIRED_ENV)) {
      delete process.env[key];
      assert.throws(() => loadConfig(), {
        message: new RegExp(`Missing required environment variable: ${key}`),
      });
      process.env[key] = REQUIRED_ENV[key as keyof typeof REQUIRED_ENV];
    }
  });

  it("applies default values when optional env vars are not set", () => {
    const config = loadConfig();
    assert.equal(config.numLevelsPerSide, 5);
    assert.equal(config.baseQuantity, 1_000_000n);
    assert.equal(config.minSpreadBps, 10);
    assert.equal(config.volatilityMultiplier, 2.0);
    assert.equal(config.inventorySkewGamma, 0.5);
    assert.equal(config.maxSkewTicks, 20);
    assert.equal(config.gasSpikeThresholdPct, 200);
    assert.equal(config.gasCapMultiplier, 2.0);
    assert.equal(config.gasPenaltyBps, 5);
    assert.equal(config.maxGasBudgetPerHourUsd, 50_000_000n);
    assert.equal(config.maxGasBudgetPerDayUsd, 500_000_000n);
    assert.equal(config.urgentRequoteThresholdTicks, 10);
    assert.equal(config.maxPositionSize, 100_000_000n);
    assert.equal(config.maxUtilizationPct, 80);
    assert.equal(config.minCollateralBalance, 100_000_000n);
    assert.equal(config.maxDailyLossUsd, 1_000_000_000n);
    assert.equal(config.pollIntervalMs, 3000);
    assert.equal(config.requoteThresholdTicks, 2);
    assert.equal(config.requoteCooldownMs, 1000);
    assert.equal(config.resyncIntervalMs, 60000);
    assert.equal(config.dryRun, false);
    assert.equal(config.healthPort, 3001);
    assert.equal(config.logLevel, "info");
  });

  it("parses custom numeric values from env", () => {
    process.env.MAKER_LEVELS_PER_SIDE = "10";
    process.env.MAKER_BASE_QUANTITY = "5000000";
    process.env.MAKER_MIN_SPREAD_BPS = "25";
    process.env.MAKER_POLL_INTERVAL_MS = "5000";
    const config = loadConfig();
    assert.equal(config.numLevelsPerSide, 10);
    assert.equal(config.baseQuantity, 5_000_000n);
    assert.equal(config.minSpreadBps, 25);
    assert.equal(config.pollIntervalMs, 5000);
  });

  it("parses dryRun as true when set", () => {
    process.env.MAKER_DRY_RUN = "true";
    assert.equal(loadConfig().dryRun, true);
  });

  it("parses dryRun as false for non-true values", () => {
    process.env.MAKER_DRY_RUN = "false";
    assert.equal(loadConfig().dryRun, false);
    process.env.MAKER_DRY_RUN = "1";
    assert.equal(loadConfig().dryRun, false);
  });

  it("parses logLevel from env", () => {
    process.env.MAKER_LOG_LEVEL = "debug";
    assert.equal(loadConfig().logLevel, "debug");
  });

  it("defaults logLevel to info when env not set", () => {
    delete process.env.MAKER_LOG_LEVEL;
    assert.equal(loadConfig().logLevel, "info");
  });

  it("parses ethPriceFeedAddress when set", () => {
    process.env.ETH_PRICE_FEED_ADDRESS = "0xaabbccdd00000000000000000000000000000002";
    assert.equal(loadConfig().ethPriceFeedAddress, "0xaabbccdd00000000000000000000000000000002");
  });

  it("returns undefined ethPriceFeedAddress when not set", () => {
    delete process.env.ETH_PRICE_FEED_ADDRESS;
    assert.equal(loadConfig().ethPriceFeedAddress, undefined);
  });
});
