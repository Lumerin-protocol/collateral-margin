import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type AccountSnapshot,
  type MMParams,
  solveFuturesClosesToTarget,
} from "@hashpower/portfolio-margin";
import { FuturesCloseSolver } from "../../src/venues/futuresSolver.ts";

const PARAMS: MMParams = {
  imSpotShock: 15n * 10n ** 16n,
  mmSpotShock: 10n ** 17n,
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};
const MARK = 45_000_000n;
const EMPTY_BOOK = {
  buyQty: 0n,
  sellQty: 0n,
  buyPQ: 0n,
  buyP2Q: 0n,
  sellPQ: 0n,
  sellP2Q: 0n,
};

/** Two $50 long expiries of 10,000 contracts at a $45 mark, under MM. */
const SNAPSHOT: AccountSnapshot = {
  user: "0x1111111111111111111111111111111111111111",
  balance: 163_000_000_000n,
  accountDebt: 0n,
  perp: { netQty: 0n, entryPrice: 0n, orders: EMPTY_BOOK, fundingOwed: 0n },
  futures: {
    positions: [1_756_416_000n, 1_759_008_000n].map((expirationAt) => ({
      expirationAt,
      netQuantity: 10_000n,
      netEntryValue: 50_000_000n * 10_000n,
      settlementPrice: 0n,
    })),
    orders: [],
  },
};

const REQUEST = {
  snapshot: SNAPSHOT,
  params: PARAMS,
  currentPrice: MARK,
  liquidationFee: 0n,
  now: 0n,
};

describe("futures close solver worker", () => {
  it("returns the same legs as the in-process solver", async () => {
    const solver = new FuturesCloseSolver(10_000);
    try {
      const legs = await solver.solve(REQUEST);
      assert.ok(legs.length > 0);
      assert.deepEqual(
        legs,
        solveFuturesClosesToTarget(SNAPSHOT, PARAMS, MARK, 0n, 0n),
      );
    } finally {
      await solver.close();
    }
  });

  it("times out a stuck solve, then serves the next one on a fresh worker", async () => {
    const hanging = new URL(
      "data:text/javascript,import{parentPort}from'node:worker_threads';parentPort.on('message',()=>{});",
    );
    const stuck = new FuturesCloseSolver(200, hanging);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    try {
      await assert.rejects(stuck.solve(REQUEST), /timed out after 200 ms/);
      assert.ok(ticks >= 5, `event loop stayed live (${ticks} ticks)`);
      await assert.rejects(stuck.solve(REQUEST), /timed out/);
    } finally {
      clearInterval(timer);
      await stuck.close();
    }
  });
});
