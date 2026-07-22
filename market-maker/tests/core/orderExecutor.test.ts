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

/** Default $0.03 allowance (≈ 3 × $0.01 tick used by the stub quoter). */
const DEFAULT_ALLOWANCE = 30_000n;
/** Default $50 size allowance (converted to native qty at level price). */
const DEFAULT_SIZE_ALLOWANCE = 50_000_000n;
/** Perps quantity scale (tests default). Futures tests pass `1n`. */
const PERPS_QUANTITY_SCALE = 1_000_000n;

function makeConfig(
  overrides: Partial<OrderExecutorConfig> = {},
): OrderExecutorConfig {
  return {
    requoteCooldownMs: 0,
    urgentRequoteThresholdTicks: 10,
    staleBandAllowance: DEFAULT_ALLOWANCE,
    staleSizeAllowance: DEFAULT_SIZE_ALLOWANCE,
    quantityScale: PERPS_QUANTITY_SCALE,
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

function makeExecutor(
  deps: TestDeps,
  cfg: Partial<OrderExecutorConfig> = {},
): OrderExecutor {
  return new OrderExecutor(
    deps.instrument,
    makeConfig(cfg),
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
   * Worse leftovers coexist with correct grid orders — cancel only the worse
   * ones (outside keep zone). Better-than-grid leftovers are kept.
   */
  it("cancels worse leftovers while keeping the desired grid", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);

    // Worse leftovers well outside the $0.03 allowance.
    seedOrder(deps.book, 3, "buy", 90_000_000n, 1_000_000n);
    seedOrder(deps.book, 4, "sell", 101_000_000n, 1_000_000n);

    const desired: OrderIntent[] = [
      desiredBuy(95_000_000n),
      desiredSell(96_000_000n),
    ];

    await executor.reconcile(desired);

    assert.equal(deps.cancelledOrderIds.length, 2, "worse leftovers cancelled");
    assert.equal(
      deps.placedIntents.length,
      0,
      "no new orders at already-filled prices",
    );
  });

  it("keeps better-than-grid leftovers (does not cancel them as stale)", async () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);

    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);
    seedOrder(deps.book, 3, "buy", 99_000_000n, 1_000_000n); // better bid
    seedOrder(deps.book, 4, "sell", 94_000_000n, 1_000_000n); // better ask

    await executor.reconcile([desiredBuy(95_000_000n), desiredSell(96_000_000n)]);

    assert.equal(deps.cancelledOrderIds.length, 0, "better leftovers kept");
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
    // Abstract tiny sizes — force size allowance off so the top-up path is exercised.
    const executor = makeExecutor(deps, { staleSizeAllowance: 0n });

    seedOrder(deps.book, 1, "buy", 95_000_000n, 2n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 3n);

    executor.recordRequote(0, 0);
    const planned = executor.plan([desiredBuy(95_000_000n, 3n), desiredSell(96_000_000n, 3n)]);
    assert.ok(planned, "requote triggered by quantity deficit");
    assert.equal(planned.cancels.length, 0, "size increase must not cancel resting");
    assert.equal(planned.reduces.length, 0);
    assert.equal(planned.creates.length, 1, "tops up the missing buy size");
    assert.equal(planned.creates[0].size, 1n);
  });

  it("skips top-up when deficit notional is at or below the USD threshold", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps); // $50 default size allowance
    // deficit 10 at price 95 → notional ≈ $0.00095 ≤ $50
    seedOrder(deps.book, 1, "buy", 95_000_000n, 999_990n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);

    executor.recordRequote(0, 0);
    const planned = executor.plan([
      desiredBuy(95_000_000n, 1_000_000n),
      desiredSell(96_000_000n, 1_000_000n),
    ]);
    assert.equal(planned, null, "sub-threshold dust deficit must not requote");
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

  it("returns null when there is no deficit and no stale order", () => {
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
  it("cancels outside the keep zone and keeps on-grid levels", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 95_000_000n); // on-grid → keep
    seedOrder(deps.book, 2, "buy", 93_000_000n); // worse than worstBid 94 − 0.03 → cancel
    seedOrder(deps.book, 3, "sell", 96_000_000n); // on-grid → keep
    seedOrder(deps.book, 4, "sell", 98_000_000n); // worse than worstAsk 97 + 0.03 → cancel

    const planned = executor.plan([
      desiredBuy(95_000_000n),
      desiredBuy(94_000_000n),
      desiredSell(96_000_000n),
      desiredSell(97_000_000n),
    ]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(2)) && cancelled.has(makeOrderId(4)), "outside band cancelled");
    assert.ok(!cancelled.has(makeOrderId(1)) && !cancelled.has(makeOrderId(3)), "on-grid kept");
    assert.equal(planned.creates.length, 2, "missing grid levels placed");
  });

  it("keeps slightly-worse leftovers within the USD allowance", () => {
    const deps = makeDeps();
    // allowance $0.03; tick stub is $0.01 → 2 ticks inside keep zone past worst edge
    const executor = makeExecutor(deps, { staleBandAllowance: DEFAULT_ALLOWANCE });
    seedOrder(deps.book, 1, "buy", 95_000_000n);
    seedOrder(deps.book, 2, "buy", 94_980_000n); // 95 − 0.02 → keep
    seedOrder(deps.book, 3, "sell", 96_000_000n);
    seedOrder(deps.book, 4, "sell", 96_020_000n); // 96 + 0.02 → keep
    seedOrder(deps.book, 5, "buy", 94_960_000n); // 95 − 0.04 → cancel
    seedOrder(deps.book, 6, "sell", 96_040_000n); // 96 + 0.04 → cancel

    const planned = executor.plan([desiredBuy(95_000_000n), desiredSell(96_000_000n)]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(5)) && cancelled.has(makeOrderId(6)), "beyond allowance cancelled");
    assert.ok(
      !cancelled.has(makeOrderId(2)) && !cancelled.has(makeOrderId(4)),
      "within-allowance leftovers kept",
    );
    assert.equal(planned.creates.length, 0);
  });

  it("cancels every resting order on a side when that side is absent from the grid", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    seedOrder(deps.book, 1, "buy", 96_000_000n);
    seedOrder(deps.book, 2, "buy", 93_000_000n);
    seedOrder(deps.book, 3, "sell", 96_000_000n); // on desired ask → keep
    seedOrder(deps.book, 4, "sell", 98_000_000n); // outside keep zone → cancel

    // Desired has only an ask side → no desired bid → all resting buys cancel.
    const planned = executor.plan([desiredSell(96_000_000n)]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(1)) && cancelled.has(makeOrderId(2)), "all bids cancelled");
    assert.ok(cancelled.has(makeOrderId(4)), "outside-band ask cancelled");
    assert.ok(!cancelled.has(makeOrderId(3)), "on-grid ask kept");
  });

  it("cancels a whole trailing order when excess covers it", () => {
    const deps = makeDeps();
    // Tiny abstract sizes → force threshold off so the trim path is exercised.
    const executor = makeExecutor(deps, { staleSizeAllowance: 0n });
    seedOrder(deps.book, 1, "buy", 95_000_000n, 2n);
    seedOrder(deps.book, 2, "buy", 95_000_000n, 2n); // aggregate 4 > desired 2

    const planned = executor.plan([desiredBuy(95_000_000n, 2n)]);
    assert.ok(planned);
    assert.equal(planned.cancels.length, 1, "trailing whole order cancelled");
    assert.equal(planned.cancels[0].orderId, makeOrderId(2));
    assert.equal(planned.reduces.length, 0);
    assert.equal(planned.creates.length, 0);
  });

  it("reduces trailing order in place when excess is partial", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps, { staleSizeAllowance: 0n });
    seedOrder(deps.book, 1, "buy", 95_000_000n, 4n);

    const planned = executor.plan([desiredBuy(95_000_000n, 3n)]);
    assert.ok(planned);
    assert.equal(planned.cancels.length, 0, "FIFO kept via reduce, not cancel");
    assert.equal(planned.reduces.length, 1);
    assert.equal(planned.reduces[0].orderId, makeOrderId(1));
    assert.equal(planned.reduces[0].newSize, 3n);
    assert.equal(planned.creates.length, 0);
  });

  it("skips downsize when excess notional is at or below the USD threshold", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps); // $50 default size allowance
    // excess 10 at price 95 → notional ≈ $0.00095 → keep
    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_010n);

    executor.recordRequote(0, 0);
    const planned = executor.plan([desiredBuy(95_000_000n, 1_000_000n)]);
    assert.equal(planned, null, "sub-threshold dust excess must not requote");
  });

  it("downsizes when excess notional exceeds the USD threshold", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    // $50 at $95 → allowanceQty ≈ 526316; excess 600_000 > allowance → reduce
    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_600_000n);

    const planned = executor.plan([desiredBuy(95_000_000n, 1_000_000n)]);
    assert.ok(planned);
    assert.equal(planned.reduces.length, 1);
    assert.equal(planned.reduces[0].newSize, 1_000_000n);
    assert.equal(planned.cancels.length, 0);
  });

  it("tops up when deficit notional exceeds the same USD threshold", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    // deficit 600_000 at price 95 → above ~526316 allowance → top up
    seedOrder(deps.book, 1, "buy", 95_000_000n, 400_000n);

    const planned = executor.plan([desiredBuy(95_000_000n, 1_000_000n)]);
    assert.ok(planned);
    assert.equal(planned.creates.length, 1);
    assert.equal(planned.creates[0].size, 600_000n);
    assert.equal(planned.cancels.length, 0);
    assert.equal(planned.reduces.length, 0);
  });

  it("futures: $50 size allowance rounds to 1 contract at ~$95", () => {
    const deps = makeDeps();
    // default $50 → allowanceQty = round(50/95) = 1 contract
    const executor = makeExecutor(deps, { quantityScale: 1n });
    seedOrder(deps.book, 1, "buy", 95_000_000n, 2n); // excess 1 ≤ 1 → keep

    executor.recordRequote(0, 0);
    assert.equal(
      executor.plan([desiredBuy(95_000_000n, 1n)]),
      null,
      "1-contract excess within rounded size allowance",
    );

    seedOrder(deps.book, 2, "buy", 95_000_000n, 1n); // have 3, excess 2 > 1
    const planned = executor.plan([desiredBuy(95_000_000n, 1n)]);
    assert.ok(planned);
    assert.ok(planned.cancels.length + planned.reduces.length > 0);
  });
});

// ── combined band + size (grid-slide / strict mode) ────────────────────────

describe("OrderExecutor band + size allowance integration", () => {
  it("on a 1-tick grid slide: places new levels, keeps in-band leftovers, cancels outside", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps, {
      staleBandAllowance: DEFAULT_ALLOWANCE, // $0.03
      staleSizeAllowance: DEFAULT_SIZE_ALLOWANCE,
    });

    // Prior book at mid≈95.5: bid@95 / ask@96 (full size).
    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);
    // Leftover from an earlier failed cancel — slightly worse bid, still in band
    // once the grid slides to worstBid=94.99 (94_990_000): 94.98 >= 94.99−0.03.
    seedOrder(deps.book, 3, "buy", 94_980_000n, 1_000_000n);
    // Far worse ask — outside new worstAsk=97.01 + 0.03.
    seedOrder(deps.book, 4, "sell", 98_000_000n, 1_000_000n);

    // Grid slides up one tick on each side (new levels at 94.99 / 97.01).
    const planned = executor.plan([
      desiredBuy(95_000_000n),
      desiredBuy(94_990_000n),
      desiredSell(96_000_000n),
      desiredSell(97_010_000n),
    ]);
    assert.ok(planned);

    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(4)), "far ask cancelled");
    assert.ok(!cancelled.has(makeOrderId(1)), "old on-grid bid kept (now better leftover)");
    assert.ok(!cancelled.has(makeOrderId(2)), "old on-grid ask kept");
    assert.ok(!cancelled.has(makeOrderId(3)), "in-band worse bid kept");

    const createdPrices = new Set(planned.creates.map((c) => c.price));
    assert.ok(createdPrices.has(94_990_000n), "new bid level placed");
    assert.ok(createdPrices.has(97_010_000n), "new ask level placed");
    assert.equal(planned.reduces.length, 0, "no size trim on this slide");
  });

  it("keeps in-band leftover while downsizing on-grid excess above size allowance", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    // On-grid bid with large excess (>$50) → reduce.
    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_600_000n);
    // Better leftover bid — inside band, off-grid → keep (not trimmed for size).
    seedOrder(deps.book, 2, "buy", 99_000_000n, 1_000_000n);
    seedOrder(deps.book, 3, "sell", 96_000_000n, 1_000_000n);

    const planned = executor.plan([
      desiredBuy(95_000_000n, 1_000_000n),
      desiredSell(96_000_000n, 1_000_000n),
    ]);
    assert.ok(planned);
    assert.equal(planned.reduces.length, 1);
    assert.equal(planned.reduces[0].orderId, makeOrderId(1));
    assert.equal(planned.reduces[0].newSize, 1_000_000n);
    assert.equal(planned.cancels.length, 0, "better leftover must not be cancelled");
    assert.equal(planned.creates.length, 0);
  });

  it("strict mode (zero allowances): cancels any off-grid and trims any size excess", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps, {
      staleBandAllowance: 0n,
      staleSizeAllowance: 0n,
    });

    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_010n); // tiny excess → trim
    seedOrder(deps.book, 2, "buy", 94_990_000n, 1_000_000n); // 1 tick worse, no band slack → cancel
    seedOrder(deps.book, 3, "sell", 96_000_000n, 1_000_000n);

    const planned = executor.plan([
      desiredBuy(95_000_000n, 1_000_000n),
      desiredSell(96_000_000n, 1_000_000n),
    ]);
    assert.ok(planned);
    const cancelled = new Set(planned.cancels.map((o) => o.orderId));
    assert.ok(cancelled.has(makeOrderId(2)), "off-grid cancelled with zero band allowance");
    assert.ok(!cancelled.has(makeOrderId(1)), "on-grid kept for reduce");
    assert.equal(planned.reduces.length, 1);
    assert.equal(planned.reduces[0].newSize, 1_000_000n);
    assert.equal(planned.creates.length, 0);
  });

  it("does not requote on mid move when book stays inside band and size allowance", () => {
    const deps = makeDeps();
    const executor = makeExecutor(deps);
    // Book matches desired; mid can move but structural gates stay clean.
    seedOrder(deps.book, 1, "buy", 95_000_000n, 1_000_000n);
    seedOrder(deps.book, 2, "sell", 96_000_000n, 1_000_000n);
    executor.recordRequote(0, 0);
    // Simulate oracle mid drift without changing the desired grid.
    (deps.oracle as { currentPrice: bigint }).currentPrice = 100_050_000n;

    assert.equal(
      executor.plan([desiredBuy(95_000_000n), desiredSell(96_000_000n)]),
      null,
      "mid drift alone must not trigger requote after band/size gates",
    );
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
