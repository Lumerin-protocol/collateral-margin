import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fraction from "fraction.js";
import { RiskManager, type RiskManagerConfig } from "../../src/core/riskManager.ts";
import type { CollateralTracker } from "../../src/core/collateralTracker.ts";
import type { InventoryManager } from "../../src/core/inventoryManager.ts";
import type { GasTracker } from "../../src/core/gasTracker.ts";
import type { OracleTracker } from "../../src/core/oracleTracker.ts";

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
    inventorySkew: new Fraction(0n),
    ...overrides,
  } as InventoryManager;
}

function makeCollateral(overrides: Partial<CollateralTracker> = {}): CollateralTracker {
  return {
    vaultBalance: 1_000_000_000n,
    portfolioIM: 100_000_000n,
    portfolioMM: 50_000_000n,
    utilizationPct: 10,
    canPlace: async () => true,
    ...overrides,
  } as CollateralTracker;
}

const dummyGas = {} as GasTracker;
const dummyOracle = { currentPrice: 100_000_000n } as OracleTracker;

describe("RiskManager", () => {
  it("allows quoting when healthy", () => {
    const r = new RiskManager(
      makeConfig(),
      makeInventory(),
      makeCollateral(),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    assert.equal(r.check(), true);
    assert.equal(r.halted, false);
  });

  it("halts when collateral drops below minimum", () => {
    const r = new RiskManager(
      makeConfig({ minCollateralBalance: 100_000_000n }),
      makeInventory(),
      makeCollateral({ vaultBalance: 50_000_000n }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    assert.equal(r.check(), false);
    assert.equal(r.halted, true);
    assert.equal(r.haltReason?.message, "collateral below minimum");
  });

  it("halts when portfolio MM is breached", () => {
    const r = new RiskManager(
      makeConfig({ minCollateralBalance: 0n }),
      makeInventory(),
      makeCollateral({ vaultBalance: 100_000_000n, portfolioMM: 200_000_000n }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    assert.equal(r.check(), false);
    assert.equal(r.haltReason?.message, "portfolio MM breached");
  });

  it("halts on daily loss exceeding limit", () => {
    const collateral = makeCollateral({ vaultBalance: 400_000_000n });
    const r = new RiskManager(
      makeConfig({ maxDailyLossUsd: 500_000_000n, minCollateralBalance: 0n }),
      makeInventory(),
      collateral,
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
    const r = new RiskManager(
      makeConfig(),
      makeInventory(),
      makeCollateral(),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    r.initialize();
    r.recordGasCost(10_000_000n);
    r.recordGasCost(20_000_000n);
    assert.equal(r.cumulativeGasCostUsd, 30_000_000n);
  });

  it("allowedSides: both when neutral and within caps", () => {
    const r = new RiskManager(
      makeConfig(),
      makeInventory({ netQuantity: 0n }),
      makeCollateral(),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    assert.deepEqual(r.allowedSides(), { quoteBid: true, quoteAsk: true });
  });

  it("allowedSides: blocks bid at max long with high utilization", () => {
    const r = new RiskManager(
      makeConfig({ maxPositionSize: 100_000_000n, maxUtilizationPct: 80 }),
      makeInventory({ netQuantity: 100_000_000n }),
      makeCollateral({ utilizationPct: 90 }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    assert.deepEqual(r.allowedSides(), { quoteBid: false, quoteAsk: true });
  });

  it("allowedSides: blocks ask at max short with high utilization", () => {
    const r = new RiskManager(
      makeConfig({ maxPositionSize: 100_000_000n, maxUtilizationPct: 80 }),
      makeInventory({ netQuantity: -100_000_000n }),
      makeCollateral({ utilizationPct: 90 }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    assert.deepEqual(r.allowedSides(), { quoteBid: true, quoteAsk: false });
  });

  it("allowedSides: blocks both when utilization high and position zero", () => {
    const r = new RiskManager(
      makeConfig({ maxUtilizationPct: 80 }),
      makeInventory({ netQuantity: 0n }),
      makeCollateral({ utilizationPct: 90 }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    assert.deepEqual(r.allowedSides(), { quoteBid: false, quoteAsk: false });
  });

  it("allowedSides: uses the per-market inventory and cap over the shared ones", () => {
    // Shared inventory is neutral with a large cap; the per-market override is
    // at its own (smaller) long cap, so bids must be blocked for THIS market.
    const r = new RiskManager(
      makeConfig({ maxPositionSize: 1_000_000_000n }),
      makeInventory({ netQuantity: 0n }),
      makeCollateral({ utilizationPct: 10 }),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    const perMarket = makeInventory({ netQuantity: 5_000_000n });
    assert.deepEqual(r.allowedSides(perMarket, 5_000_000n), {
      quoteBid: false, // net == cap → cannot add more long
      quoteAsk: true,
    });
    // Sanity: without the override it would use the shared neutral inventory.
    assert.deepEqual(r.allowedSides(), { quoteBid: true, quoteAsk: true });
  });

  it("allowedSides: blocks both sides when there is no inventory to reason about", () => {
    const r = new RiskManager(
      makeConfig(),
      null,
      makeCollateral(),
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
      makeCollateral(),
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
      makeCollateral(),
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

  it("resets PnL counters on day rollover", () => {
    const r = new RiskManager(
      makeConfig({ minCollateralBalance: 0n, maxDailyLossUsd: 1_000_000_000n }),
      makeInventory(),
      makeCollateral(),
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

  it("canPlaceOrders returns true on empty input", async () => {
    const r = new RiskManager(
      makeConfig(),
      makeInventory(),
      makeCollateral(),
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    const dummyInstrument = { estimateOrderMargin: () => 0n } as never;
    assert.equal(await r.canPlaceOrders([], dummyInstrument), true);
  });

  it("canPlaceOrders consults engine when total IM > 0", async () => {
    const calls: bigint[] = [];
    const collateral = makeCollateral({
      canPlace: async (im: bigint) => {
        calls.push(im);
        return im < 1_000n;
      },
    });
    const r = new RiskManager(
      makeConfig(),
      makeInventory(),
      collateral,
      dummyGas,
      dummyOracle,
      makeLogger(),
    );
    const dummyInstrument = { estimateOrderMargin: () => 400n } as never;
    const allowed = await r.canPlaceOrders(
      [
        { side: "buy", price: 1n, size: 1n },
        { side: "sell", price: 2n, size: 1n },
      ],
      dummyInstrument,
    );
    assert.equal(allowed, true);
    assert.deepEqual(calls, [800n]);
  });
});
