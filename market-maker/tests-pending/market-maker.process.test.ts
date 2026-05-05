import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { getContract, parseUnits, type Hex } from "viem";

import { hashPowerPerpsDexAbi, priceOracleMockAbi } from "../src/abi.ts";
import {
  startHardhatNode,
  waitFor,
  sleep,
  createTestPublicClient,
  createTestWalletClient,
  createTestClientInstance,
  HARDHAT_ACCOUNTS,
  type HardhatNode,
} from "./helpers.ts";
import { deployWithCollateralFixture } from "../../contracts/fixtures/viem.ts";

const MM_ACCOUNT = HARDHAT_ACCOUNTS[3];
const TAKER_ACCOUNT = HARDHAT_ACCOUNTS[2];
const OWNER_ACCOUNT = HARDHAT_ACCOUNTS[0];
const HEALTH_PORT = 19950;

// ── Shared state across the whole file ──────────────────────────────────────

let hardhatNode: HardhatNode;
let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
let baseSnapshotId: Hex;

before(async () => {
  hardhatNode = await startHardhatNode();
  deployment = await deployWithCollateralFixture();
  const tc = createTestClientInstance();
  baseSnapshotId = await tc.snapshot();
});

after(() => {
  hardhatNode.stop();
});

// ── MM process helpers ──────────────────────────────────────────────────────

interface MakerProcess {
  child: ChildProcess;
  exited: Promise<number | null>;
  port: number;
}

function spawnMM(port: number): MakerProcess {
  const child = spawn("node", ["src/index.ts"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      NETWORK: "hardhat",
      ETH_NODE_ADDRESS: "http://127.0.0.1:8545",
      PERPS_ADDRESS: deployment.contracts.perpsAddress,
      MAKER_PRIVATE_KEY: MM_ACCOUNT.privateKey,
      MAKER_HEALTH_PORT: String(port),
      MAKER_LOG_LEVEL: "silent",
      MAKER_POLL_INTERVAL_MS: "500",
      MAKER_RESYNC_INTERVAL_MS: "500",
      MAKER_LEVELS_PER_SIDE: "3",
      MAKER_MIN_SPREAD_BPS: "50",
      MAKER_REQUOTE_THRESHOLD_TICKS: "1",
      MAKER_REQUOTE_COOLDOWN_MS: "0",
      MAKER_BASE_QUANTITY: String(parseUnits("1", deployment.config.quantityDecimals)),
      MAKER_VOLATILITY_MULTIPLIER: "0",
      MAKER_INVENTORY_SKEW_GAMMA: "0.5",
      MAKER_MAX_SKEW_TICKS: "20",
      MAKER_MAX_POSITION_SIZE: String(parseUnits("100", deployment.config.quantityDecimals)),
      MAKER_MAX_UTILIZATION_PCT: "90",
      MAKER_MIN_COLLATERAL: "1",
      MAKER_MAX_DAILY_LOSS_USD: "999000000000",
      MAKER_GAS_CAP_MULTIPLIER: "5.0",
      MAKER_GAS_PENALTY_BPS: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const exited = new Promise<number | null>((r) => child.on("close", r));

  return { child, exited, port };
}

async function stopMM(mm: MakerProcess): Promise<void> {
  if (!mm.child.killed) {
    mm.child.kill("SIGTERM");
    await Promise.race([mm.exited, sleep(5_000)]);
  }
}

async function fetchHealth(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${port}/health`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function waitForReady(mm: MakerProcess): Promise<void> {
  // Race health polling against process exit to avoid hanging
  await Promise.race([
    waitFor(async () => {
      try {
        const h = await fetchHealth(mm.port);
        return (h.market?.ownOrders as number) > 0 && h.market?.bestAsk !== "0";
      } catch {
        return false;
      }
    }, 30_000),
    mm.exited.then((code) => {
      throw new Error(`MM process exited unexpectedly with code ${code}`);
    }),
  ]);
}

async function revertToBase(): Promise<void> {
  const tc = createTestClientInstance();
  await tc.revert({ id: baseSnapshotId });
  baseSnapshotId = await tc.snapshot();
}

// ── Test group 1: quoting, monitoring, fills, requotes ──────────────────────

describe("MM process — quoting and fills", () => {
  let mm: MakerProcess;

  before(async () => {
    mm = spawnMM(HEALTH_PORT);
    await waitForReady(mm);
  });

  after(async () => {
    await stopMM(mm);
  });

  it("should report healthy status via API", async () => {
    const h = await fetchHealth(mm.port);
    assert.equal(h.status, "running");
    const stats = h.stats as Record<string, unknown>;
    assert.ok((stats.tickCount as number) >= 1);
    assert.ok((stats.lastTickAt as number) > 0);
    assert.equal((h.config as Record<string, unknown>).dryRun, false);
    assert.equal((h.gas as Record<string, unknown>).gasSpiking, false);
  });

  it("should have resting orders on-chain", async () => {
    const publicClient = createTestPublicClient();
    const orders = await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [MM_ACCOUNT.address],
    });
    assert.ok((orders as unknown[]).length > 0);
  });

  it("should report order placement stats via API", async () => {
    const h = await fetchHealth(mm.port);
    const stats = h.stats as Record<string, unknown>;
    assert.ok((stats.ordersPlaced as number) > 0);
    assert.ok((stats.reconcileCount as number) > 0);
  });

  it("should place bids below and asks above oracle", async () => {
    const h = await fetchHealth(mm.port);
    const market = h.market as Record<string, unknown>;
    const oracle = BigInt(market.oraclePrice as string);
    const bid = BigInt(market.bestBid as string);
    const ask = BigInt(market.bestAsk as string);

    assert.ok(bid > 0n && bid < oracle, "bid should be below oracle");
    assert.ok(ask > 0n && ask > oracle, "ask should be above oracle");
  });

  it("should show positive collateral via API", async () => {
    const h = await fetchHealth(mm.port);
    assert.ok(BigInt((h.inventory as Record<string, unknown>).collateralBalance as string) > 0n);
  });

  it("should update inventory when a taker fills the ask", async () => {
    const hBefore = await fetchHealth(mm.port);
    assert.equal((hBefore.inventory as Record<string, unknown>).netPosition, "0");

    const bestAsk = BigInt((hBefore.market as Record<string, unknown>).bestAsk as string);
    const publicClient = createTestPublicClient();
    const takerWallet = createTestWalletClient(TAKER_ACCOUNT.privateKey);
    const perps = getContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      client: { public: publicClient, wallet: takerWallet },
    });

    await perps.write.createOrder([bestAsk, parseUnits("1", deployment.config.quantityDecimals)]);

    // Wait for MM to detect the fill
    let hAfter!: Record<string, unknown>;
    await waitFor(async () => {
      hAfter = await fetchHealth(mm.port);
      return (hAfter.inventory as Record<string, unknown>).netPosition !== "0";
    }, 15_000);

    const inv = hAfter.inventory as Record<string, unknown>;
    assert.ok(BigInt(inv.netPosition as string) < 0n, "MM should be short");
    assert.ok((inv.inventorySkew as number) < 0, "skew should be negative");
  });

  it("should requote when oracle price changes", async () => {
    const hBefore = await fetchHealth(mm.port);
    const bestBidBefore = BigInt((hBefore.market as Record<string, unknown>).bestBid as string);

    const ownerWallet = createTestWalletClient(OWNER_ACCOUNT.privateKey);
    const oracle = getContract({
      address: deployment.contracts.oracleAddress,
      abi: priceOracleMockAbi,
      client: { wallet: ownerWallet },
    });
    await oracle.write.setPrice([
      deployment.config.oracle.price * 2n,
      deployment.config.oracle.decimals,
    ]);

    // Wait for the book to reflect the higher bid
    let hAfter!: Record<string, unknown>;
    await waitFor(async () => {
      hAfter = await fetchHealth(mm.port);
      return BigInt((hAfter.market as Record<string, unknown>).bestBid as string) > bestBidBefore;
    }, 15_000);

    assert.ok(BigInt((hAfter.market as Record<string, unknown>).bestBid as string) > bestBidBefore, "bid should move up");
  });
});

// ── Test group 2: on-chain book structure ───────────────────────────────────

describe("MM process — on-chain book structure", () => {
  let mm: MakerProcess;
  const port = HEALTH_PORT + 2;
  let publicClient: ReturnType<typeof createTestPublicClient>;

  before(async () => {
    await revertToBase();
    mm = spawnMM(port);
    await waitForReady(mm);
    publicClient = createTestPublicClient();
  });

  after(async () => {
    await stopMM(mm);
  });

  it("should place exactly numLevelsPerSide bids and asks on-chain", async () => {
    const orderIds = await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [MM_ACCOUNT.address],
    });
    // 3 levels per side = 6 total
    assert.equal((orderIds as unknown[]).length, 6);
  });

  it("should have every order price tick-aligned", async () => {
    const tick = await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "minimumPriceIncrement",
    });
    const orderIds = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [MM_ACCOUNT.address],
    })) as `0x${string}`[];

    const orderCalls = orderIds.map((id) => ({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrder" as const,
      args: [id] as const,
    }));
    const results = await publicClient.multicall({ contracts: orderCalls });

    for (const r of results) {
      assert.equal(r.status, "success");
      const order = r.result as { price: bigint };
      assert.equal(order.price % (tick as bigint), 0n, `price ${order.price} not tick-aligned`);
    }
  });

  it("should separate into positive-qty bids and negative-qty asks", async () => {
    const orderIds = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [MM_ACCOUNT.address],
    })) as `0x${string}`[];

    const orderCalls = orderIds.map((id) => ({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrder" as const,
      args: [id] as const,
    }));
    const results = await publicClient.multicall({ contracts: orderCalls });

    let bids = 0;
    let asks = 0;
    for (const r of results) {
      const order = r.result as { quantity: bigint };
      if (order.quantity > 0n) bids++;
      else if (order.quantity < 0n) asks++;
    }
    assert.equal(bids, 3, "should have 3 bids");
    assert.equal(asks, 3, "should have 3 asks");
  });

  it("should have increasing order size at deeper levels", async () => {
    const orderIds = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [MM_ACCOUNT.address],
    })) as `0x${string}`[];

    const orderCalls = orderIds.map((id) => ({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrder" as const,
      args: [id] as const,
    }));
    const results = await publicClient.multicall({ contracts: orderCalls });

    const bids: { price: bigint; qty: bigint }[] = [];
    const asks: { price: bigint; qty: bigint }[] = [];
    for (const r of results) {
      const o = r.result as { price: bigint; quantity: bigint };
      if (o.quantity > 0n) bids.push({ price: o.price, qty: o.quantity });
      else asks.push({ price: o.price, qty: -o.quantity });
    }
    // Sort bids descending by price (best bid first)
    bids.sort((a, b) => (a.price > b.price ? -1 : 1));
    // Sort asks ascending by price (best ask first)
    asks.sort((a, b) => (a.price < b.price ? -1 : 1));

    for (let i = 1; i < bids.length; i++) {
      assert.ok(bids[i].qty > bids[i - 1].qty, "deeper bid should have larger size");
      assert.ok(bids[i].price < bids[i - 1].price, "deeper bid should have lower price");
    }
    for (let i = 1; i < asks.length; i++) {
      assert.ok(asks[i].qty > asks[i - 1].qty, "deeper ask should have larger size");
      assert.ok(asks[i].price > asks[i - 1].price, "deeper ask should have higher price");
    }
  });

  it("should maintain at least minSpreadBps between best bid and ask", async () => {
    const [bestBid, bestAsk, oraclePrice] = await Promise.all([
      publicClient.readContract({
        address: deployment.contracts.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getBestBidPrice",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: deployment.contracts.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getBestAskPrice",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: deployment.contracts.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getMarketPrice",
      }) as Promise<bigint>,
    ]);

    assert.ok(bestBid > 0n && bestAsk > 0n);
    const spreadBps = ((bestAsk - bestBid) * 10000n) / oraclePrice;
    assert.ok(spreadBps >= 50n, `spread ${spreadBps}bps should be >= 50bps (minSpreadBps)`);
  });

  it("should have on-chain best bid/ask matching health API", async () => {
    const [onChainBid, onChainAsk] = await Promise.all([
      publicClient.readContract({
        address: deployment.contracts.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getBestBidPrice",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: deployment.contracts.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getBestAskPrice",
      }) as Promise<bigint>,
    ]);

    const h = await fetchHealth(port);
    const market = h.market as Record<string, unknown>;
    assert.equal(BigInt(market.bestBid as string), onChainBid, "bestBid should match");
    assert.equal(BigInt(market.bestAsk as string), onChainAsk, "bestAsk should match");
  });

  it("should show MM depth in getQuantityAtPrice for each book level", async () => {
    const [bidPrices, askPrices] = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrderBookPrices",
      args: [200n],
    })) as [bigint[], bigint[]];

    assert.ok(bidPrices.length >= 3, "should have at least 3 bid price levels");
    assert.ok(askPrices.length >= 3, "should have at least 3 ask price levels");

    const depthCalls = [
      ...bidPrices.slice(0, 3).map((p) => ({
        address: deployment.contracts.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, true] as const,
      })),
      ...askPrices.slice(0, 3).map((p) => ({
        address: deployment.contracts.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, false] as const,
      })),
    ];
    const results = await publicClient.multicall({ contracts: depthCalls });

    for (let i = 0; i < 6; i++) {
      assert.equal(results[i].status, "success");
      assert.ok((results[i].result as bigint) > 0n, `level ${i} should have non-zero depth`);
    }
  });

  it("should match on-chain collateral balance with health API", async () => {
    const balance = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "balanceOf",
      args: [MM_ACCOUNT.address],
    })) as bigint;

    const h = await fetchHealth(port);
    assert.equal(BigInt((h.inventory as Record<string, unknown>).collateralBalance as string), balance);
  });

  it("should allow taker to simulate matching against MM orders", async () => {
    const h = await fetchHealth(port);
    const bestAsk = BigInt((h.market as Record<string, unknown>).bestAsk as string);
    const qty = parseUnits("1", deployment.config.quantityDecimals);

    const result = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "simulateOrder",
      args: [bestAsk, qty],
    })) as [bigint, bigint, bigint];

    const [filledQty, avgPrice, remainingQty] = result;
    assert.ok(filledQty > 0n, "should fill some quantity");
    assert.ok(avgPrice > 0n, "should have a fill price");
    assert.equal(remainingQty, 0n, "1-unit order should be fully filled");
  });

  it("should have zero position before any fills", async () => {
    const pos = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserPosition",
      args: [MM_ACCOUNT.address],
    })) as { netQuantity: bigint; aggregatedEntryPrice: bigint };

    assert.equal(pos.netQuantity, 0n, "no position before fills");
  });
});

// ── Test group 3: post-fill on-chain state (cumulative) ─────────────────────

describe("MM process — post-fill on-chain state", () => {
  let mm: MakerProcess;
  const port = HEALTH_PORT + 3;
  let publicClient: ReturnType<typeof createTestPublicClient>;

  before(async () => {
    await revertToBase();
    mm = spawnMM(port);
    await waitForReady(mm);
    publicClient = createTestPublicClient();
  });

  after(async () => {
    await stopMM(mm);
  });

  it("should create short position on-chain when taker fills the ask", async () => {
    const h = await fetchHealth(port);
    const bestAsk = BigInt((h.market as Record<string, unknown>).bestAsk as string);
    const qty = parseUnits("1", deployment.config.quantityDecimals);

    const takerWallet = createTestWalletClient(TAKER_ACCOUNT.privateKey);
    const perps = getContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      client: { public: publicClient, wallet: takerWallet },
    });
    await perps.write.createOrder([bestAsk, qty]);

    const pos = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserPosition",
      args: [MM_ACCOUNT.address],
    })) as { netQuantity: bigint; aggregatedEntryPrice: bigint };

    assert.ok(pos.netQuantity < 0n, `MM should be short, got ${pos.netQuantity}`);
    assert.ok(pos.aggregatedEntryPrice > 0n, "entry price should be set");
  });

  it("should have non-zero required margin after position opens", async () => {
    const reqMargin = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getMaintenanceMargin",
      args: [MM_ACCOUNT.address],
    })) as bigint;

    assert.ok(reqMargin > 0n, "required margin should be positive with open position");
  });

  it("should still maintain resting orders after the fill", async () => {
    await waitFor(async () => {
      const h = await fetchHealth(port);
      return ((h.market as Record<string, unknown>).ownOrders as number) >= 5;
    }, 15_000);

    const orderIds = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [MM_ACCOUNT.address],
    })) as `0x${string}`[];

    assert.ok(
      orderIds.length >= 5,
      `should have at least 5 orders after fill, got ${orderIds.length}`,
    );
  });

  it("should show negative unrealized PnL when price rises against short", async () => {
    const ownerWallet = createTestWalletClient(OWNER_ACCOUNT.privateKey);
    const oracle = getContract({
      address: deployment.contracts.oracleAddress,
      abi: priceOracleMockAbi,
      client: { wallet: ownerWallet },
    });
    await oracle.write.setPrice([
      deployment.config.oracle.price * 3n,
      deployment.config.oracle.decimals,
    ]);

    const pnl = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUnrealizedPnl",
      args: [MM_ACCOUNT.address],
    })) as bigint;

    assert.ok(pnl < 0n, `short + rising price should produce negative PnL, got ${pnl}`);
  });

  it("should reduce short when taker fills the bid", async () => {
    // Wait for MM to requote with the new oracle price
    await waitFor(async () => {
      const h = await fetchHealth(port);
      const m = h.market as Record<string, unknown>;
      const s = h.stats as Record<string, unknown>;
      return BigInt(m.bestBid as string) > 0n && (s.reconcileCount as number) > 1;
    }, 15_000);

    const posBefore = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserPosition",
      args: [MM_ACCOUNT.address],
    })) as { netQuantity: bigint };
    const netBefore = posBefore.netQuantity;

    const h = await fetchHealth(port);
    const bestBid = BigInt((h.market as Record<string, unknown>).bestBid as string);
    const qty = parseUnits("1", deployment.config.quantityDecimals);

    const takerWallet = createTestWalletClient(TAKER_ACCOUNT.privateKey);
    const perps = getContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      client: { public: publicClient, wallet: takerWallet },
    });
    // Taker sells into MM's bid
    await perps.write.createOrder([bestBid, -qty]);

    const posAfter = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserPosition",
      args: [MM_ACCOUNT.address],
    })) as { netQuantity: bigint };

    assert.ok(
      posAfter.netQuantity > netBefore,
      `position should reduce toward zero: ${netBefore} → ${posAfter.netQuantity}`,
    );
  });

  it("should not be liquidatable with sufficient collateral", async () => {
    const isLiquidatable = (await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "isLiquidatable",
      args: [MM_ACCOUNT.address],
    })) as boolean;

    assert.equal(isLiquidatable, false, "well-collateralized MM should not be liquidatable");
  });
});

// ── Test group 4: graceful shutdown (clean state) ───────────────────────────

describe("MM process — graceful shutdown", () => {
  let mm: MakerProcess;

  before(async () => {
    await revertToBase();
    mm = spawnMM(HEALTH_PORT + 4);
    await waitForReady(mm);
  });

  after(async () => {
    await stopMM(mm);
  });

  it("should cancel all orders on SIGTERM", async () => {
    const hBefore = await fetchHealth(mm.port);
    assert.ok(((hBefore.market as Record<string, unknown>).ownOrders as number) > 0, "should have orders before shutdown");

    mm.child.kill("SIGTERM");
    const exitCode = await Promise.race([mm.exited, sleep(10_000).then(() => null)]);
    assert.ok(exitCode === 0 || exitCode === null, `should exit cleanly, got ${exitCode}`);

    // Verify on-chain
    const publicClient = createTestPublicClient();
    const orders = await publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [MM_ACCOUNT.address],
    });
    assert.equal((orders as unknown[]).length, 0, "all orders cancelled after SIGTERM");
  });
});
