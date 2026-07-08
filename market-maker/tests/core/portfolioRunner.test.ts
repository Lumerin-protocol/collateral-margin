import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRoll,
  gasCostUsd,
  runPortfolioTick,
  type PortfolioTickDeps,
  type PortfolioTickState,
} from "../../src/core/portfolioRunner.ts";
import type { MarketRuntime } from "../../src/core/marketRuntime.ts";
import type { InstrumentAdapter } from "../../src/core/adapter.ts";
import type { MarketIntents, SubmitResult } from "../../src/core/txCoordinator.ts";

const noop = () => {};
function makeLogger(): never {
  return {
    child: () => makeLogger(),
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as never;
}

const RECEIPT = { gasUsed: 100_000n, effectiveGasPrice: 2_000_000_000n };

interface FakeMarket {
  runtime: MarketRuntime;
  calls: {
    updated: number;
    planned: number;
    cancelAll: number;
    started: number;
    stopped: number;
    requotes: { placed: number; cancelled: number }[];
  };
}

/**
 * A stand-in `MarketRuntime`. `plan` returns fixed intents so we can drive the
 * runner's staging (pause/halt/roll/attribution) without any on-chain wiring.
 */
function makeMarket(
  id: string,
  planResult: { cancels: number; creates: number } | null,
): FakeMarket {
  const instrument = { id } as unknown as InstrumentAdapter;
  const calls: FakeMarket["calls"] = {
    updated: 0,
    planned: 0,
    cancelAll: 0,
    started: 0,
    stopped: 0,
    requotes: [],
  };
  const runtime = {
    id,
    instrument,
    update: async () => {
      calls.updated++;
    },
    plan: (): MarketIntents | null => {
      calls.planned++;
      if (!planResult) return null;
      return {
        instrument,
        cancels: Array.from({ length: planResult.cancels }, (_, i) => ({
          orderId: `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`,
        })),
        creates: Array.from({ length: planResult.creates }, () => ({
          side: "buy" as const,
          price: 1n,
          size: 1n,
        })),
      };
    },
    cancelAll: async () => {
      calls.cancelAll++;
    },
    start: async () => {
      calls.started++;
      return true;
    },
    stop: () => {
      calls.stopped++;
    },
    recordRequote: (placed: number, cancelled: number) => {
      calls.requotes.push({ placed, cancelled });
    },
  } as unknown as MarketRuntime;
  return { runtime, calls };
}

interface DepOverrides {
  sharedThrows?: boolean;
  riskOk?: boolean;
  submit?: (all: MarketIntents[]) => Promise<SubmitResult>;
  graceMs?: number;
  rollCheckIntervalMs?: number;
  onRoll?: PortfolioTickDeps["onRoll"];
}

interface Tracked {
  deps: PortfolioTickDeps;
  health: { status: string; lastError: unknown };
  spies: {
    gasUpdates: number;
    collateralUpdates: number;
    topUps: number;
    riskChecks: number;
    recordedGas: bigint[];
    submits: MarketIntents[][];
  };
}

function makeDeps(over: DepOverrides = {}): Tracked {
  const health = { status: "init", lastError: null as unknown };
  const spies: Tracked["spies"] = {
    gasUpdates: 0,
    collateralUpdates: 0,
    topUps: 0,
    riskChecks: 0,
    recordedGas: [],
    submits: [],
  };

  const defaultSubmit = async (all: MarketIntents[]): Promise<SubmitResult> => ({
    receipts: [RECEIPT],
    errors: [],
    ordersPlaced: all.reduce((n, i) => n + i.creates.length, 0),
    ordersCancelled: all.reduce((n, i) => n + i.cancels.length, 0),
    gateDenied: false,
  });

  const deps: PortfolioTickDeps = {
    gas: {
      update: async () => {
        spies.gasUpdates++;
        if (over.sharedThrows) throw new Error("gas rpc down");
      },
      cappedGasPrice: () => 3_000_000_000n,
      ethPriceUsd: 2_000_000_000n,
    } as unknown as PortfolioTickDeps["gas"],
    collateral: {
      update: async () => {
        spies.collateralUpdates++;
      },
      maybeTopUp: async () => {
        spies.topUps++;
      },
      canPlace: async () => true,
    } as unknown as PortfolioTickDeps["collateral"],
    risk: {
      check: () => {
        spies.riskChecks++;
        return over.riskOk ?? true;
      },
      haltReason: { message: "drawdown breach" },
      recordGasCost: (usd: bigint) => spies.recordedGas.push(usd),
    } as unknown as PortfolioTickDeps["risk"],
    coordinator: {
      submit: async (all: MarketIntents[]) => {
        spies.submits.push(all);
        return (over.submit ?? defaultSubmit)(all);
      },
    } as unknown as PortfolioTickDeps["coordinator"],
    health: health as unknown as PortfolioTickDeps["health"],
    logger: makeLogger(),
    dryRun: false,
    graceMs: over.graceMs ?? 30_000,
    rollCheckIntervalMs: over.rollCheckIntervalMs ?? 60_000,
    onRoll: over.onRoll,
  };
  return { deps, health, spies };
}

function makeState(
  markets: MarketRuntime[],
  over: Partial<PortfolioTickState> = {},
): PortfolioTickState {
  return {
    markets,
    lastSharedOkAt: 0,
    pauseNew: false,
    lastRollAt: 0,
    ...over,
  };
}

describe("runPortfolioTick", () => {
  it("happy path: updates, plans, submits, records gas and requotes", async () => {
    const m = makeMarket("perps", { cancels: 1, creates: 2 });
    const { deps, health, spies } = makeDeps();
    const now = 1_000;

    const res = await runPortfolioTick(now, deps, makeState([m.runtime], { lastSharedOkAt: now }));

    assert.equal(res.halted, false);
    assert.equal(spies.gasUpdates, 1);
    assert.equal(spies.collateralUpdates, 1);
    assert.equal(spies.topUps, 1);
    assert.equal(m.calls.updated, 1);
    assert.equal(spies.submits.length, 1);
    assert.equal(spies.submits[0][0].creates.length, 2, "creates kept when fresh");
    // Gas recorded per receipt, requote attributed to the planning market.
    assert.deepEqual(spies.recordedGas, [gasCostUsd(RECEIPT, 2_000_000_000n)]);
    assert.deepEqual(m.calls.requotes, [{ placed: 2, cancelled: 1 }]);
    assert.equal(health.status, "running");
    assert.equal(health.lastError, null, "clears stale error after a clean tick");
    assert.equal(res.state.pauseNew, false);
  });

  it("skips submission and clears a stale error on an idle tick", async () => {
    const m = makeMarket("perps", null);
    const { deps, health, spies } = makeDeps();
    health.lastError = { message: "stale from an earlier tick" };
    const res = await runPortfolioTick(1_000, deps, makeState([m.runtime], { lastSharedOkAt: 1_000 }));
    assert.equal(spies.submits.length, 0);
    assert.equal(res.halted, false);
    assert.equal(health.lastError, null, "idle fresh tick clears the prior error");
  });

  it("clears a stale error after a clean active (submitting) tick", async () => {
    const m = makeMarket("perps", { cancels: 1, creates: 2 });
    const { deps, health } = makeDeps();
    health.lastError = { message: "revert from a previous tick" };
    await runPortfolioTick(1_000, deps, makeState([m.runtime], { lastSharedOkAt: 1_000 }));
    assert.equal(health.lastError, null, "recovered active tick must clear the stale error");
  });

  it("surfaces a shared-input failure onto health even within the grace window", async () => {
    const m = makeMarket("perps", { cancels: 1, creates: 0 });
    const { deps, health } = makeDeps({ sharedThrows: true, graceMs: 30_000 });
    await runPortfolioTick(5_000, deps, makeState([m.runtime], { lastSharedOkAt: 0 }));
    assert.equal((health.lastError as { message: string }).message, "gas rpc down");
  });

  it("keeps placing within the staleness grace window on a shared-input failure", async () => {
    const m = makeMarket("perps", { cancels: 1, creates: 2 });
    const { deps, spies } = makeDeps({ sharedThrows: true, graceMs: 30_000 });
    // Failure happened only 5s after the last good refresh → still in grace.
    const res = await runPortfolioTick(5_000, deps, makeState([m.runtime], { lastSharedOkAt: 0 }));

    assert.equal(res.state.pauseNew, false, "not paused inside grace");
    assert.equal(spies.riskChecks, 0, "risk gate skipped on stale shared data");
    assert.equal(spies.submits.length, 1);
    assert.equal(spies.submits[0][0].creates.length, 2, "creates still allowed in grace");
  });

  it("pauses new placements (keeps cancels) when shared inputs are stale past grace", async () => {
    const withWork = makeMarket("perps", { cancels: 1, creates: 2 });
    const cancelsOnly = makeMarket("futures", { cancels: 3, creates: 0 });
    const createsOnly = makeMarket("futures2", { cancels: 0, creates: 4 });
    const { deps, spies } = makeDeps({ sharedThrows: true, graceMs: 10_000 });

    const res = await runPortfolioTick(
      100_000,
      deps,
      makeState([withWork.runtime, cancelsOnly.runtime, createsOnly.runtime], { lastSharedOkAt: 0 }),
    );

    assert.equal(res.state.pauseNew, true);
    const submitted = spies.submits[0];
    // createsOnly is filtered out (no cancels, creates stripped); others keep cancels only.
    assert.equal(submitted.length, 2);
    for (const intent of submitted) assert.equal(intent.creates.length, 0, "creates stripped");
    assert.equal(submitted.reduce((n, i) => n + i.cancels.length, 0), 4);
  });

  it("halts and cancels every market on a confirmed risk breach with fresh data", async () => {
    const a = makeMarket("perps", { cancels: 0, creates: 2 });
    const b = makeMarket("futures", { cancels: 0, creates: 2 });
    const { deps, health, spies } = makeDeps({ riskOk: false });

    const res = await runPortfolioTick(
      1_000,
      deps,
      makeState([a.runtime, b.runtime], { lastSharedOkAt: 1_000 }),
    );

    assert.equal(res.halted, true);
    assert.equal(a.calls.cancelAll, 1);
    assert.equal(b.calls.cancelAll, 1);
    assert.equal(spies.submits.length, 0, "no submissions after a halt");
    assert.equal(health.status, "error");
    assert.deepEqual(health.lastError, { message: "drawdown breach" });
  });

  it("does not halt on a would-be breach when shared data is stale", async () => {
    const a = makeMarket("perps", { cancels: 1, creates: 0 });
    const { deps, spies } = makeDeps({ sharedThrows: true, riskOk: false, graceMs: 10_000 });

    const res = await runPortfolioTick(1_000, deps, makeState([a.runtime], { lastSharedOkAt: 0 }));

    assert.equal(res.halted, false, "stale data must not trigger a halt");
    assert.equal(spies.riskChecks, 0);
    assert.equal(a.calls.cancelAll, 0);
  });

  it("surfaces a submission error onto health without halting", async () => {
    const m = makeMarket("perps", { cancels: 0, creates: 1 });
    const { deps, health } = makeDeps({
      submit: async () => ({
        receipts: [],
        errors: [new Error("venue revert")],
        ordersPlaced: 0,
        ordersCancelled: 0,
        gateDenied: false,
      }),
    });

    const res = await runPortfolioTick(1_000, deps, makeState([m.runtime], { lastSharedOkAt: 1_000 }));
    assert.equal(res.halted, false);
    assert.equal(health.status, "running");
    assert.equal((health.lastError as { message: string }).message, "venue revert");
  });

  it("runs the roll when the interval has elapsed and swaps the market set", async () => {
    const stay = makeMarket("futures@1", { cancels: 0, creates: 0 });
    const dropped = makeMarket("futures@2", { cancels: 0, creates: 0 });
    const added = makeMarket("futures@3", { cancels: 0, creates: 0 });
    const { deps } = makeDeps({
      rollCheckIntervalMs: 1_000,
      onRoll: async () => ({ add: [added.runtime], removeIds: ["futures@2"] }),
    });

    const res = await runPortfolioTick(
      5_000,
      deps,
      makeState([stay.runtime, dropped.runtime], { lastSharedOkAt: 5_000, lastRollAt: 0 }),
    );

    assert.deepEqual(
      res.state.markets.map((mk) => mk.id),
      ["futures@1", "futures@3"],
    );
    assert.equal(dropped.calls.cancelAll, 1);
    assert.equal(dropped.calls.stopped, 1);
    assert.equal(added.calls.started, 1);
    assert.equal(res.state.lastRollAt, 5_000);
  });
});

describe("applyRoll", () => {
  it("cancels+stops removed markets, starts added ones, and splices the set", async () => {
    const keep = makeMarket("a", null);
    const drop = makeMarket("b", null);
    const add = makeMarket("c", null);
    const next = await applyRoll(
      [keep.runtime, drop.runtime],
      async () => ({ add: [add.runtime], removeIds: ["b"] }),
      makeLogger(),
    );
    assert.deepEqual(next.map((m) => m.id), ["a", "c"]);
    assert.equal(drop.calls.cancelAll, 1);
    assert.equal(drop.calls.stopped, 1);
    assert.equal(add.calls.started, 1);
    assert.equal(keep.calls.cancelAll, 0);
  });

  it("is a no-op that keeps the same set when there is nothing to roll", async () => {
    const keep = makeMarket("a", null);
    const current = [keep.runtime];
    const next = await applyRoll(current, async () => ({ add: [], removeIds: [] }), makeLogger());
    assert.equal(next, current, "returns the same reference");
    assert.equal(keep.calls.started, 0);
    assert.equal(keep.calls.stopped, 0);
  });

  it("keeps the current set when the roll callback throws", async () => {
    const keep = makeMarket("a", null);
    const current = [keep.runtime];
    const next = await applyRoll(
      current,
      async () => {
        throw new Error("venue read failed");
      },
      makeLogger(),
    );
    assert.equal(next, current);
    assert.equal(keep.calls.cancelAll, 0);
  });
});

describe("gasCostUsd", () => {
  it("returns 0 when the ETH price is unknown", () => {
    assert.equal(gasCostUsd({ gasUsed: 21_000n, effectiveGasPrice: 1n }, 0n), 0n);
  });

  it("scales gasUsed * price * ethUsd down by 1e18", () => {
    // 100000 gas * 2 gwei * $2000 (8-dp) / 1e18
    const cost = gasCostUsd({ gasUsed: 100_000n, effectiveGasPrice: 2_000_000_000n }, 2_000_000_000n);
    assert.equal(cost, (100_000n * 2_000_000_000n * 2_000_000_000n) / 10n ** 18n);
  });
});
