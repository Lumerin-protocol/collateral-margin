import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import {
  simulateFuturesClose,
  simulatePerpClose,
  solveFuturesClosesToTarget,
  solvePerpCloseToTarget,
} from "../../src/predict/solve.ts";
import { imSurplus, mmSurplus } from "../../src/predict/mm.ts";
import type { AccountSnapshot, FuturesCloseLeg, MMParams } from "../../src/predict/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;

const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n,
  mmSpotShock: 5n * 10n ** 16n,
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

const FEE = 1_000_000n; // $1 flat liquidation fee

const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;

const ENTRY = 40_000_000n; // $40/contract entry
const P_MODERATE = 30_000_000n; // $30: underwater but recoverable
const BALANCE = 136_000_000n;

function futuresAgg(netQuantity: bigint, entry: bigint, expirationAt = EXPIRY_A) {
  return {
    expirationAt,
    netQuantity,
    netEntryValue: entry * netQuantity,
  };
}

function futuresSnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    user: USER,
    balance: 0n,
    perp: { netQty: 0n, entryPrice: 0n, orderMargin: 0n, fundingOwed: 0n },
    futures: { positions: [], orderMargin: 0n },
    ...overrides,
  };
}

/** 12-contract long aggregate — same economics as the old twelve-lot fixture. */
function twelveLong(): AccountSnapshot {
  return futuresSnapshot({
    balance: BALANCE,
    futures: { positions: [futuresAgg(12n, ENTRY)], orderMargin: 0n },
  });
}

function totalCloseQty(closes: readonly FuturesCloseLeg[]): bigint {
  return closes.reduce((s, c) => s + c.closeQty, 0n);
}

describe("predict/solve: solveFuturesClosesToTarget", () => {
  it("returns an empty set when the account is already healthy", () => {
    const snap = futuresSnapshot({
      balance: 1_000_000_000n,
      futures: { positions: [futuresAgg(1n, ENTRY)], orderMargin: 0n },
    });
    const closes = solveFuturesClosesToTarget(snap, PARAMS, P_MODERATE, FEE);
    assert.equal(closes.length, 0);
  });

  it("closes a strict subset that lands inside the [MM, IM] band", () => {
    const snap = twelveLong();
    const P = P_MODERATE;
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n, "fixture must start underwater");

    const closes = solveFuturesClosesToTarget(snap, PARAMS, P, FEE);
    const qty = totalCloseQty(closes);
    assert.ok(qty > 0n, "should close at least one contract");
    assert.ok(qty < 12n, "should leave >=1 contract open (strict subset)");

    const after = simulateFuturesClose(snap, closes, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n, "post-close: healthy at MM");
    assert.ok(imSurplus(after, PARAMS, P) <= 0n, "post-close: at/under IM");
  });

  it("is the DEEPEST in-band close — one more contract breaches IM", () => {
    const snap = twelveLong();
    const P = P_MODERATE;
    const closes = solveFuturesClosesToTarget(snap, PARAMS, P, FEE);
    const qty = totalCloseQty(closes);
    if (qty < 11n) {
      const oneMore: FuturesCloseLeg[] = [
        { expirationAt: EXPIRY_A, closeQty: qty + 1n },
      ];
      const after = simulateFuturesClose(snap, oneMore, P, FEE);
      assert.ok(
        imSurplus(after, PARAMS, P) > 0n,
        "closing one more contract should overshoot IM",
      );
    }
  });

  it("returns a full close on a deep crash with no in-band subset", () => {
    const snap = twelveLong();
    const P = 100_000n;
    const closes = solveFuturesClosesToTarget(snap, PARAMS, P, FEE);
    assert.equal(totalCloseQty(closes), 12n, "deep crash fully closes");
  });

  it("degenerate IM == MM: targets minimal healthy (no upper IM bound)", () => {
    const snap = twelveLong();
    const P = P_MODERATE;
    const degenerate: MMParams = { ...PARAMS, imSpotShock: PARAMS.mmSpotShock };
    const closes = solveFuturesClosesToTarget(snap, degenerate, P, FEE);
    const qty = totalCloseQty(closes);
    assert.ok(qty > 0n && qty <= 12n);
    const after = simulateFuturesClose(snap, closes, P, FEE);
    assert.ok(mmSurplus(after, degenerate, P) >= 0n, "healthy at MM");
  });

  it("balances the close across futures expirations", () => {
    const snap = futuresSnapshot({
      balance: BALANCE,
      futures: {
        positions: [
          futuresAgg(6n, ENTRY, EXPIRY_A),
          futuresAgg(6n, ENTRY, EXPIRY_B),
        ],
        orderMargin: 0n,
      },
    });
    const P = P_MODERATE;
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n);

    const closes = solveFuturesClosesToTarget(snap, PARAMS, P, FEE);
    assert.ok(totalCloseQty(closes) > 1n);

    const countA = closes
      .filter((c) => c.expirationAt === EXPIRY_A)
      .reduce((s, c) => s + c.closeQty, 0n);
    const countB = closes
      .filter((c) => c.expirationAt === EXPIRY_B)
      .reduce((s, c) => s + c.closeQty, 0n);
    assert.ok(countA >= 1n && countB >= 1n, `both expirations must be reduced (A=${countA}, B=${countB})`);
    assert.ok(
      countA - countB <= 1n && countB - countA <= 1n,
      `closures must be balanced within one contract (A=${countA}, B=${countB})`,
    );

    const after = simulateFuturesClose(snap, closes, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n);
    assert.ok(imSurplus(after, PARAMS, P) <= 0n);
  });

  it("balances proportionally when expiries differ in size", () => {
    const snap = futuresSnapshot({
      balance: BALANCE,
      futures: {
        positions: [
          futuresAgg(8n, ENTRY, EXPIRY_A),
          futuresAgg(4n, ENTRY, EXPIRY_B),
        ],
        orderMargin: 0n,
      },
    });
    const P = P_MODERATE;
    const closes = solveFuturesClosesToTarget(snap, PARAMS, P, FEE);
    const countA = closes
      .filter((c) => c.expirationAt === EXPIRY_A)
      .reduce((s, c) => s + c.closeQty, 0n);
    const countB = closes
      .filter((c) => c.expirationAt === EXPIRY_B)
      .reduce((s, c) => s + c.closeQty, 0n);
    // A is twice B → roughly 2:1 close ratio when both are touched.
    if (countA > 0n && countB > 0n) {
      assert.ok(countA >= countB, `A=${countA} should close at least as many as B=${countB}`);
    }
  });
});

describe("predict/solve: solvePerpCloseToTarget (smoke)", () => {
  it("returns 0 when healthy", () => {
    const snap = futuresSnapshot({
      balance: 1_000_000_000n,
      perp: { netQty: 1_000_000n, entryPrice: ENTRY, orderMargin: 0n, fundingOwed: 0n },
    });
    assert.equal(solvePerpCloseToTarget(snap, PARAMS, P_MODERATE, FEE), 0n);
  });

  it("simulatePerpClose reduces qty toward zero", () => {
    const snap = futuresSnapshot({
      balance: BALANCE,
      perp: { netQty: 5_000_000n, entryPrice: ENTRY, orderMargin: 0n, fundingOwed: 0n },
    });
    const after = simulatePerpClose(snap, 2_000_000n, P_MODERATE, FEE);
    assert.equal(after.perp.netQty, 3_000_000n);
  });
});
