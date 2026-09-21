import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Quoter } from "../src/quoter.ts";
import type { OracleTracker } from "../src/oracleTracker.ts";
import type { GasTracker } from "../src/gasTracker.ts";
import type { InventoryManager } from "../src/inventoryManager.ts";
import type { RiskManager } from "../src/riskManager.ts";
import type { MakerConfig } from "../src/config.ts";

function makeConfig(overrides: Partial<MakerConfig> = {}): MakerConfig {
  return {
    network: "hardhat",
    ethNodeAddress: "http://localhost:8545",
    perpsAddress: "0x0000000000000000000000000000000000000001",
    makerPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    numLevelsPerSide: 3,
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
    resyncIntervalMs: 60000,
    dryRun: false,
    healthPort: 3001,
    logLevel: "silent",
    ...overrides,
  } as MakerConfig;
}

function makeOracle(price: bigint, vol = 0): OracleTracker {
  return { currentPrice: price, volatility: vol } as OracleTracker;
}

function makeGas(overrides: Partial<GasTracker> = {}): GasTracker {
  return {
    currentGasPrice: 0n,
    medianGasPrice: 0,
    gasSpikePct: 0,
    isGasSpiking: false,
    roundTripCostUsd: 0n,
    ethPriceUsd: 0n,
    ...overrides,
  } as unknown as GasTracker;
}

function makeInventory(overrides: Partial<InventoryManager> = {}): InventoryManager {
  return {
    netQuantity: 0n,
    collateralBalance: 1_000_000_000n,
    requiredMargin: 0n,
    inventorySkew: 0,
    availableMargin: 1_000_000_000n,
    utilizationPct: 0,
    ...overrides,
  } as InventoryManager;
}

function makeRisk(overrides: Partial<{ quoteBid: boolean; quoteAsk: boolean }> = {}): RiskManager {
  return {
    allowedSides: () => ({ quoteBid: true, quoteAsk: true, ...overrides }),
  } as unknown as RiskManager;
}

function makePublicClient(): unknown {
  return {
    readContract: async () => 10_000n, // minimumPriceIncrement = 0.01 USDC (6 decimals)
  };
}

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

describe("Quoter", () => {
  it("produces symmetric quotes around oracle price with zero inventory", async () => {
    const config = makeConfig({ numLevelsPerSide: 1, minSpreadBps: 100 });
    const oracle = makeOracle(100_000_000n); // $100
    const gas = makeGas();
    const inventory = makeInventory();
    const risk = makeRisk();

    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, gas, inventory, risk, makeLogger(),
    );
    await quoter.initialize();

    const quotes = quoter.computeQuotes();
    assert.equal(quotes.bids.length, 1);
    assert.equal(quotes.asks.length, 1);

    // Bid should be below oracle, ask above
    assert.ok(quotes.bids[0].price < oracle.currentPrice, "bid should be below oracle");
    assert.ok(quotes.asks[0].price > oracle.currentPrice, "ask should be above oracle (absolute value)");

    // Bid quantity positive, ask quantity negative
    assert.ok(quotes.bids[0].quantity > 0n, "bid qty should be positive");
    assert.ok(quotes.asks[0].quantity < 0n, "ask qty should be negative");
  });

  it("produces no quotes when oracle price is 0", async () => {
    const config = makeConfig();
    const oracle = makeOracle(0n);
    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, makeGas(), makeInventory(), makeRisk(), makeLogger(),
    );
    await quoter.initialize();

    const quotes = quoter.computeQuotes();
    assert.equal(quotes.bids.length, 0);
    assert.equal(quotes.asks.length, 0);
  });

  it("only quotes ask side when position is at max long", async () => {
    const config = makeConfig({ numLevelsPerSide: 2 });
    const oracle = makeOracle(100_000_000n);
    const risk = makeRisk({ quoteBid: false, quoteAsk: true });

    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, makeGas(), makeInventory(), risk, makeLogger(),
    );
    await quoter.initialize();

    const quotes = quoter.computeQuotes();
    assert.equal(quotes.bids.length, 0);
    assert.ok(quotes.asks.length > 0);
  });

  it("produces multiple levels with increasing size", async () => {
    const config = makeConfig({ numLevelsPerSide: 3, baseQuantity: 1_000_000n });
    const oracle = makeOracle(100_000_000n);

    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, makeGas(), makeInventory(), makeRisk(), makeLogger(),
    );
    await quoter.initialize();

    const quotes = quoter.computeQuotes();
    assert.equal(quotes.bids.length, 3);
    assert.equal(quotes.asks.length, 3);

    // Sizes should increase: 1x, 2x, 3x
    assert.equal(quotes.bids[0].quantity, 1_000_000n);
    assert.equal(quotes.bids[1].quantity, 2_000_000n);
    assert.equal(quotes.bids[2].quantity, 3_000_000n);
  });

  it("exposes tick after initialization", async () => {
    const quoter = new Quoter(
      makePublicClient() as never,
      makeConfig(), makeOracle(100_000_000n), makeGas(), makeInventory(), makeRisk(), makeLogger(),
    );
    await quoter.initialize();
    assert.equal(quoter.getTick(), 10_000n);
  });

  it("widens spread based on gas floor when roundTripCostUsd is non-zero", async () => {
    const config = makeConfig({ numLevelsPerSide: 1, minSpreadBps: 5 });
    const oracle = makeOracle(100_000_000n);

    // Gas cost high enough that gasFloorBps > minSpreadBps
    // roundTripCost = 1_000_000 ($1), notional = $100 → floor = 1_000_000 * 10000 / 100_000_000 = 100 bps
    const gasWithCost = makeGas({ roundTripCostUsd: 1_000_000n });
    const gasNoCost = makeGas({ roundTripCostUsd: 0n });

    const quoterGas = new Quoter(
      makePublicClient() as never,
      config, oracle, gasWithCost, makeInventory(), makeRisk(), makeLogger(),
    );
    await quoterGas.initialize();

    const quoterNoGas = new Quoter(
      makePublicClient() as never,
      config, oracle, gasNoCost, makeInventory(), makeRisk(), makeLogger(),
    );
    await quoterNoGas.initialize();

    const gasQuotes = quoterGas.computeQuotes();
    const noGasQuotes = quoterNoGas.computeQuotes();

    const gasSpread = gasQuotes.asks[0].price - gasQuotes.bids[0].price;
    const noGasSpread = noGasQuotes.asks[0].price - noGasQuotes.bids[0].price;

    assert.ok(gasSpread > noGasSpread, "gas floor should widen spread beyond minSpreadBps");
  });

  it("returns 0 gas floor when expected notional is 0", async () => {
    const config = makeConfig({ numLevelsPerSide: 1, baseQuantity: 0n });
    const oracle = makeOracle(100_000_000n);
    const gas = makeGas({ roundTripCostUsd: 1_000_000n });

    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, gas, makeInventory(), makeRisk(), makeLogger(),
    );
    await quoter.initialize();

    // Should not crash even with 0 baseQuantity (notional = 0)
    const quotes = quoter.computeQuotes();
    assert.equal(quotes.bids.length, 1);
  });

  it("produces no quotes when tick is 0 but oracle is valid", async () => {
    const config = makeConfig({ numLevelsPerSide: 1 });
    const oracle = makeOracle(100_000_000n);
    const quoter = new Quoter(
      { readContract: async () => 0n } as never,
      config, oracle, makeGas(), makeInventory(), makeRisk(), makeLogger(),
    );
    await quoter.initialize();
    assert.equal(quoter.getTick(), 0n);

    const quotes = quoter.computeQuotes();
    assert.equal(quotes.bids.length, 0);
    assert.equal(quotes.asks.length, 0);
  });

  it("clamps bid price to tick when bidRaw is negative", async () => {
    // Very wide spread on a low oracle price causes bidRaw to go negative
    const config = makeConfig({ numLevelsPerSide: 1, minSpreadBps: 9000 });
    const oracle = makeOracle(100_000n); // very low price
    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, makeGas(), makeInventory(), makeRisk(), makeLogger(),
    );
    await quoter.initialize();

    const quotes = quoter.computeQuotes();
    assert.ok(quotes.bids[0].price > 0n, "bid price should clamp to tick, not be negative");
  });

  it("handles negative gas spike pct gracefully (no penalty)", async () => {
    const config = makeConfig({ numLevelsPerSide: 1, gasPenaltyBps: 10 });
    const oracle = makeOracle(100_000_000n);
    const gas = makeGas({ gasSpikePct: -50 });

    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, gas, makeInventory(), makeRisk(), makeLogger(),
    );
    await quoter.initialize();

    const quotes = quoter.computeQuotes();
    assert.ok(quotes.bids.length > 0);
    assert.ok(quotes.asks.length > 0);
  });

  it("applies inventory skew shifting quotes when long", async () => {
    const config = makeConfig({ numLevelsPerSide: 1, minSpreadBps: 100, inventorySkewGamma: 1.0, maxSkewTicks: 50 });
    const oracle = makeOracle(100_000_000n);
    const invNeutral = makeInventory({ inventorySkew: 0 });
    const invLong = makeInventory({ inventorySkew: 0.5 });

    const quoterNeutral = new Quoter(
      makePublicClient() as never,
      config, oracle, makeGas(), invNeutral, makeRisk(), makeLogger(),
    );
    await quoterNeutral.initialize();

    const quoterLong = new Quoter(
      makePublicClient() as never,
      config, oracle, makeGas(), invLong, makeRisk(), makeLogger(),
    );
    await quoterLong.initialize();

    const neutralQuotes = quoterNeutral.computeQuotes();
    const longQuotes = quoterLong.computeQuotes();

    // Long position skews quotes down → bids strictly lower
    assert.ok(longQuotes.bids[0].price < neutralQuotes.bids[0].price, "long skew should push bids down");
    // Asks should also shift down or remain equal (rounding may absorb small shifts)
    assert.ok(longQuotes.asks[0].price <= neutralQuotes.asks[0].price, "long skew should push asks down or equal");
  });

  it("only quotes bid side when risk blocks asks", async () => {
    const config = makeConfig({ numLevelsPerSide: 2 });
    const oracle = makeOracle(100_000_000n);
    const risk = makeRisk({ quoteBid: true, quoteAsk: false });

    const quoter = new Quoter(
      makePublicClient() as never,
      config, oracle, makeGas(), makeInventory(), risk, makeLogger(),
    );
    await quoter.initialize();

    const quotes = quoter.computeQuotes();
    assert.ok(quotes.bids.length > 0);
    assert.equal(quotes.asks.length, 0);
  });

  it("widens spread when gas spike penalty is active", async () => {
    const config = makeConfig({ numLevelsPerSide: 1, minSpreadBps: 10, gasPenaltyBps: 10 });
    const oracle = makeOracle(100_000_000n);
    const gasNormal = makeGas({ gasSpikePct: 0 });
    const gasSpike = makeGas({ gasSpikePct: 300 });

    const quoterNormal = new Quoter(
      makePublicClient() as never,
      config, oracle, gasNormal, makeInventory(), makeRisk(), makeLogger(),
    );
    await quoterNormal.initialize();

    const quoterSpike = new Quoter(
      makePublicClient() as never,
      config, oracle, gasSpike, makeInventory(), makeRisk(), makeLogger(),
    );
    await quoterSpike.initialize();

    const normalQuotes = quoterNormal.computeQuotes();
    const spikeQuotes = quoterSpike.computeQuotes();

    const normalSpread = normalQuotes.asks[0].price - normalQuotes.bids[0].price;
    const spikeSpread = spikeQuotes.asks[0].price - spikeQuotes.bids[0].price;

    assert.ok(spikeSpread > normalSpread, "spike should produce wider spread");
  });
});
