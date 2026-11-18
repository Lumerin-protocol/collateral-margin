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

const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;
const EXPIRY_C = 1_761_600_000n;
const ENTRY = 45_000_000n;
const MARK = 50_000_000n;

function longAt(expirationAt: bigint, netQuantity: bigint) {
  return {
    expirationAt,
    netQuantity,
    netEntryValue: ENTRY * netQuantity,
    settlementPrice: 0n,
  };
}

/**
 * `HashPowerFutures.liquidatePositions`, leg by leg: stop before a leg once the
 * account is not underwater, revert `OverLiquidation` when a close leaves the
 * balance above IM while IM > MM, and `NotLiquidatable` when nothing closed.
 */
function liquidateOnChain(
  snap: AccountSnapshot,
  legs: readonly FuturesCloseLeg[],
): AccountSnapshot {
  let state = snap;
  let closed = 0;
  for (const leg of legs) {
    if (mmSurplus(state, PARAMS, MARK) >= 0n) break;
    state = simulateFuturesClose(state, [leg], MARK, 0n);
    closed++;
    const im = imRequired(state, PARAMS, MARK);
    assert.ok(
      im <= mmRequired(state, PARAMS, MARK) || state.balance <= im,
      `OverLiquidation after closing ${leg.closeQty} at ${leg.expirationAt}`,
    );
  }
  assert.ok(closed > 0, "NotLiquidatable: no leg closed");
  return state;
}

describe("N5: futures close solver against the venue's per-leg guard", () => {
  it("restores MM on a profitable long book in one transaction", () => {
    // 12 longs bought at $45 and marked at $50 carry $60 of gains, which MM ignores,
    // so a $55 balance is under the $60 MM stress. Closing one or two contracts
    // lands in the [MM, IM] band; a third overshoots IM.
    const snap: AccountSnapshot = {
      user: USER,
      balance: 55_000_000n,
      accountDebt: 0n,
      perp: { netQty: 0n, entryPrice: 0n, orders: book(), fundingOwed: 0n },
      futures: {
        positions: [
          longAt(EXPIRY_A, 10n),
          longAt(EXPIRY_B, 1n),
          longAt(EXPIRY_C, 1n),
        ],
        orders: [],
      },
    };
    assert.ok(
      mmSurplus(snap, PARAMS, MARK) < 0n,
      "fixture must start underwater",
    );

    const legs = solveFuturesClosesToTarget(snap, PARAMS, MARK, 0n);
    const after = liquidateOnChain(snap, legs);
    assert.ok(
      mmSurplus(after, PARAMS, MARK) >= 0n,
      "the transaction must restore MM",
    );
  });
});
