import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  simulateFuturesClose,
  solveFuturesClosesToTarget,
} from "../src/solve.ts";
import { imSurplus, mmSurplus } from "../src/mm.ts";
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

const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;
const ENTRY = 50_000_000n;
const MARK = 45_000_000n;
const CONTRACTS_PER_EXPIRY = 10_000n;

/** The keeper's default `maxLotsPerLiquidationTx`: legs sent per `liquidatePositions`. */
const LEGS_PER_TX = 50;
const SOLVE_BUDGET_MS = 500;

/**
 * `HashPowerFutures.liquidatePositions`, leg by leg: stop before a leg once the account
 * is healthy, and revert `OverLiquidation` when a close leaves the balance above IM.
 */
function liquidateOnChain(
  snap: AccountSnapshot,
  legs: readonly FuturesCloseLeg[],
): AccountSnapshot {
  let state = snap;
  for (const leg of legs) {
    if (mmSurplus(state, PARAMS, MARK) >= 0n) break;
    state = simulateFuturesClose(state, [leg], MARK, 0n);
    assert.ok(
      imSurplus(state, PARAMS, MARK) <= 0n,
      "OverLiquidation: balance above IM",
    );
  }
  return state;
}

describe("CF-009: futures close solver on a large book", () => {
  it("solves a 20,000-contract book quickly and one transaction restores MM", () => {
    const snap: AccountSnapshot = {
      user: USER,
      balance: 163_000_000_000n,
      accountDebt: 0n,
      perp: { netQty: 0n, entryPrice: 0n, orders: book(), fundingOwed: 0n },
      futures: {
        positions: [EXPIRY_A, EXPIRY_B].map((expirationAt) => ({
          expirationAt,
          netQuantity: CONTRACTS_PER_EXPIRY,
          netEntryValue: ENTRY * CONTRACTS_PER_EXPIRY,
          settlementPrice: 0n,
        })),
        orders: [],
      },
    };
    assert.ok(
      mmSurplus(snap, PARAMS, MARK) < 0n,
      "fixture must start underwater",
    );

    const started = performance.now();
    const legs = solveFuturesClosesToTarget(snap, PARAMS, MARK, 0n);
    const elapsedMs = performance.now() - started;
    assert.ok(
      elapsedMs < SOLVE_BUDGET_MS,
      `solve took ${Math.round(elapsedMs)} ms, budget ${SOLVE_BUDGET_MS} ms`,
    );

    const after = liquidateOnChain(snap, legs.slice(0, LEGS_PER_TX));
    assert.ok(
      mmSurplus(after, PARAMS, MARK) >= 0n,
      "one transaction must restore MM",
    );
  });
});
