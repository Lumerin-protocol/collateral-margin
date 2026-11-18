import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imRequired, imSurplus, mmRequired, mmSurplus } from "../src/mm.ts";
import type { AccountSnapshot, Address, MMParams } from "../src/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;
const PRICE = 50_000_000n;
const DEBT = 8_000_000_000n;
const BALANCE = 5_000_000_000n;
const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n,
  mmSpotShock: 5n * 10n ** 16n,
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

type DebtSnapshot = AccountSnapshot & { accountDebt: bigint };

const snapshot: DebtSnapshot = {
  user: USER,
  balance: BALANCE,
  accountDebt: DEBT,
  perp: {
    netQty: 0n,
    entryPrice: 0n,
    orders: {
      buyQty: 0n,
      sellQty: 0n,
      buyPQ: 0n,
      buyP2Q: 0n,
      sellPQ: 0n,
      sellP2Q: 0n,
    },
    fundingOwed: 0n,
  },
  futures: { positions: [], orders: [] },
};

describe("CF-665 step B: off-chain margin includes account debt", () => {
  it("carries debt as the same constant term in IM and MM", () => {
    assert.equal(imRequired(snapshot, PARAMS, PRICE), DEBT);
    assert.equal(mmRequired(snapshot, PARAMS, PRICE), DEBT);
    assert.equal(imSurplus(snapshot, PARAMS, PRICE), BALANCE - DEBT);
    assert.equal(mmSurplus(snapshot, PARAMS, PRICE), BALANCE - DEBT);
  });
});
