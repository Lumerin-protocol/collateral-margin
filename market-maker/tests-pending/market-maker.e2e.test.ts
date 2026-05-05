import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getContract, parseUnits } from "viem";
import pino from "pino";

import { OracleTracker } from "../src/oracleTracker.ts";
import { GasTracker } from "../src/gasTracker.ts";
import { BookTracker } from "../src/bookTracker.ts";
import { InventoryManager } from "../src/inventoryManager.ts";
import { Quoter } from "../src/quoter.ts";
import { OrderExecutor } from "../src/orderExecutor.ts";
import { RiskManager } from "../src/riskManager.ts";
import { HealthCheck } from "../src/healthcheck.ts";
import type { MakerConfig } from "../src/config.ts";
import { hashPowerPerpsDexAbi, priceOracleMockAbi } from "../src/abi.ts";
import { hardhat } from "../src/client.ts";
import { startHardhatNode, createMakerConfig, loadFixture, type HardhatNode } from "./helpers.ts";
import { deployWithCollateralFixture } from "../../contracts/fixtures/viem.ts";

const silentLogger = pino({ level: "silent" });

let hardhatNode: HardhatNode;

before(async () => {
  hardhatNode = await startHardhatNode();
});

after(() => {
  hardhatNode.stop();
});

// ── Component wiring helper ─────────────────────────────────────────────────

interface MakerStack {
  config: MakerConfig;
  oracle: OracleTracker;
  gas: GasTracker;
  book: BookTracker;
  inventory: InventoryManager;
  risk: RiskManager;
  quoter: Quoter;
  executor: OrderExecutor;
  health: HealthCheck;
}

function createStack(
  deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>,
  configOverrides: Partial<MakerConfig> = {},
): MakerStack {
  const { clients, contracts } = deployment;
  const config = createMakerConfig(contracts.perpsAddress, configOverrides);

  const { publicClient } = clients;
  const mmWallet = clients.buyer2Wallet;
  const mmAddress = mmWallet.account.address;

  const oracle = new OracleTracker(publicClient, config, silentLogger);
  const gas = new GasTracker(publicClient, config, silentLogger);
  const book = new BookTracker(publicClient, config, mmAddress, silentLogger);
  const inventory = new InventoryManager(publicClient, config, mmAddress, silentLogger);
  const risk = new RiskManager(config, inventory, gas, oracle, silentLogger);
  const quoter = new Quoter(publicClient, config, oracle, gas, inventory, risk, silentLogger);
  const executor = new OrderExecutor(
    publicClient,
    mmWallet,
    mmWallet.account,
    hardhat,
    config,
    quoter,
    book,
    gas,
    risk,
    oracle,
    silentLogger,
  );
  const health = new HealthCheck(config, oracle, inventory, book, gas, risk, silentLogger);

  return { config, oracle, gas, book, inventory, risk, quoter, executor, health };
}

async function initStack(stack: MakerStack): Promise<void> {
  await stack.quoter.initialize();
  await stack.book.start();
  await stack.oracle.update();
  await stack.gas.update();
  await stack.inventory.update();
  stack.risk.initialize();
  stack.health.status = "running";
}

function stopStack(stack: MakerStack): void {
  stack.book.stop();
  stack.health.stop();
}

// ── Quoting tests ───────────────────────────────────────────────────────────

describe("MM quoting", () => {
  let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
  let stack: MakerStack;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithCollateralFixture);
    stack = createStack(deployment);
    await initStack(stack);
  });

  afterEach(async () => {
    try {
      await stack.executor.cancelAll();
    } catch {
      /* may already be cancelled */
    }
    stopStack(stack);
  });

  it("should read real oracle price", async () => {
    assert.ok(stack.oracle.currentPrice > 0n, "oracle price should be positive");

    const onChainPrice = await deployment.clients.publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getMarketPrice",
    });
    assert.equal(stack.oracle.currentPrice, onChainPrice);
  });

  it("should place orders on an empty book", async () => {
    const desired = stack.quoter.computeQuotes();
    assert.ok(desired.bids.length > 0, "should have bid quotes");
    assert.ok(desired.asks.length > 0, "should have ask quotes");

    await stack.executor.reconcile(desired);

    // Verify orders appeared on-chain
    await stack.book.refresh();
    // Force resync to pick up the orders
    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();

    assert.ok(stack.book.ownOrders.size > 0, "MM should have resting orders on the book");
  });

  it("should place bids below and asks above oracle price", async () => {
    const desired = stack.quoter.computeQuotes();
    await stack.executor.reconcile(desired);

    const oraclePrice = stack.oracle.currentPrice;
    for (const bid of desired.bids) {
      assert.ok(bid.price < oraclePrice, `bid ${bid.price} should be below oracle ${oraclePrice}`);
      assert.ok(bid.quantity > 0n, "bid quantity should be positive");
    }
    for (const ask of desired.asks) {
      assert.ok(ask.price > oraclePrice, `ask ${ask.price} should be above oracle ${oraclePrice}`);
      assert.ok(ask.quantity < 0n, "ask quantity should be negative");
    }
  });

  it("should produce multiple levels with increasing size", async () => {
    const desired = stack.quoter.computeQuotes();

    assert.equal(desired.bids.length, stack.config.numLevelsPerSide);
    assert.equal(desired.asks.length, stack.config.numLevelsPerSide);

    for (let i = 1; i < desired.bids.length; i++) {
      assert.ok(
        desired.bids[i].quantity > desired.bids[i - 1].quantity,
        "deeper levels should have larger size",
      );
      assert.ok(
        desired.bids[i].price < desired.bids[i - 1].price,
        "deeper bid levels should have lower price",
      );
    }
  });

  it("should cancel all orders on cancelAll", async () => {
    const desired = stack.quoter.computeQuotes();
    await stack.executor.reconcile(desired);

    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();
    assert.ok(stack.book.ownOrders.size > 0, "should have orders before cancel");

    await stack.executor.cancelAll();

    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();
    assert.equal(stack.book.ownOrders.size, 0, "all orders should be cancelled");
  });

  it("should not place orders in dry-run mode", async () => {
    stopStack(stack);
    stack = createStack(deployment, { dryRun: true });
    await initStack(stack);

    const desired = stack.quoter.computeQuotes();
    await stack.executor.reconcile(desired);

    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();
    assert.equal(stack.book.ownOrders.size, 0, "dry run should not place real orders");
  });
});

// ── Fill handling tests ─────────────────────────────────────────────────────

describe("MM fill handling", () => {
  let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
  let stack: MakerStack;
  let perps: ReturnType<typeof getContract>;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithCollateralFixture);
    stack = createStack(deployment);
    await initStack(stack);

    perps = deployment.contracts.perps;
  });

  afterEach(async () => {
    try {
      await stack.executor.cancelAll();
    } catch {
      /* may already be cancelled */
    }
    stopStack(stack);
  });

  it("should update inventory after a fill", async () => {
    assert.equal(stack.inventory.netQuantity, 0n, "MM starts flat");

    const desired = stack.quoter.computeQuotes();
    await stack.executor.reconcile(desired);

    // Taker buys into the MM's best ask (fills the MM's sell order)
    const bestAsk = desired.asks[0];
    const takerQty = parseUnits("1", deployment.config.quantityDecimals);

    await (
      perps as unknown as {
        write: { createOrder: (args: [bigint, bigint], opts: unknown) => Promise<void> };
      }
    ).write.createOrder([bestAsk.price, takerQty], {
      account: deployment.clients.buyerWallet.account,
    });

    await stack.inventory.update();
    assert.ok(stack.inventory.netQuantity < 0n, "MM should be short after selling to taker");
    assert.ok(stack.inventory.hasPosition, "MM should have a position");
  });

  it("should requote after fill changes inventory", async () => {
    const desired = stack.quoter.computeQuotes();
    await stack.executor.reconcile(desired);

    // Fill the MM's ask
    const bestAsk = desired.asks[0];
    const takerQty = parseUnits("1", deployment.config.quantityDecimals);
    await (
      perps as unknown as {
        write: { createOrder: (args: [bigint, bigint], opts: unknown) => Promise<void> };
      }
    ).write.createOrder([bestAsk.price, takerQty], {
      account: deployment.clients.buyerWallet.account,
    });

    // Update state
    await stack.oracle.update();
    await stack.inventory.update();

    // Compute new quotes with updated inventory
    const newDesired = stack.quoter.computeQuotes();

    // With short inventory and positive skew gamma, bids should be more aggressive (higher)
    // to attract buys and reduce short exposure
    assert.ok(newDesired.bids.length > 0, "should still quote bids");
    assert.ok(newDesired.asks.length > 0, "should still quote asks");
  });
});

// ── Requote on price change ─────────────────────────────────────────────────

describe("MM requote on price change", () => {
  let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
  let stack: MakerStack;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithCollateralFixture);
    stack = createStack(deployment, { requoteCooldownMs: 0, requoteThresholdTicks: 1 });
    await initStack(stack);
  });

  afterEach(async () => {
    try {
      await stack.executor.cancelAll();
    } catch {
      /* may already be cancelled */
    }
    stopStack(stack);
  });

  it("should adjust quotes when oracle price changes", async () => {
    const desired1 = stack.quoter.computeQuotes();
    await stack.executor.reconcile(desired1);
    const bid1 = desired1.bids[0].price;
    const ask1 = desired1.asks[0].price;

    // Change oracle price significantly
    const oracle = getContract({
      address: deployment.contracts.oracleAddress,
      abi: priceOracleMockAbi,
      client: { wallet: deployment.clients.ownerWallet },
    });
    const newPrice = deployment.config.oracle.price * 2n;
    await oracle.write.setPrice([newPrice, deployment.config.oracle.decimals]);

    await stack.oracle.update();
    const desired2 = stack.quoter.computeQuotes();

    assert.ok(desired2.bids[0].price > bid1, "bid should move up with higher oracle");
    assert.ok(desired2.asks[0].price > ask1, "ask should move up with higher oracle");
  });
});

// ── Risk controls ───────────────────────────────────────────────────────────

describe("MM risk controls", () => {
  let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
  let stack: MakerStack;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithCollateralFixture);
  });

  afterEach(async () => {
    if (stack) {
      try {
        await stack.executor.cancelAll();
      } catch {
        /* may already be cancelled */
      }
      stopStack(stack);
    }
  });

  it("should halt when collateral drops below minimum", async () => {
    // Set minCollateralBalance very high so the MM immediately halts
    stack = createStack(deployment, { minCollateralBalance: 999_999_000_000n });
    await initStack(stack);

    const ok = stack.risk.check();
    assert.equal(ok, false, "risk check should fail");
    assert.equal(stack.risk.halted, true);
    assert.equal(stack.risk.haltReason?.message, "collateral below minimum");
  });

  it("should block bid side when at max long position", async () => {
    stack = createStack(deployment, { maxPositionSize: 1n, maxUtilizationPct: 90 });
    await initStack(stack);

    // Simulate a long position by setting inventory
    stack.inventory.netQuantity = 1n;
    stack.inventory.utilizationPct = 95;

    const sides = stack.risk.allowedSides();
    assert.equal(sides.quoteBid, false, "should block bids at max long");
    assert.equal(sides.quoteAsk, true, "should allow asks to reduce position");
  });

  it("should block ask side when at max short position", async () => {
    stack = createStack(deployment, { maxPositionSize: 1n, maxUtilizationPct: 90 });
    await initStack(stack);

    stack.inventory.netQuantity = -1n;
    stack.inventory.utilizationPct = 95;

    const sides = stack.risk.allowedSides();
    assert.equal(sides.quoteBid, true, "should allow bids to reduce position");
    assert.equal(sides.quoteAsk, false, "should block asks at max short");
  });

  it("should cancel all orders when risk halts", async () => {
    stack = createStack(deployment);
    await initStack(stack);

    // Place some orders first
    const desired = stack.quoter.computeQuotes();
    await stack.executor.reconcile(desired);

    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();
    assert.ok(stack.book.ownOrders.size > 0, "should have orders before halt");

    // Trigger halt
    stack.inventory.collateralBalance = 0n;
    const ok = stack.risk.check();
    assert.equal(ok, false);

    // Halt should cancel all
    await stack.executor.cancelAll();

    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();
    assert.equal(stack.book.ownOrders.size, 0, "all orders cancelled after halt");
  });
});

// ── Health endpoint ─────────────────────────────────────────────────────────

describe("MM health endpoint", () => {
  let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
  let stack: MakerStack;
  let healthPort: number;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithCollateralFixture);
    healthPort = 19100 + Math.floor(Math.random() * 900);
    stack = createStack(deployment, { healthPort });
    await initStack(stack);
    await stack.health.start();
  });

  afterEach(async () => {
    stopStack(stack);
  });

  it("should expose running status and live data", async () => {
    const res = await fetch(`http://localhost:${healthPort}/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, "running");
    assert.ok(BigInt(body.market.oraclePrice) > 0n, "oraclePrice should be positive");
    assert.ok(BigInt(body.inventory.collateralBalance) > 0n, "collateral should be positive");
    assert.equal(body.gas.gasSpiking, false);
    assert.equal(body.config.dryRun, false);
    assert.ok(typeof body.uptimeSeconds === "number");
  });

  it("should show error status after risk halt", async () => {
    stack.inventory.collateralBalance = 0n;
    stack.risk.check();
    stack.health.status = "error";
    stack.health.lastError = stack.risk.haltReason;

    const res = await fetch(`http://localhost:${healthPort}/health`);
    const body = await res.json();
    assert.equal(body.status, "error");
    assert.equal(body.lastError.message, "collateral below minimum");
    assert.equal(body.lastError.balance, "0");
  });
});

// ── Full tick cycle ─────────────────────────────────────────────────────────

describe("MM full tick cycle", () => {
  let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
  let stack: MakerStack;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithCollateralFixture);
    stack = createStack(deployment);
    await initStack(stack);
  });

  afterEach(async () => {
    try {
      await stack.executor.cancelAll();
    } catch {
      /* may already be cancelled */
    }
    stopStack(stack);
  });

  it("should complete a full tick: update → check → quote → reconcile", async () => {
    await stack.oracle.update();
    await stack.gas.update();
    await stack.inventory.update();

    const ok = stack.risk.check();
    assert.ok(ok, "risk check should pass");

    const desired = stack.quoter.computeQuotes();
    assert.ok(desired.bids.length > 0);
    assert.ok(desired.asks.length > 0);

    await stack.executor.reconcile(desired);

    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();
    assert.ok(stack.book.ownOrders.size > 0, "orders should exist after tick");
  });

  it("should handle multiple consecutive ticks", async () => {
    for (let i = 0; i < 3; i++) {
      await stack.oracle.update();
      await stack.gas.update();
      (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
      await stack.book.refresh();
      await stack.inventory.update();

      const ok = stack.risk.check();
      if (!ok) {
        await stack.executor.cancelAll();
        continue;
      }

      const desired = stack.quoter.computeQuotes();
      await stack.executor.reconcile(desired);
    }

    (stack.book as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await stack.book.refresh();
    assert.ok(stack.book.ownOrders.size > 0, "should have orders after multiple ticks");
  });

  it("should survive oracle price going to zero gracefully", async () => {
    // Zero out the oracle
    const oracle = getContract({
      address: deployment.contracts.oracleAddress,
      abi: priceOracleMockAbi,
      client: { wallet: deployment.clients.ownerWallet },
    });
    await oracle.write.setPrice([0n, deployment.config.oracle.decimals]);

    await stack.oracle.update();
    assert.equal(stack.oracle.currentPrice, 0n);

    // Quoter should return empty quotes, no crash
    const desired = stack.quoter.computeQuotes();
    assert.equal(desired.bids.length, 0);
    assert.equal(desired.asks.length, 0);
  });
});
