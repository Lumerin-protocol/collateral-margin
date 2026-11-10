import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  simulateFuturesClose,
  solveFuturesClosesToTarget,
} from "../src/solve.ts";
import { imRequired, mmRequired, mmSurplus } from "../src/mm.ts";
import type {
  AccountSnapshot,
  Address,
  FuturesCloseLeg,
  MMParams,
} from "../src/types.ts";
import { book } from "./books.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;
const PARAMS: MMParams = {
  imSpotShock: 15n * 10n ** 16n,
  mmSpotShock: 10n ** 17n,
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};
const EXPIRIES = [1_756_416_000n, 1_759_008_000n, 1_761_600_000n];
const MARK = 50_000_000n;

/** Seeded books, and the share of restorable ones the solver may leave underwater. */
const SEED = 1;
const BOOKS = 20_000;
const MAX_MISSES_BPS = 33;

function position(expirationAt: bigint, netQuantity: bigint, entry: bigint) {
  return {
    expirationAt,
    netQuantity,
    netEntryValue: entry * netQuantity,
    settlementPrice: 0n,
  };
}

function overLiquidated(state: AccountSnapshot): boolean {
  const im = imRequired(state, PARAMS, MARK);
  return im > mmRequired(state, PARAMS, MARK) && state.balance > im;
}

/**
 * `HashPowerFutures.liquidatePositions` over `legs`: it stops before a leg once
 * the account is healthy, reverts `OverLiquidation` when a close leaves the
 * balance above IM while IM > MM, and `NotLiquidatable` when nothing closed.
 */
function liquidate(
  snap: AccountSnapshot,
  legs: readonly FuturesCloseLeg[],
): "no legs" | "reverts" | "healthy" | "underwater" {
  if (legs.length === 0) return "no legs";
  let state = snap;
  let closed = 0;
  for (const leg of legs) {
    if (mmSurplus(state, PARAMS, MARK) >= 0n) break;
    state = simulateFuturesClose(state, [leg], MARK, 0n);
    closed++;
    if (overLiquidated(state)) return "reverts";
  }
  if (closed === 0) return "reverts";
  return mmSurplus(state, PARAMS, MARK) >= 0n ? "healthy" : "underwater";
}

/**
 * Whether any `liquidatePositions` call restores MM, by brute force: every leg
 * moves one expiry by any amount, the venue only checks where a leg ends, and it
 * runs on through underwater ends until one is healthy, which the guard must let
 * through.
 */
function anyCloseRestores(snap: AccountSnapshot): boolean {
  const positions = snap.futures.positions;
  const sizes = positions.map((p) =>
    Number(p.netQuantity < 0n ? -p.netQuantity : p.netQuantity),
  );
  const strides: number[] = [];
  let points = 1;
  for (const size of sizes) {
    strides.push(points);
    points *= size + 1;
  }
  const seen = new Uint8Array(points);
  const stateAt = (closed: readonly number[]) =>
    simulateFuturesClose(
      snap,
      positions.flatMap((p, i) => {
        const closeQty = BigInt(closed[i] ?? 0);
        return closeQty > 0n
          ? [{ expirationAt: p.expirationAt, closeQty }]
          : [];
      }),
      MARK,
      0n,
    );
  const queue = [sizes.map(() => 0)];
  seen[0] = 1;
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    for (const [i, size] of sizes.entries()) {
      for (let x = 1; (at[i] ?? 0) + x <= size; x++) {
        const next = [...at];
        next[i] = (at[i] ?? 0) + x;
        const point = next.reduce(
          (sum, v, j) => sum + v * (strides[j] ?? 0),
          0,
        );
        if (seen[point]) continue;
        seen[point] = 1;
        const state = stateAt(next);
        if (mmSurplus(state, PARAMS, MARK) < 0n) queue.push(next);
        else if (!overLiquidated(state)) return true;
      }
    }
  }
  return false;
}

/** mulberry32, so every run draws the same books. */
function random(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/**
 * One to three expiries of up to 12 contracts, mostly long, entered within 20% of
 * the $50 mark; a perp position on some books and account debt on others; a
 * balance between half of MM and MM.
 */
function randomBook(int: (n: number) => number): AccountSnapshot {
  const price = () => (MARK * BigInt(80 + int(41))) / 100n;
  const positions = EXPIRIES.slice(0, 1 + int(3)).map((expirationAt) =>
    position(
      expirationAt,
      BigInt(1 + int(12)) * (int(10) < 7 ? 1n : -1n),
      price(),
    ),
  );
  const snap: AccountSnapshot = {
    user: USER,
    balance: 0n,
    accountDebt: int(5) === 0 ? BigInt(int(20)) * 1_000_000n : 0n,
    perp: {
      netQty: int(10) < 3 ? BigInt(int(25) - 12) * 1_000_000n : 0n,
      entryPrice: price(),
      orders: book(),
      fundingOwed: 0n,
    },
    futures: { positions, orders: [] },
  };
  const mm = mmRequired(snap, PARAMS, MARK);
  return { ...snap, balance: (mm * BigInt(500 + int(500))) / 1000n };
}

describe("N5: futures close solver against a brute-force search", () => {
  it("closes two expiries in different amounts when no staged close passes", () => {
    // A short of 2 at $42 and longs of 3 at $40.50 and $40, marked at $50, with
    // $10 of debt. Any long closed first carries $9.50 or more of gain over IM,
    // and the venue stops there. The band is reached only by closing both shorts
    // first, then two longs of one expiry.
    const [a, b, c] = EXPIRIES as [bigint, bigint, bigint];
    const snap: AccountSnapshot = {
      user: USER,
      balance: 27_810_000n,
      accountDebt: 10_000_000n,
      perp: { netQty: 0n, entryPrice: 0n, orders: book(), fundingOwed: 0n },
      futures: {
        positions: [
          position(a, -2n, 42_000_000n),
          position(b, 3n, 40_500_000n),
          position(c, 3n, 40_000_000n),
        ],
        orders: [],
      },
    };
    assert.ok(
      mmSurplus(snap, PARAMS, MARK) < 0n,
      "fixture must start underwater",
    );
    assert.ok(anyCloseRestores(snap), "fixture must be restorable");

    const legs = solveFuturesClosesToTarget(snap, PARAMS, MARK, 0n);
    assert.equal(liquidate(snap, legs), "healthy");
  });

  it("never returns a close the venue rejects, and restores MM wherever a close can", () => {
    const int = random(SEED);
    const outcomes = new Map<string, number>();
    let restorable = 0;
    let misses = 0;
    for (let i = 0; i < BOOKS; i++) {
      const snap = randomBook(int);
      if (mmSurplus(snap, PARAMS, MARK) >= 0n) continue;
      const outcome = liquidate(
        snap,
        solveFuturesClosesToTarget(snap, PARAMS, MARK, 0n),
      );
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      if (!anyCloseRestores(snap)) continue;
      restorable++;
      if (outcome !== "healthy") misses++;
    }

    assert.equal(outcomes.get("reverts") ?? 0, 0, "closes the venue rejects");
    assert.ok(restorable >= 15_000, `only ${restorable} restorable books`);
    assert.ok(
      misses * 10_000 <= restorable * MAX_MISSES_BPS,
      `${misses} of ${restorable} restorable books left underwater`,
    );
  });
});
