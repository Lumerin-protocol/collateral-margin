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
      book: {},
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
   * When all resting orders are worse than the desired grid, quantity deficit
   * alone used to miss the requote (`have === undefined` at desired prices).
   * Stale detection must cancel them and place the grid.
   */
  it("requotes when all orders are worse than the desired grid", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    // Worse than desired bid@95 / ask@96.
    seedOrder(deps.book, 1, "buy", 90_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "buy", 91_000_000n, 1_000_000n);
    seedOrder(deps.book, 3, "sell", 101_000_000n, 1_000_000n);
    seedOrder(deps.book, 4, "sell", 102_000_000n, 1_000_000n);

    const desired: OrderIntent[] = [
      desiredBuy(95_000_000n),
      desiredSell(96_000_000n),
    ];

    await executor.reconcile(desired);

    assert.equal(
      deps.cancelledOrderIds.length,
      4,
      "all worse orders cancelled",
    );
    assert.equal(deps.placedIntents.length, 2, "missing levels placed");
  });

  /**
   * Off-grid leftovers coexist with correct grid orders — cancel only the
   * off-grid ones (exact set-diff).
   */
  it("cancels off-grid leftovers while keeping the desired grid", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);

    // Off-grid leftovers (cancels failed on a prior tick).
    seedOrder(deps.book, 3, "buy", 90_000_000n, 1_000_000n);
    seedOrder(deps.book, 4, "sell", 101_000_000n, 1_000_000n);

    const desired: OrderIntent[] = [
      desiredBuy(95_000_000n),
      desiredSell(96_000_000n),
    ];

    await executor.reconcile(desired);

    assert.equal(deps.cancelledOrderIds.length, 2, "off-grid leftovers cancelled");
    assert.equal(
      deps.placedIntents.length,
      0,
      "no new orders at already-filled prices",
    );
  });

  it("cancels better-than-grid leftovers not on the desired set", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);
    seedOrder(deps.book, 3, "buy", 99_000_000n, 1_000_000n); // better bid, off-grid
    seedOrder(deps.book, 4, "sell", 94_000_000n, 1_000_000n); // better ask, off-grid

    await executor.reconcile([desiredBuy(95_000_000n), desiredSell(96_000_000n)]);

    assert.equal(deps.cancelledOrderIds.length, 2, "off-grid leftovers cancelled");
    assert.equal(deps.placedIntents.length, 0);
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

// ── quantity deficit (qty-bearing orders) ──────────────────────────────────

describe("OrderExecutor quantity deficit", () => {
  it("does not requote when resting size matches the desired grid", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    seedOrder(deps.book, 1, "buy", 95_000_000n, 3n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 3n);

    executor.recordRequote(0, 0);
    const planned = executor.plan([desiredBuy(95_000_000n, 3n), desiredSell(96_000_000n, 3n)]);
    assert.equal(planned, null, "no churn when size and prices match");
  });

  it("requotes when resting size falls below desired qty at a level", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    seedOrder(deps.book, 1, "buy", 95_000_000n, 2n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 3n);

    executor.recordRequote(0, 0);
    const planned = executor.plan([desiredBuy(95_000_000n, 3n), desiredSell(96_000_000n, 3n)]);
    assert.ok(planned, "requote triggered by quantity deficit");
    assert.equal(planned.creates.length, 1, "tops up the missing buy size");
    assert.equal(planned.creates[0].size, 1n);
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

// ── stale detection ────────────────────────────────────────────────────────

describe("OrderExecutor stale detection", () => {
  it("cancels off-grid prices and keeps exact desired levels", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 95_000_000n); // on-grid → keep
    seedOrder(deps.book, 2, "buy", 93_000_000n); // off-grid → cancel
    seedOrder(deps.book, 3, "sell", 96_000_000n); // on-grid → keep
    seedOrder(deps.book, 4, "sell", 98_000_000n); // off-grid → cancel

    const planned = executor.plan([
      desiredBuy(95_000_000n),
      desiredBuy(94_000_000n),
      desiredSell(96_000_000n),
      desiredSell(97_000_000n),
    ]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(2)) && cancelled.has(makeOrderId(4)), "off-grid cancelled");
    assert.ok(!cancelled.has(makeOrderId(1)) && !cancelled.has(makeOrderId(3)), "on-grid kept");
    assert.equal(planned.creates.length, 2, "missing grid levels placed");
  });

  it("cancels every resting order on a side when that side is absent from the grid", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 96_000_000n);
    seedOrder(deps.book, 2, "buy", 93_000_000n);
    seedOrder(deps.book, 3, "sell", 96_000_000n); // on desired ask → keep
    seedOrder(deps.book, 4, "sell", 98_000_000n); // off-grid → cancel

    // Desired has only an ask side → no desired bid → all resting buys cancel.
    const planned = executor.plan([desiredSell(96_000_000n)]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(1)) && cancelled.has(makeOrderId(2)), "all bids cancelled");
    assert.ok(cancelled.has(makeOrderId(4)), "off-grid ask cancelled");
    assert.ok(!cancelled.has(makeOrderId(3)), "on-grid ask kept");
  });

  it("cancels excess size at a desired price", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 95_000_000n, 2n);
    seedOrder(deps.book, 2, "buy", 95_000_000n, 2n); // aggregate 4 > desired 3

    const planned = executor.plan([desiredBuy(95_000_000n, 3n)]);
    assert.ok(planned);
    assert.equal(planned.cancels.length, 1, "one whole order dropped for excess");
    assert.equal(planned.cancels[0].orderId, makeOrderId(2));
    // After cancelling size 2, remaining is 2 < 3 → top up 1.
    assert.equal(planned.creates.length, 1);
    assert.equal(planned.creates[0].size, 1n);
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
    seedOrder(deps.book, 1, "buy", 90_000_000n); // worse than desired buy@95 → stale
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
