import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fraction from "fraction.js";
import { MarketRuntime, type MarketRuntimeDeps } from "../../src/core/marketRuntime.ts";
import type { InstrumentAdapter } from "../../src/core/adapter.ts";
import type { OracleTracker } from "../../src/core/oracleTracker.ts";
import type { BookTracker } from "../../src/core/bookTracker.ts";
import type { InventoryManager } from "../../src/core/inventoryManager.ts";
import type { Quoter } from "../../src/core/quoter.ts";
import type { OrderExecutor } from "../../src/core/orderExecutor.ts";

const noop = () => {};
function makeLogger(): never {
  return {
    child: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
  } as never;
}

interface Knobs {
  refreshFails: boolean;
  plan: { cancels: { orderId: `0x${string}` }[]; creates: unknown[] } | null;
}

function makeDeps(knobs: Knobs): { deps: MarketRuntimeDeps; knobs: Knobs; recorded: number[] } {
  const recorded: number[] = [];
  const instrument = {
    id: "futures@1700000000",
    ownOrders: { bootstrap: async () => {} },
  } as unknown as InstrumentAdapter;
  const oracle = {
    initialize: async () => {},
    update: async () => {},
    currentPrice: 100n,
    volatilityPerSecond: new Fraction(0n),
  } as unknown as OracleTracker;
  const book = {
    start: async () => {},
    refresh: async () => {
      if (knobs.refreshFails) throw new Error("rpc down");
    },
    stop: noop,
    bestBid: 99n,
    bestAsk: 101n,
    ownOrders: new Map(),
  } as unknown as BookTracker;
  const inventory = { update: async () => {}, netQuantity: 0n } as unknown as InventoryManager;
  const quoter = {
    initialize: async () => {},
    computeQuotes: () => [],
  } as unknown as Quoter;
  const executor = {
    plan: () => knobs.plan,
    recordRequote: (p: number, _c: number) => recorded.push(p),
    cancelAll: async () => {},
  } as unknown as OrderExecutor;
  return {
    deps: {
      instrument,
      oracle,
      book,
      inventory,
      quoter,
      executor,
      breaker: { quarantineThreshold: 2, baseBackoffMs: 1_000 },
      logger: makeLogger(),
    },
    knobs,
    recorded,
  };
}

describe("MarketRuntime", () => {
  it("starts healthy and reports an active breaker", async () => {
    const { deps } = makeDeps({ refreshFails: false, plan: null });
    const m = new MarketRuntime(deps);
    assert.equal(await m.start(), true);
    assert.equal(m.breaker.state, "active");
    assert.equal(m.healthState().breaker, "active");
    assert.equal(m.healthState().id, "futures@1700000000");
  });

  it("quarantines after repeated update failures and skips planning", async () => {
    const { deps, knobs } = makeDeps({ refreshFails: false, plan: { cancels: [], creates: [] } });
    const m = new MarketRuntime(deps);
    await m.start();

    knobs.refreshFails = true;
    const now = 10_000;
    await m.update(now);
    assert.equal(m.breaker.state, "degraded");
    await m.update(now);
    assert.equal(m.breaker.state, "quarantined");

    // Quarantined → plan is skipped even though a diff exists.
    assert.equal(m.plan(now), null);
    // ...and update is a no-op until backoff elapses.
    assert.equal(m.breaker.canAttempt(now + 500), false);
    assert.equal(m.breaker.canAttempt(now + 1_000), true);
  });

  it("recovers to active after a successful update", async () => {
    const { deps, knobs } = makeDeps({ refreshFails: true, plan: null });
    const m = new MarketRuntime(deps);
    await m.start();
    await m.update(0);
    assert.equal(m.breaker.state, "degraded");
    knobs.refreshFails = false;
    await m.update(1);
    assert.equal(m.breaker.state, "active");
    assert.equal(m.breaker.consecutiveErrors, 0);
  });

  it("plan() emits MarketIntents mapping cancels to orderIds", async () => {
    const { deps } = makeDeps({
      refreshFails: false,
      plan: { cancels: [{ orderId: "0xabc" }], creates: [{ side: "buy", price: 1n, size: 1n }] },
    });
    const m = new MarketRuntime(deps);
    await m.start();
    const intents = m.plan(0);
    assert.ok(intents);
    assert.deepEqual(intents.cancels, [{ orderId: "0xabc" }]);
    assert.equal(intents.creates.length, 1);
    assert.equal(intents.instrument, deps.instrument);
  });

  it("start() swallows init failures and quarantines instead of throwing", async () => {
    const { deps } = makeDeps({ refreshFails: false, plan: null });
    (deps.book as unknown as { start: () => Promise<void> }).start = async () => {
      throw new Error("init boom");
    };
    const m = new MarketRuntime(deps);
    assert.equal(await m.start(), false);
    assert.equal(m.breaker.consecutiveErrors, 1);
  });

  it("lazily initializes on the first update() for a market that never started", async () => {
    const { deps } = makeDeps({ refreshFails: false, plan: { cancels: [], creates: [] } });
    let bootstrapped = 0;
    (deps.instrument as unknown as { ownOrders: { bootstrap: () => Promise<void> } }).ownOrders = {
      bootstrap: async () => {
        bootstrapped++;
      },
    };
    const m = new MarketRuntime(deps);

    // Never called start(); the first update must run the late-init path.
    await m.update(0);
    assert.equal(bootstrapped, 1, "own-order bootstrap ran during late init");
    assert.equal(m.breaker.state, "active");
    assert.ok(m.plan(0), "plans normally once lazily initialized");
  });

  it("recordRequote delegates to the executor", () => {
    const { deps, recorded } = makeDeps({ refreshFails: false, plan: null });
    const m = new MarketRuntime(deps);
    m.recordRequote(3, 1);
    assert.deepEqual(recorded, [3]);
  });

  it("cancelAll swallows executor failures", async () => {
    const { deps } = makeDeps({ refreshFails: false, plan: null });
    (deps.executor as unknown as { cancelAll: () => Promise<void> }).cancelAll = async () => {
      throw new Error("cancel boom");
    };
    const m = new MarketRuntime(deps);
    await m.start();
    await assert.doesNotReject(m.cancelAll());
  });

  it("stop() stops the book tracker", async () => {
    const { deps } = makeDeps({ refreshFails: false, plan: null });
    let stopped = 0;
    (deps.book as unknown as { stop: () => void }).stop = () => {
      stopped++;
    };
    const m = new MarketRuntime(deps);
    await m.start();
    m.stop();
    assert.equal(stopped, 1);
  });

  it("plan() returns null and records an error when quoting throws", async () => {
    const { deps } = makeDeps({ refreshFails: false, plan: { cancels: [], creates: [] } });
    (deps.quoter as unknown as { computeQuotes: () => never }).computeQuotes = () => {
      throw new Error("quote boom");
    };
    const m = new MarketRuntime(deps);
    await m.start();
    assert.equal(m.plan(0), null);
    assert.equal(m.breaker.consecutiveErrors, 1);
  });
});
