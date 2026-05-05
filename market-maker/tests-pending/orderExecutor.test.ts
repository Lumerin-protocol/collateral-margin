import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { OrderExecutor } from "../src/orderExecutor.ts";
import { hashPowerPerpsDexAbi } from "../src/abi.ts";
import type { MakerConfig } from "../src/config.ts";
import type { Quoter, DesiredQuotes } from "../src/quoter.ts";
import type { BookTracker, OwnOrder } from "../src/bookTracker.ts";
import type { GasTracker } from "../src/gasTracker.ts";
import type { RiskManager } from "../src/riskManager.ts";
import type { OracleTracker } from "../src/oracleTracker.ts";

function makeConfig(overrides: Partial<MakerConfig> = {}): MakerConfig {
  return {
    network: "hardhat",
    ethNodeAddress: "http://localhost:8545",
    perpsAddress: "0x0000000000000000000000000000000000000001",
    makerPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    numLevelsPerSide: 3,
    baseQuantity: 1_000_000n,
    minSpreadBps: 10,
    requoteCooldownMs: 0,
    requoteThresholdTicks: 2,
    urgentRequoteThresholdTicks: 10,
    dryRun: false,
    ...overrides,
  } as MakerConfig;
}

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

function makeOrderId(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

interface TestDeps {
  config: MakerConfig;
  quoter: Quoter;
  book: BookTracker;
  gas: GasTracker;
  risk: RiskManager;
  oracle: OracleTracker;
  txHashes: string[];
  cancelledOrders: unknown[];
  placedOrders: unknown[];
}

function makeDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  const txHashes: string[] = [];
  const cancelledOrders: unknown[] = [];
  const placedOrders: unknown[] = [];

  return {
    config: makeConfig(),
    quoter: {
      getTick: () => 10_000n,
    } as unknown as Quoter,
    book: {
      ownOrders: new Map<`0x${string}`, OwnOrder>(),
    } as unknown as BookTracker,
    gas: {
      isGasSpiking: false,
      gasSpikePct: 0,
      cappedGasPrice: () => 1_000_000_000n,
      ethPriceUsd: 2_000_000_000n,
    } as unknown as GasTracker,
    risk: {
      throttled: false,
      recordGasCost: noop,
    } as unknown as RiskManager,
    oracle: {
      currentPrice: 100_000_000n,
    } as unknown as OracleTracker,
    txHashes,
    cancelledOrders,
    placedOrders,
    ...overrides,
  };
}

function makeExecutor(deps: TestDeps): OrderExecutor {
  const mockPublicClient = {
    waitForTransactionReceipt: async () => ({ gasUsed: 200_000n, effectiveGasPrice: 1_000_000_000n }),
  };

  const mockWalletClient = {
    writeContract: async (args: { functionName: string; args: unknown[] }) => {
      if (args.functionName === "multicall") {
        const calls = args.args[0] as `0x${string}`[];
        for (const callData of calls) {
          const decoded = decodeFunctionData({ abi: hashPowerPerpsDexAbi, data: callData });
          if (decoded.functionName === "cancelOrder") deps.cancelledOrders.push(decoded.args[0]);
          if (decoded.functionName === "createOrder") deps.placedOrders.push(decoded.args);
        }
      }
      deps.txHashes.push("0xabc");
      return "0xabc" as `0x${string}`;
    },
  };

  const mockAccount = { address: "0x1234" as `0x${string}` };
  const mockChain = { id: 31337 };

  return new OrderExecutor(
    mockPublicClient as never,
    mockWalletClient as never,
    mockAccount as never,
    mockChain as never,
    deps.config,
    deps.quoter,
    deps.book,
    deps.gas,
    deps.risk,
    deps.oracle,
    makeLogger(),
  );
}

describe("OrderExecutor", () => {
  it("places new orders when no existing orders", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [{ price: 101_000_000n, quantity: -1_000_000n }],
    };

    await executor.reconcile(desired);
    assert.equal(deps.placedOrders.length, 2);
    assert.equal(deps.cancelledOrders.length, 0);
  });

  it("cancels stale orders and places new ones", async () => {
    const deps = makeDeps();
    const staleId = makeOrderId(1);
    deps.book.ownOrders.set(staleId, { orderId: staleId, price: 95_000_000n, quantity: 1_000_000n });

    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    };

    await executor.reconcile(desired);
    assert.equal(deps.cancelledOrders.length, 1);
    assert.equal(deps.cancelledOrders[0], staleId);
    assert.equal(deps.placedOrders.length, 1);
  });

  it("skips when existing orders match desired prices", async () => {
    const deps = makeDeps();
    const id = makeOrderId(2);
    deps.book.ownOrders.set(id, { orderId: id, price: 99_000_000n, quantity: 1_000_000n });

    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    };

    await executor.reconcile(desired);
    assert.equal(deps.cancelledOrders.length, 0);
    assert.equal(deps.placedOrders.length, 0);
  });

  it("rethrows when multicall fails so tick can set health.lastError", async () => {
    const deps = makeDeps();
    const multicallError = new Error("The contract function \"multicall\" reverted.\n\nError: FailedCall()");
    const mockWalletThrowing = {
      writeContract: async (_args: { functionName: string }) => {
        throw multicallError;
      },
    };
    const executor = new OrderExecutor(
      { waitForTransactionReceipt: async () => ({ gasUsed: 0n, effectiveGasPrice: 0n }) } as never,
      mockWalletThrowing as never,
      { address: "0x1234" as `0x${string}` } as never,
      { id: 31337 } as never,
      deps.config,
      deps.quoter,
      deps.book,
      deps.gas,
      deps.risk,
      deps.oracle,
      makeLogger(),
    );

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    };

    await assert.rejects(() => executor.reconcile(desired), { message: /multicall.*reverted|FailedCall/ });
  });

  it("skips reconcile during cooldown", async () => {
    const deps = makeDeps({ config: makeConfig({ requoteCooldownMs: 999_999 }) });
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    };

    await executor.reconcile(desired);
    assert.equal(deps.placedOrders.length, 1);

    deps.placedOrders.length = 0;
    await executor.reconcile(desired);
    assert.equal(deps.placedOrders.length, 0, "should skip due to cooldown");
  });

  it("skips reconcile during gas spike when drift is below urgent threshold", async () => {
    const deps = makeDeps({
      gas: {
        isGasSpiking: true,
        gasSpikePct: 300,
        cappedGasPrice: () => 1_000_000_000n,
        ethPriceUsd: 2_000_000_000n,
      } as unknown as GasTracker,
    });
    const executor = makeExecutor(deps);

    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });
    assert.equal(deps.placedOrders.length, 1);

    deps.placedOrders.length = 0;
    await executor.reconcile({
      bids: [{ price: 99_500_000n, quantity: 1_000_000n }],
      asks: [],
    });
    assert.equal(deps.placedOrders.length, 0, "should skip gas spike with small drift");
  });

  it("proceeds with reconcile during gas spike when drift exceeds urgent threshold", async () => {
    const deps = makeDeps({
      gas: {
        isGasSpiking: true,
        gasSpikePct: 300,
        cappedGasPrice: () => 1_000_000_000n,
        ethPriceUsd: 2_000_000_000n,
      } as unknown as GasTracker,
      config: makeConfig({ urgentRequoteThresholdTicks: 1 }),
    });
    const executor = makeExecutor(deps);

    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });

    deps.oracle.currentPrice = 200_000_000n;
    deps.placedOrders.length = 0;
    await executor.reconcile({
      bids: [{ price: 199_000_000n, quantity: 1_000_000n }],
      asks: [],
    });
    assert.ok(deps.placedOrders.length > 0, "should proceed despite gas spike due to large drift");
  });

  it("uses dry run mode: logs but does not submit", async () => {
    const deps = makeDeps({ config: makeConfig({ dryRun: true }) });
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [{ price: 101_000_000n, quantity: -1_000_000n }],
    };

    await executor.reconcile(desired);
    assert.equal(deps.txHashes.length, 0, "dry run should not submit tx");
  });

  it("cancelAll cancels all own orders", async () => {
    const deps = makeDeps();
    const id1 = makeOrderId(10);
    const id2 = makeOrderId(11);
    deps.book.ownOrders.set(id1, { orderId: id1, price: 100n, quantity: 10n });
    deps.book.ownOrders.set(id2, { orderId: id2, price: 200n, quantity: 20n });

    const executor = makeExecutor(deps);
    await executor.cancelAll();

    assert.equal(deps.cancelledOrders.length, 2);
  });

  it("cancelAll does nothing when no orders exist", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    await executor.cancelAll();
    assert.equal(deps.cancelledOrders.length, 0);
  });

  it("rethrows on cancelOrder failure so tick can set health.lastError", async () => {
    const deps = makeDeps();
    const id = makeOrderId(20);
    deps.book.ownOrders.set(id, { orderId: id, price: 100n, quantity: 10n });

    const mockPublicClient = {
      waitForTransactionReceipt: async () => ({ gasUsed: 200_000n, effectiveGasPrice: 1_000_000_000n }),
    };
    const mockWalletClient = {
      writeContract: async () => {
        throw new Error("revert");
      },
    };

    const executor = new OrderExecutor(
      mockPublicClient as never,
      mockWalletClient as never,
      { address: "0x1234" as `0x${string}` } as never,
      { id: 31337 } as never,
      deps.config,
      deps.quoter,
      deps.book,
      deps.gas,
      deps.risk,
      deps.oracle,
      makeLogger(),
    );

    const desired: DesiredQuotes = { bids: [], asks: [] };
    await assert.rejects(() => executor.reconcile(desired), { message: "revert" });
  });

  it("rethrows on placeOrder failure so tick can set health.lastError", async () => {
    const deps = makeDeps();
    const mockPublicClient = {
      waitForTransactionReceipt: async () => ({ gasUsed: 200_000n, effectiveGasPrice: 1_000_000_000n }),
    };
    const mockWalletClient = {
      writeContract: async () => {
        throw new Error("out of gas");
      },
    };

    const executor = new OrderExecutor(
      mockPublicClient as never,
      mockWalletClient as never,
      { address: "0x1234" as `0x${string}` } as never,
      { id: 31337 } as never,
      deps.config,
      deps.quoter,
      deps.book,
      deps.gas,
      deps.risk,
      deps.oracle,
      makeLogger(),
    );

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    };
    await assert.rejects(() => executor.reconcile(desired), { message: "out of gas" });
  });

  it("increases cooldown when risk is throttled", async () => {
    const deps = makeDeps({
      config: makeConfig({ requoteCooldownMs: 1000, requoteThresholdTicks: 2 }),
      risk: { throttled: true, recordGasCost: noop } as unknown as RiskManager,
    });
    const executor = makeExecutor(deps);

    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });
    assert.equal(deps.placedOrders.length, 1);

    deps.placedOrders.length = 0;
    await executor.reconcile({
      bids: [{ price: 99_010_000n, quantity: 1_000_000n }],
      asks: [],
    });
    assert.equal(deps.placedOrders.length, 0, "throttled should increase cooldown");
  });

  it("increases requote threshold when risk is throttled", async () => {
    const deps = makeDeps({
      config: makeConfig({ requoteCooldownMs: 0, requoteThresholdTicks: 5 }),
      risk: { throttled: true, recordGasCost: noop } as unknown as RiskManager,
    });
    const executor = makeExecutor(deps);

    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });

    // Simulate that first reconcile placed an order at this price
    const fakeId = makeOrderId(100);
    deps.book.ownOrders.set(fakeId, { orderId: fakeId, price: 99_000_000n, quantity: 1_000_000n });

    deps.placedOrders.length = 0;
    // Drift of ~6 ticks: 60_000 / 10_000 = 6 < threshold*2 = 10
    deps.oracle.currentPrice = 100_060_000n;
    await executor.reconcile({
      bids: [{ price: 99_060_000n, quantity: 1_000_000n }],
      asks: [],
    });
    assert.equal(deps.placedOrders.length, 0, "throttled doubles threshold from 5 to 10; drift of 6 should be below");
  });

  it("cancelAll in dry run mode logs instead of cancelling", async () => {
    const deps = makeDeps({ config: makeConfig({ dryRun: true }) });
    const id = makeOrderId(30);
    deps.book.ownOrders.set(id, { orderId: id, price: 100n, quantity: 10n });

    const executor = makeExecutor(deps);
    await executor.cancelAll();
    assert.equal(deps.txHashes.length, 0, "dry run should not submit cancel tx");
  });

  it("requotes with only asks when no orders exist", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    await executor.reconcile({
      bids: [],
      asks: [{ price: 101_000_000n, quantity: -1_000_000n }],
    });
    assert.equal(deps.placedOrders.length, 1);
  });

  it("skips when no desired quotes and no existing orders", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    await executor.reconcile({ bids: [], asks: [] });
    assert.equal(deps.placedOrders.length, 0);
    assert.equal(deps.cancelledOrders.length, 0);
  });

  it("requotes when lastQuoteMidPrice is 0 and own orders exist", async () => {
    const deps = makeDeps();
    const existingId = makeOrderId(300);
    deps.book.ownOrders.set(existingId, { orderId: existingId, price: 98_000_000n, quantity: 1_000_000n });

    const executor = makeExecutor(deps);

    // First reconcile with existing orders → priceDriftTicks returns Infinity (lastQuoteMidPrice=0)
    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });
    // Stale order cancelled, new one placed
    assert.equal(deps.cancelledOrders.length, 1);
    assert.equal(deps.placedOrders.length, 1);
  });

  it("handles tick=0 in price drift calculation", async () => {
    const deps = makeDeps({
      quoter: { getTick: () => 0n } as unknown as Quoter,
    });
    const executor = makeExecutor(deps);

    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });
    assert.equal(deps.placedOrders.length, 1);

    // Simulate existing orders so shouldRequote reaches priceDriftTicks
    const fakeId = makeOrderId(200);
    deps.book.ownOrders.set(fakeId, { orderId: fakeId, price: 99_000_000n, quantity: 1_000_000n });

    deps.placedOrders.length = 0;
    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });
    // With tick=0, drift returns 0, which is below threshold=2, so no requote
    assert.equal(deps.placedOrders.length, 0);
  });

  it("replaces filled orders even when oracle price has not drifted", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [{ price: 101_000_000n, quantity: -1_000_000n }],
    };

    await executor.reconcile(desired);
    assert.equal(deps.placedOrders.length, 2, "initial placement");

    // Simulate both orders resting on-chain
    const bidId = makeOrderId(500);
    const askId = makeOrderId(501);
    deps.book.ownOrders.set(bidId, { orderId: bidId, price: 99_000_000n, quantity: 1_000_000n });
    deps.book.ownOrders.set(askId, { orderId: askId, price: 101_000_000n, quantity: -1_000_000n });

    // Simulate the ask getting fully filled: BookTracker removes it from ownOrders
    deps.book.ownOrders.delete(askId);
    assert.equal(deps.book.ownOrders.size, 1);

    // Oracle price unchanged — without the fix this reconcile would be skipped
    deps.placedOrders.length = 0;
    deps.cancelledOrders.length = 0;
    await executor.reconcile(desired);

    assert.equal(deps.placedOrders.length, 1, "should place the missing ask");
    assert.equal(deps.cancelledOrders.length, 0, "surviving bid is still at desired price");
  });

  it("replaces multiple filled orders in a single reconcile", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [
        { price: 99_000_000n, quantity: 1_000_000n },
        { price: 98_000_000n, quantity: 2_000_000n },
      ],
      asks: [
        { price: 101_000_000n, quantity: -1_000_000n },
      ],
    };

    await executor.reconcile(desired);
    assert.equal(deps.placedOrders.length, 3, "initial placement");

    // Simulate all three orders resting
    const id1 = makeOrderId(600);
    const id2 = makeOrderId(601);
    const id3 = makeOrderId(602);
    deps.book.ownOrders.set(id1, { orderId: id1, price: 99_000_000n, quantity: 1_000_000n });
    deps.book.ownOrders.set(id2, { orderId: id2, price: 98_000_000n, quantity: 2_000_000n });
    deps.book.ownOrders.set(id3, { orderId: id3, price: 101_000_000n, quantity: -1_000_000n });

    // Both bids filled
    deps.book.ownOrders.delete(id1);
    deps.book.ownOrders.delete(id2);

    deps.placedOrders.length = 0;
    deps.cancelledOrders.length = 0;
    await executor.reconcile(desired);

    assert.equal(deps.placedOrders.length, 2, "should place both missing bids");
    assert.equal(deps.cancelledOrders.length, 0, "surviving ask is still correct");
  });

  it("tops up partially filled bid with deficit quantity", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [{ price: 101_000_000n, quantity: -1_000_000n }],
    };

    await executor.reconcile(desired);
    assert.equal(deps.placedOrders.length, 2, "initial placement");

    // Simulate both orders resting, then bid gets partially filled (1M → 300K)
    const bidId = makeOrderId(700);
    const askId = makeOrderId(701);
    deps.book.ownOrders.set(bidId, { orderId: bidId, price: 99_000_000n, quantity: 300_000n });
    deps.book.ownOrders.set(askId, { orderId: askId, price: 101_000_000n, quantity: -1_000_000n });

    deps.placedOrders.length = 0;
    deps.cancelledOrders.length = 0;
    await executor.reconcile(desired);

    assert.equal(deps.placedOrders.length, 1, "should place top-up order");
    assert.equal(deps.cancelledOrders.length, 0, "should not cancel anything");
    const [topUpPrice, topUpQty] = deps.placedOrders[0] as [bigint, bigint];
    assert.equal(topUpPrice, 99_000_000n, "top-up at same price");
    assert.equal(topUpQty, 700_000n, "top-up for deficit quantity");
  });

  it("tops up partially filled ask with deficit quantity", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [{ price: 101_000_000n, quantity: -1_000_000n }],
    };

    await executor.reconcile(desired);

    // Simulate ask partially filled (-1M → -400K)
    const bidId = makeOrderId(710);
    const askId = makeOrderId(711);
    deps.book.ownOrders.set(bidId, { orderId: bidId, price: 99_000_000n, quantity: 1_000_000n });
    deps.book.ownOrders.set(askId, { orderId: askId, price: 101_000_000n, quantity: -400_000n });

    deps.placedOrders.length = 0;
    deps.cancelledOrders.length = 0;
    await executor.reconcile(desired);

    assert.equal(deps.placedOrders.length, 1, "should place top-up order");
    assert.equal(deps.cancelledOrders.length, 0);
    const [topUpPrice, topUpQty] = deps.placedOrders[0] as [bigint, bigint];
    assert.equal(topUpPrice, 101_000_000n);
    assert.equal(topUpQty, -600_000n, "top-up for deficit (negative = sell)");
  });

  it("skips top-up when existing quantity matches desired", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    };

    await executor.reconcile(desired);

    // Existing order at same price with full quantity
    const bidId = makeOrderId(720);
    deps.book.ownOrders.set(bidId, { orderId: bidId, price: 99_000_000n, quantity: 1_000_000n });

    deps.placedOrders.length = 0;
    deps.cancelledOrders.length = 0;
    await executor.reconcile(desired);

    assert.equal(deps.placedOrders.length, 0, "no top-up needed");
    assert.equal(deps.cancelledOrders.length, 0);
  });

  it("tops up when multiple own orders at same price sum to less than desired", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    const desired: DesiredQuotes = {
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    };

    await executor.reconcile(desired);

    // Two orders at same price, summing to 600K < desired 1M
    const id1 = makeOrderId(730);
    const id2 = makeOrderId(731);
    deps.book.ownOrders.set(id1, { orderId: id1, price: 99_000_000n, quantity: 200_000n });
    deps.book.ownOrders.set(id2, { orderId: id2, price: 99_000_000n, quantity: 400_000n });

    deps.placedOrders.length = 0;
    deps.cancelledOrders.length = 0;
    await executor.reconcile(desired);

    assert.equal(deps.placedOrders.length, 1);
    const [, topUpQty] = deps.placedOrders[0] as [bigint, bigint];
    assert.equal(topUpQty, 400_000n, "deficit = 1M - 600K = 400K");
  });

  it("records gas costs after successful transactions", async () => {
    const gasCosts: bigint[] = [];
    const deps = makeDeps({
      risk: {
        throttled: false,
        recordGasCost: (cost: bigint) => gasCosts.push(cost),
      } as unknown as RiskManager,
    });
    const executor = makeExecutor(deps);

    await executor.reconcile({
      bids: [{ price: 99_000_000n, quantity: 1_000_000n }],
      asks: [],
    });

    assert.ok(gasCosts.length > 0, "should have recorded gas costs");
  });
});
