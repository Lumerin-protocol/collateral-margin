import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type pino from "pino";
import { Planner } from "../../src/coordinator/planner.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import type {
  LiquidateOrdersOutcome,
  ReduceToTargetOutcome,
  Venue,
  VenueOrder,
  VenuePosition,
} from "../../src/venues/types.ts";

const USER = "0x000000000000000000000000000000000000beef" as Address;
const VAULT = "0x000000000000000000000000000000000000000a" as Address;
const PME = "0x000000000000000000000000000000000000000b" as Address;
const MARKET_PERPS = keccak256(toHex("perps"));
const MARKET_FUT_A = keccak256(toHex("fut-a"));

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

/** A deliberately controllable Venue stub. Each method is scripted by the test. */
interface FakeVenue extends Venue {
  // Counters for assertions:
  ordersCalls: number;
  reduceCalls: number;
}

function makeFakeVenue(name: Venue["name"], opts: {
  marketId: Hex;
  ordersByCall?: VenueOrder[][];
  positionsByCall?: VenuePosition[][];
  ordersOutcomeByCall?: LiquidateOrdersOutcome[];
  reduceOutcomeByCall?: ReduceToTargetOutcome[];
}): FakeVenue {
  let openOrdersCall = 0;
  let positionsCall = 0;
  let liqOrdersCall = 0;
  let reduceCall = 0;
  const venue: FakeVenue = {
    name,
    ordersCalls: 0,
    reduceCalls: 0,
    marketLabel: () => `${name}-market`,
    async readOpenOrders(_user) {
      const list = opts.ordersByCall?.[openOrdersCall++] ?? [];
      return list;
    },
    async readPositions(_user) {
      // Positions are read once per rank pass; when the script runs out we
      // repeat the last snapshot so ranking stays stable across extra passes.
      const list = opts.positionsByCall?.[positionsCall] ?? opts.positionsByCall?.at(-1) ?? [];
      positionsCall++;
      return list;
    },
    async liquidateOrders(_user, _ids) {
      venue.ordersCalls++;
      const out = opts.ordersOutcomeByCall?.[liqOrdersCall++];
      return out ?? { feeEarned: 0n };
    },
    async reduceToTarget(_user) {
      venue.reduceCalls++;
      const out = opts.reduceOutcomeByCall?.[reduceCall++];
      return out ?? { feeEarned: 0n, positionsClosed: 1 };
    },
  };
  void opts.marketId; // marketId is informational — used by readOpenOrders/readPositions inputs
  return venue;
}

function makeChainStub(healthSequence: Array<{ balance: bigint; im: bigint; mm: bigint }>): Chain {
  let invocation = 0;
  return {
    publicClient: {
      multicall: async ({ contracts }: { contracts: readonly unknown[] }) => {
        const snap = healthSequence[invocation++];
        if (snap === undefined) {
          throw new Error(
            `health snapshot exhausted at call #${invocation} (test scripted ${healthSequence.length})`,
          );
        }
        // Triple per user — match readAccountHealthBatch's contract.
        assert.equal(contracts.length, 3, "single-user triple");
        return [snap.balance, snap.im, snap.mm];
      },
    },
  } as unknown as Chain;
}

function makeConfigStub(): Config {
  return {
    vault: { address: VAULT },
    pme: { address: PME },
    keeper: { dryRun: false },
  } as Config;
}

describe("Planner.run: healthy account on entry", () => {
  it("short-circuits with `healthy` when mmSurplus >= 0", async () => {
    const chain = makeChainStub([{ balance: 1000n, im: 200n, mm: 500n }]);
    const venue = makeFakeVenue("perps", { marketId: MARKET_PERPS });
    const planner = new Planner(chain, makeConfigStub(), [venue], silentLogger);
    const outcome = await planner.run(USER);
    assert.equal(outcome.kind, "healthy");
    assert.equal(venue.ordersCalls, 0, "no liquidate calls when healthy");
    assert.equal(venue.reduceCalls, 0);
  });
});

describe("Planner.run: orders-leg only", () => {
  it("returns `liquidated` when clearing orders restores health", async () => {
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1100n }, // underwater
      { balance: 1000n, im: 600n, mm: 800n }, // healthy after orders cleared
    ]);
    const orderId: Hex = "0x" + "aa".repeat(32) as Hex;
    const venue = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      ordersByCall: [[{ id: orderId, marketId: MARKET_PERPS }]],
      ordersOutcomeByCall: [{ feeEarned: 5n }],
    });

    const planner = new Planner(chain, makeConfigStub(), [venue], silentLogger);
    const outcome = await planner.run(USER);

    assert.equal(outcome.kind, "liquidated");
    if (outcome.kind === "liquidated") {
      assert.equal(outcome.feeEarned, 5n);
      assert.equal(outcome.ordersClosed, 1);
      assert.equal(outcome.positionsClosed, 0);
    }
    assert.equal(venue.ordersCalls, 1);
    assert.equal(venue.reduceCalls, 0);
  });

  it("skips a venue's liquidateOrders call when readOpenOrders returns empty", async () => {
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1100n },
      { balance: 1000n, im: 600n, mm: 800n },
    ]);
    const venue = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      ordersByCall: [[]], // no orders
    });
    const planner = new Planner(chain, makeConfigStub(), [venue], silentLogger);
    await planner.run(USER);
    assert.equal(venue.ordersCalls, 0, "saved the simulate round-trip");
  });

  it("fans out liquidateOrders across every venue with open orders", async () => {
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1100n },
      { balance: 1000n, im: 600n, mm: 800n },
    ]);
    const perps = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      ordersByCall: [[{ id: "0x" + "11".repeat(32) as Hex, marketId: MARKET_PERPS }]],
      ordersOutcomeByCall: [{ feeEarned: 3n }],
    });
    const futures = makeFakeVenue("futures", {
      marketId: MARKET_FUT_A,
      ordersByCall: [[{ id: "0x" + "22".repeat(32) as Hex, marketId: MARKET_FUT_A }]],
      ordersOutcomeByCall: [{ feeEarned: 4n }],
    });
    const planner = new Planner(chain, makeConfigStub(), [perps, futures], silentLogger);
    const outcome = await planner.run(USER);
    assert.equal(perps.ordersCalls, 1);
    assert.equal(futures.ordersCalls, 1);
    if (outcome.kind === "liquidated") {
      assert.equal(outcome.feeEarned, 7n, "fees summed across both venues");
      assert.equal(outcome.ordersClosed, 2);
    } else {
      assert.fail(`expected liquidated, got ${outcome.kind}`);
    }
  });
});

describe("Planner.run: position-leg ranking and execution", () => {
  it("reduces the most-underwater venue first (max summed unrealizedLoss)", async () => {
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1200n }, // entry: under
      { balance: 1000n, im: 800n, mm: 1100n }, // after orders-leg: still under
      { balance: 1000n, im: 600n, mm: 800n }, // after position-leg: healthy
    ]);
    const lightPosId: Hex = "0x" + "01".repeat(32) as Hex;
    const heavyPosId: Hex = "0x" + "02".repeat(32) as Hex;
    const perps = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      ordersByCall: [[]],
      // After orders-leg the planner reads positions on every venue. Light loss.
      positionsByCall: [[{ id: lightPosId, marketId: MARKET_PERPS, unrealizedLoss: 50n, notional: 1000n }]],
    });
    const futures = makeFakeVenue("futures", {
      marketId: MARKET_FUT_A,
      ordersByCall: [[]],
      // Heavy loss → must be reduced first, and one batched call heals the account.
      positionsByCall: [[{ id: heavyPosId, marketId: MARKET_FUT_A, unrealizedLoss: 500n, notional: 2000n }]],
      reduceOutcomeByCall: [{ feeEarned: 12n, positionsClosed: 3 }],
    });

    const planner = new Planner(chain, makeConfigStub(), [perps, futures], silentLogger);
    const outcome = await planner.run(USER);

    assert.equal(perps.reduceCalls, 0, "perps light book never touched");
    assert.equal(futures.reduceCalls, 1, "futures heavy book reduced once");
    if (outcome.kind === "liquidated") {
      assert.equal(outcome.positionsClosed, 3, "batched close reports its lot count");
      assert.equal(outcome.feeEarned, 12n);
    } else {
      assert.fail(`expected liquidated, got ${outcome.kind}`);
    }
  });

  it("drains a gas-chunked book across successive reduceToTarget iterations", async () => {
    // Futures venue returns one worst-first CHUNK per call (gas-bounded), each
    // reporting partial progress while the account stays under MM, until the
    // final chunk restores health. The planner must loop, re-snapshot, and sum
    // the per-chunk lot counts + fees.
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1200n }, // entry under
      { balance: 1000n, im: 950n, mm: 1200n }, // after orders-leg still under
      { balance: 1000n, im: 950n, mm: 1200n }, // after chunk #1 still under
      { balance: 1000n, im: 950n, mm: 1200n }, // after chunk #2 still under
      { balance: 1000n, im: 600n, mm: 800n }, //  after chunk #3 healthy
    ]);
    const posId: Hex = "0x" + "77".repeat(32) as Hex;
    const futures = makeFakeVenue("futures", {
      marketId: MARKET_FUT_A,
      ordersByCall: [[]],
      // Positions still present through the run (FakeVenue repeats the last
      // snapshot), so the venue stays actionable across all three chunks.
      positionsByCall: [[{ id: posId, marketId: MARKET_FUT_A, unrealizedLoss: 500n, notional: 5000n }]],
      reduceOutcomeByCall: [
        { feeEarned: 1n, positionsClosed: 50 },
        { feeEarned: 1n, positionsClosed: 50 },
        { feeEarned: 1n, positionsClosed: 20 },
      ],
    });
    const planner = new Planner(chain, makeConfigStub(), [futures], silentLogger);
    const outcome = await planner.run(USER);

    assert.equal(futures.reduceCalls, 3, "one reduceToTarget per gas-bounded chunk");
    if (outcome.kind === "liquidated") {
      assert.equal(outcome.positionsClosed, 120, "summed lot count across the three chunks");
      assert.equal(outcome.feeEarned, 3n, "summed fees across the three chunks");
    } else {
      assert.fail(`expected liquidated, got ${outcome.kind}`);
    }
  });

  it("tiebreaks equal summed unrealizedLoss by larger notional venue", async () => {
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1100n },
      { balance: 1000n, im: 950n, mm: 1100n }, // still under after orders-leg
      { balance: 1000n, im: 600n, mm: 800n },
    ]);
    const smallId: Hex = "0x" + "0a".repeat(32) as Hex;
    const bigId: Hex = "0x" + "0b".repeat(32) as Hex;
    const perps = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      ordersByCall: [[]],
      positionsByCall: [[{ id: smallId, marketId: MARKET_PERPS, unrealizedLoss: 100n, notional: 500n }]],
    });
    const futures = makeFakeVenue("futures", {
      marketId: MARKET_FUT_A,
      ordersByCall: [[]],
      positionsByCall: [[{ id: bigId, marketId: MARKET_FUT_A, unrealizedLoss: 100n, notional: 5000n }]],
      reduceOutcomeByCall: [{ feeEarned: 2n, positionsClosed: 1 }],
    });
    const planner = new Planner(chain, makeConfigStub(), [perps, futures], silentLogger);
    await planner.run(USER);
    assert.equal(futures.reduceCalls, 1, "bigger-notional venue reduced first");
    assert.equal(perps.reduceCalls, 0);
  });

  it("on OrdersStillOpen, replays orders-leg and retries on the next iteration", async () => {
    // Sequence of health snapshots:
    //   1. entry           — under
    //   2. after 1st orders-leg — still under
    //   3. after stale reduce attempt — still under (no-op since revert)
    //   4. after replayed orders-leg + 2nd reduce attempt — healthy
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1100n },
      { balance: 1000n, im: 950n, mm: 1100n },
      { balance: 1000n, im: 950n, mm: 1100n },
      { balance: 1000n, im: 600n, mm: 800n },
    ]);
    const positionId: Hex = "0x" + "33".repeat(32) as Hex;
    const replayedOrderId: Hex = "0x" + "44".repeat(32) as Hex;
    const venue = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      // orders-leg #1 (initial, empty), then race-injected order for the replay.
      ordersByCall: [
        [], // initial: no open orders
        [{ id: replayedOrderId, marketId: MARKET_PERPS }], // race-injected
      ],
      ordersOutcomeByCall: [{ feeEarned: 1n }], // for the replayed call
      positionsByCall: [
        [{ id: positionId, marketId: MARKET_PERPS, unrealizedLoss: 200n, notional: 1000n }],
        [{ id: positionId, marketId: MARKET_PERPS, unrealizedLoss: 200n, notional: 1000n }],
      ],
      reduceOutcomeByCall: [
        { skipped: "ordersStillOpen" },
        { feeEarned: 7n, positionsClosed: 1 },
      ],
    });
    const planner = new Planner(chain, makeConfigStub(), [venue], silentLogger);
    const outcome = await planner.run(USER);

    assert.equal(venue.reduceCalls, 2, "retried reduceToTarget after orders replay");
    assert.equal(venue.ordersCalls, 1, "only the replayed orders-leg called liquidateOrders (initial was empty)");
    if (outcome.kind === "liquidated") {
      assert.equal(outcome.positionsClosed, 1);
      assert.equal(outcome.ordersClosed, 1);
      assert.equal(outcome.feeEarned, 8n, "1 (orders) + 7 (position) = 8");
    } else {
      assert.fail(`expected liquidated, got ${outcome.kind}`);
    }
  });

  it("returns `stalled: nothingToClose` when every venue can't size a close", async () => {
    const chain = makeChainStub([
      { balance: 1000n, im: 950n, mm: 1100n }, // entry under
      { balance: 1000n, im: 950n, mm: 1100n }, // after orders-leg still under
      { balance: 1000n, im: 950n, mm: 1100n }, // after parked reduce still under
    ]);
    const id: Hex = "0x" + "55".repeat(32) as Hex;
    const venue = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      ordersByCall: [[]],
      positionsByCall: [[{ id, marketId: MARKET_PERPS, unrealizedLoss: 50n, notional: 100n }]],
      reduceOutcomeByCall: [{ skipped: "nothingToClose" }],
    });
    const planner = new Planner(chain, makeConfigStub(), [venue], silentLogger);
    const outcome = await planner.run(USER);
    assert.equal(outcome.kind, "stalled");
    if (outcome.kind === "stalled") {
      assert.equal(outcome.reason, "nothingToClose");
    }
    assert.equal(venue.reduceCalls, 1, "parked after one nothingToClose");
  });

  it("returns `badDebt` when no positions remain but mmSurplus stays negative", async () => {
    // After orders-leg there's nothing left to close — pure bad debt.
    const chain = makeChainStub([
      { balance: 100n, im: 200n, mm: 500n }, // entry under
      { balance: 100n, im: 200n, mm: 500n }, // still under after empty orders-leg
    ]);
    const venue = makeFakeVenue("perps", {
      marketId: MARKET_PERPS,
      ordersByCall: [[]], // nothing to clear
      positionsByCall: [[]], // and no positions either
    });
    const planner = new Planner(chain, makeConfigStub(), [venue], silentLogger);
    const outcome = await planner.run(USER);
    assert.equal(outcome.kind, "badDebt");
  });
});
