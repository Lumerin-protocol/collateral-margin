import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OrderExecutor,
  type OrderExecutorConfig,
} from "../../src/core/orderExecutor.ts";
import type {
  InstrumentAdapter,
  OrderIntent,
  OwnOrder,
  MatchingMode,
  ExecuteOrdersIntent,
} from "../../src/core/adapter.ts";
import type { Quoter } from "../../src/core/quoter.ts";
import type { BookTracker } from "../../src/core/bookTracker.ts";
import type { GasTracker } from "../../src/core/gasTracker.ts";
import type { RiskManager } from "../../src/core/riskManager.ts";
import type { OracleTracker } from "../../src/core/oracleTracker.ts";

const noop = () => {};
function makeLogger(): never {
  return {
    child: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
  } as never;
}

function makeOrderId(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function makeConfig(
  overrides: Partial<OrderExecutorConfig> = {},
): OrderExecutorConfig {
  return {
    requoteCooldownMs: 0,
    requoteThresholdTicks: 2,
    urgentRequoteThresholdTicks: 10,
    dryRun: false,
    ...overrides,
  };
}

interface TestDeps {
  instrument: InstrumentAdapter;
  quoter: Quoter;
  book: BookTracker;
  gas: GasTracker;
  risk: RiskManager;
  oracle: OracleTracker;
  cancelledOrderIds: `0x${string}`[];
  placedIntents: OrderIntent[];
}

function makeDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  const cancelledOrderIds: `0x${string}`[] = [];
  const placedIntents: OrderIntent[] = [];

  const deps: TestDeps = {
    instrument: {
      id: "test-instrument",
      book: { matchingMode: "exact" as MatchingMode },
      executeOrders: async (intent: ExecuteOrdersIntent) => {
        for (const c of intent.cancels) cancelledOrderIds.push(c.orderId);
        for (const p of intent.creates) placedIntents.push(p);
        return {
          receipts: [{ gasUsed: 200_000n, effectiveGasPrice: 1_000_000_000n }],
          errors: [],
        };
      },
    } as unknown as InstrumentAdapter,
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
      canPlaceOrders: async () => true,
    } as unknown as RiskManager,
    oracle: {
      currentPrice: 100_000_000n,
    } as unknown as OracleTracker,
    cancelledOrderIds,
    placedIntents,
    ...overrides,
  };
  return deps;
}

function makeExecutor(deps: TestDeps): OrderExecutor {
  return new OrderExecutor(
    deps.instrument,
    makeConfig(),
    deps.quoter,
    deps.book,
    deps.gas,
    deps.risk,
    deps.oracle,
    makeLogger(),
  );
}

function desiredBuy(price: bigint, size = 1_000_000n): OrderIntent {
  return { side: "buy", price, size };
}
function desiredSell(price: bigint, size = 1_000_000n): OrderIntent {
  return { side: "sell", price, size };
}

/**
 * Add a fake own order to the book tracker. The `size` here is unsigned
 * (matches `OwnOrder.size` from the adapter).
 */
function seedOrder(
  book: BookTracker,
  id: number,
  side: "buy" | "sell",
  price: bigint,
  size = 1_000_000n,
): void {
  book.ownOrders.set(makeOrderId(id), {
    orderId: makeOrderId(id),
    price,
    side,
    size,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("OrderExecutor requote guards (regression)", () => {
  /**
   * Bug: when all resting orders are at wrong prices (e.g. stale from a
   * previous oracle level), `hasQuantityDeficit` returned false because no
   * desired level had matching existing orders (`have === undefined`).
   * A requote was never triggered and the book stayed shifted forever.
   */
  it("requotes when all orders are at wrong prices (quantity-deficit fix)", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    // Seed the book with stale orders at wrong prices (oracle was higher).
    seedOrder(deps.book, 1, "buy", 99_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "buy", 98_000_000n, 1_000_000n);
    seedOrder(deps.book, 3, "sell", 101_000_000n, 1_000_000n);
    seedOrder(deps.book, 4, "sell", 102_000_000n, 1_000_000n);

    // Desired quotes are at the current (lower) oracle prices.
    const desired: OrderIntent[] = [
      desiredBuy(95_000_000n),
      desiredSell(96_000_000n),
    ];

    await executor.reconcile(desired);

    // All stale orders must be cancelled.
    assert.equal(
      deps.cancelledOrderIds.length,
      4,
      "all stale orders cancelled",
    );
    // Missing desired levels must be placed.
    assert.equal(deps.placedIntents.length, 2, "missing levels placed");
  });

  /**
   * Bug: when stale orders at wrong prices coexist with correct orders at
   * desired prices (e.g. cancels failed but creates succeeded on a prior
   * reconciliation), the deficit check didn't fire (all desired levels
   * have sufficient quantity), and the stale-orders guard was missing.
   * The wrong-price orders persisted forever.
   */
  it("requotes when stale orders coexist with correct ones (stale-orders guard)", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    // Correct orders at the right prices.
    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);

    // Stale orders at wrong prices (leftover from a previous oracle level
    // whose cancels failed or were never submitted).
    seedOrder(deps.book, 3, "buy", 99_000_000n, 1_000_000n);
    seedOrder(deps.book, 4, "sell", 101_000_000n, 1_000_000n);

    const desired: OrderIntent[] = [
      desiredBuy(95_000_000n),
      desiredSell(96_000_000n),
    ];

    await executor.reconcile(desired);

    // Stale orders must be cancelled.
    assert.equal(deps.cancelledOrderIds.length, 2, "stale orders cancelled");
    // Correct orders must survive (no deficit → no new placement at same prices).
    assert.equal(
      deps.placedIntents.length,
      0,
      "no new orders at already-filled prices",
    );
  });

  /**
   * Sanity: when the book already matches the desired quotes exactly,
   * no reconciliation work should happen.
   */
  it("skips requote when the book matches desired quotes", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);

    const desired: OrderIntent[] = [
      desiredBuy(95_000_000n),
      desiredSell(96_000_000n),
    ];

    await executor.reconcile(desired);

    assert.equal(deps.cancelledOrderIds.length, 0, "no unnecessary cancels");
    assert.equal(deps.placedIntents.length, 0, "no unnecessary placements");
  });
});
