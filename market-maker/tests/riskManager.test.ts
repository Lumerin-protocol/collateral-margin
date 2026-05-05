import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fraction from "fraction.js";
import { RiskManager, type RiskManagerConfig } from "../src/riskManager.ts";
import type { InventoryManager } from "../src/inventoryManager.ts";
import type { GasTracker } from "../src/gasTracker.ts";
import type { OracleTracker } from "../src/oracleTracker.ts";

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ info: noop, warn: noop, error: noop }) } as never;
}

function makeConfig(overrides: Partial<RiskManagerConfig> = {}): RiskManagerConfig {
  return {
    maxPositionSize: 100_000_000n,
    maxUtilizationPct: 80,
    minCollateralBalance: 100_000_000n,
    maxDailyLossUsd: 500_000_000n,
    maxGasBudgetPerHourUsd: 50_000_000n,
    maxGasBudgetPerDayUsd: 500_000_000n,
    ...overrides,
  };
}

function makeInventory(overrides: Partial<InventoryManager> = {}): InventoryManager {
  return {
    netQuantity: 0n,
    collateralBalance: 1_000_000_000n,
    maintenanceMargin: 100_000_000n,
    inventorySkew: new Fraction(0n),
    availableMargin: 900_000_000n,
    utilizationPct: 10,
    ...overrides,
  } as InventoryManager;
}

const dummyGas = {} as GasTracker;
const dummyOracle = { currentPrice: 100_000_000n } as OracleTracker;

describe("RiskManager", () => {
  it("allows quoting when healthy", () => {
    const r = new RiskManager(makeConfig(), makeInventory(), dummyGas, dummyOracle, makeLogger());
    r.initialize();
    assert.equal(r.check(), true);
    assert.equal(r.halted, false);
  });

  it("halts when collateral drops below minimum", () => {
    const inv = makeInventory({ collateralBalance: 50_000_000n });
    const r = new RiskManager(makeConfig({ minCollateralBalance: 100_000_000n }), inv, dummyGas, dummyOracle, makeLogger());
    r.initialize();
    assert.equal(r.check(), false);
    assert.equal(r.halted, true);
    assert.equal(r.haltReason?.message, "collateral below minimum");
  });

  it("halts on daily loss exceeding limit", () => {
    const inv = makeInventory({ collateralBalance: 400_000_000n });
    const r = new RiskManager(
      makeConfig({ maxDailyLossUsd: 500_000_000n, minCollateralBalance: 0n }),
      inv,
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    (r as unknown as Record<string, unknown>).startOfDayBalance = 1_000_000_000n;
    assert.equal(r.check(), false);
    assert.equal(r.haltReason?.message, "daily loss limit breached");
  });

  it("records gas costs into cumulative", () => {
    const r = new RiskManager(makeConfig(), makeInventory(), dummyGas, dummyOracle, makeLogger());
    r.initialize();
    r.recordGasCost(10_000_000n);
    r.recordGasCost(20_000_000n);
    assert.equal(r.cumulativeGasCostUsd, 30_000_000n);
  });

  it("allowedSides: both when neutral and within caps", () => {
    const r = new RiskManager(makeConfig(), makeInventory({ netQuantity: 0n }), dummyGas, dummyOracle, makeLogger());
    assert.deepEqual(r.allowedSides(), { quoteBid: true, quoteAsk: true });
  });

  it("allowedSides: blocks bid at max long with high utilization", () => {
    const r = new RiskManager(
      makeConfig({ maxPositionSize: 100_000_000n, maxUtilizationPct: 80 }),
      makeInventory({ netQuantity: 100_000_000n, utilizationPct: 90 }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    assert.deepEqual(r.allowedSides(), { quoteBid: false, quoteAsk: true });
  });

  it("allowedSides: blocks ask at max short with high utilization", () => {
    const r = new RiskManager(
      makeConfig({ maxPositionSize: 100_000_000n, maxUtilizationPct: 80 }),
      makeInventory({ netQuantity: -100_000_000n, utilizationPct: 90 }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    assert.deepEqual(r.allowedSides(), { quoteBid: true, quoteAsk: false });
  });

  it("allowedSides: blocks both when utilization high and position zero", () => {
    const r = new RiskManager(
      makeConfig({ maxUtilizationPct: 80 }),
      makeInventory({ netQuantity: 0n, utilizationPct: 90 }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    assert.deepEqual(r.allowedSides(), { quoteBid: false, quoteAsk: false });
  });

  it("throttles when hourly gas budget exceeded", () => {
    const r = new RiskManager(
      makeConfig({ maxGasBudgetPerHourUsd: 10_000_000n }),
      makeInventory(),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    r.recordGasCost(15_000_000n);
    r.check();
    assert.equal(r.throttled, true);
    assert.equal(r.throttleReason, "gas_hourly");
  });

  it("throttles when daily gas budget exceeded but hourly is fine", () => {
    const r = new RiskManager(
      makeConfig({ maxGasBudgetPerHourUsd: 1_000_000_000n, maxGasBudgetPerDayUsd: 10_000_000n }),
      makeInventory(),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    r.recordGasCost(15_000_000n);
    r.check();
    assert.equal(r.throttled, true);
    assert.equal(r.throttleReason, "gas_daily");
  });

  it("includes gas in daily PnL calculation", () => {
    const inv = makeInventory({ collateralBalance: 900_000_000n });
    const r = new RiskManager(
      makeConfig({ maxDailyLossUsd: 200_000_000n, minCollateralBalance: 0n }),
      inv,
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    r.recordGasCost(250_000_000n);
    assert.equal(r.check(), false);
    assert.equal(r.haltReason?.message, "daily loss limit breached");
  });

  it("resets PnL counters on day rollover", () => {
    const r = new RiskManager(
      makeConfig({ minCollateralBalance: 0n, maxDailyLossUsd: 1_000_000_000n }),
      makeInventory({ collateralBalance: 1_000_000_000n }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    r.recordGasCost(50_000_000n);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(12, 0, 0, 0);
    (r as unknown as Record<string, unknown>).startOfDayTimestamp = yesterday.getTime();
    r.check();
    assert.equal(r.cumulativeGasCostUsd, 0n);
  });
});
