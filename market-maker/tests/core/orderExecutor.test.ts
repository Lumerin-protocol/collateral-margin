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

// ── plan() / cooldown / gas-spike deferral ─────────────────────────────────

describe("OrderExecutor.plan", () => {
  function spikingGas(): GasTracker {
    return {
      isGasSpiking: true,
      gasSpikePct: 300,
      cappedGasPrice: () => 1_000_000_000n,
      ethPriceUsd: 0n,
    } as unknown as GasTracker;
  }

  it("defers a requote during a gas spike when drift is below the urgent threshold", () => {
    const deps = makeDeps({ gas: spikingGas() });
    const executor = makeExecutor(deps);
    // Anchor the last quote at the current oracle price → drift == 0 ticks.
    executor.recordRequote(0, 0);
    // A count deficit (empty book vs 2 desired) makes a requote warranted…
    const planned = executor.plan([desiredBuy(95_000_000n), desiredSell(96_000_000n)]);
    // …but the gas-spike guard defers it because drift (0) < urgent (10).
    assert.equal(planned, null);
  });

  it("requotes anyway during a gas spike when drift exceeds the urgent threshold", () => {
    const deps = makeDeps({ gas: spikingGas() });
    const executor = makeExecutor(deps);
    // No recordRequote → lastQuoteMid is 0 → drift is infinite → proceed.
    const planned = executor.plan([desiredBuy(95_000_000n), desiredSell(96_000_000n)]);
    assert.ok(planned);
    assert.equal(planned.creates.length, 2);
  });

  it("returns null while inside the requote cooldown", () => {
    const deps = makeDeps();
    const executor = new OrderExecutor(
      deps.instrument,
      makeConfig({ requoteCooldownMs: 60_000 }),
      deps.quoter,
      deps.book,
      deps.gas,
      deps.risk,
      deps.oracle,
      makeLogger(),
    );
    executor.recordRequote(0, 0); // sets lastRequoteAt = now
    assert.equal(executor.plan([desiredBuy(95_000_000n)]), null);
  });

  it("returns null when there is no deficit, no stale order, and no drift", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 95_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n);
    executor.recordRequote(0, 0); // lastQuoteMid = oracle.currentPrice → drift 0
    assert.equal(
      executor.plan([desiredBuy(95_000_000n), desiredSell(96_000_000n)]),
      null,
    );
  });

  it("records requote stats and timing", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    executor.recordRequote(3, 2);
    assert.equal(executor.stats.ordersPlaced, 3);
    assert.equal(executor.stats.ordersCancelled, 2);
    assert.equal(executor.stats.reconcileCount, 1);
  });
});

// ── limit-mode (perps) stale detection ─────────────────────────────────────

describe("OrderExecutor limit-mode stale detection", () => {
  function limitDeps(): TestDeps {
    const deps = makeDeps();
    (deps.instrument as unknown as { book: { matchingMode: MatchingMode } }).book.matchingMode =
      "limit";
    return deps;
  }

  it("keeps orders at-least-as-aggressive as the grid, cancels worse ones", () => {
    const deps = limitDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 96_000_000n); // better than worst bid → keep
    seedOrder(deps.book, 2, "buy", 93_000_000n); // worse than worst bid → stale
    seedOrder(deps.book, 3, "sell", 95_000_000n); // better than worst ask → keep
    seedOrder(deps.book, 4, "sell", 98_000_000n); // worse than worst ask → stale

    const planned = executor.plan([
      desiredBuy(95_000_000n),
      desiredBuy(94_000_000n), // worst desired bid
      desiredSell(96_000_000n),
      desiredSell(97_000_000n), // worst desired ask
    ]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(2)) && cancelled.has(makeOrderId(4)), "worse cancelled");
    assert.ok(!cancelled.has(makeOrderId(1)) && !cancelled.has(makeOrderId(3)), "better kept");
  });

  it("treats every resting order on a side as stale when that side is absent from the grid", () => {
    const deps = limitDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 96_000_000n);
    seedOrder(deps.book, 2, "buy", 93_000_000n);
    seedOrder(deps.book, 3, "sell", 95_000_000n); // 95 > 96? no → keep
    seedOrder(deps.book, 4, "sell", 98_000_000n); // 98 > 96? yes → stale

    // Desired has only an ask side → no desired bid → all resting buys stale.
    const planned = executor.plan([desiredSell(96_000_000n)]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(1)) && cancelled.has(makeOrderId(2)), "all bids stale");
    assert.ok(cancelled.has(makeOrderId(4)), "worse ask stale");
    assert.ok(!cancelled.has(makeOrderId(3)), "aggressive ask kept");
  });
});

// ── reconcile() gate + cancelAll ───────────────────────────────────────────

describe("OrderExecutor reconcile gate and cancelAll", () => {
  it("cancels stale orders but places nothing when the engine denies placement", async () => {
    const deps = makeDeps({
      risk: {
        throttled: false,
        recordGasCost: noop,
        canPlaceOrders: async () => false,
      } as unknown as RiskManager,
    });
    seedOrder(deps.book, 1, "buy", 99_000_000n); // stale vs desired buy@95
    const executor = makeExecutor(deps);

    await executor.reconcile([desiredBuy(95_000_000n), desiredSell(96_000_000n)]);

    assert.equal(deps.placedIntents.length, 0, "denied creates are dropped");
    assert.equal(deps.cancelledOrderIds.length, 1, "stale order still cancelled");
    assert.equal(executor.stats.ordersPlaced, 0);
    assert.equal(executor.stats.ordersCancelled, 1);
  });

  it("cancelAll cancels every resting order and records the count", async () => {
    const deps = makeDeps();
    seedOrder(deps.book, 1, "buy", 95_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n);
    const executor = makeExecutor(deps);

    await executor.cancelAll();

    assert.equal(deps.cancelledOrderIds.length, 2);
    assert.equal(deps.placedIntents.length, 0);
    assert.equal(executor.stats.ordersCancelled, 2);
  });

  it("cancelAll is a no-op on an empty book", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    await executor.cancelAll();
    assert.equal(deps.cancelledOrderIds.length, 0);
  });
});
