import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import {
  simulateFuturesClose,
  simulatePerpClose,
  solveFuturesLotsToTarget,
  solvePerpCloseToTarget,
} from "../../src/predict/solve.ts";
import { imSurplus, mmSurplus } from "../../src/predict/mm.ts";
import type { AccountSnapshot, MMParams } from "../../src/predict/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;
const QTY_SCALE = 10n ** 6n;

// PME defaults used across the stack: 10% IM / 5% MM, USDC 6-dec, perps qty 6-dec.
const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n,
  mmSpotShock: 5n * 10n ** 16n,
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

const FEE = 1_000_000n; // $1 flat liquidation fee

// Default single-expiry timestamp for lots whose test doesn't care about the
// expiration grouping (keeps their behaviour identical to pre-balancing).
const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;

// Duration-free contract sizing. Each lot is a single contract that settles
// `entryPricePerDay` of notional (no `× deliveryDays` factor). For a close to
// improve MM surplus the stress it frees (`spotShock × P`) must exceed the flat
// fee, so the moderate-crash price sits well above `20 × FEE` — hence the
// $40/$30 magnitudes below rather than the old sub-dollar per-day prices.
const ENTRY_PER_DAY = 40_000_000n; // $40/day entry
const P_MODERATE = 30_000_000n; // $30/day: underwater but recoverable via a subset
const BALANCE = 136_000_000n; // collateral: underwater at P_MODERATE, healable by a partial close

function futuresLot(id: Hex, entryPricePerDay: bigint, isBuyer = true, deliveryAt = EXPIRY_A) {
  return { id, isBuyer, entryPricePerDay, deliveryAt };
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

/** 12 identical $40/day long lots — the integration `futuresPartialCrash` shape. */
function twelveLongLots(): AccountSnapshot {
  const positions = [];
  for (let i = 0; i < 12; i++) {
    positions.push(futuresLot(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, ENTRY_PER_DAY));
  }
  return futuresSnapshot({ balance: BALANCE, futures: { positions, orderMargin: 0n } });
}

describe("predict/solve: solveFuturesLotsToTarget", () => {
  it("returns an empty set when the account is already healthy", () => {
    const snap = futuresSnapshot({
      balance: 1_000_000_000n,
      futures: { positions: [futuresLot(("0x" + "01".repeat(32)) as Hex, ENTRY_PER_DAY)], orderMargin: 0n },
    });
    const ids = solveFuturesLotsToTarget(snap, PARAMS, P_MODERATE, FEE);
    assert.equal(ids.length, 0);
  });

  it("closes a strict worst-first subset that lands inside the [MM, IM] band", () => {
    const snap = twelveLongLots();
    const P = P_MODERATE; // moderate crash → underwater but recoverable

    // Precondition: the account really is underwater at P.
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n, "fixture must start underwater");

    const ids = solveFuturesLotsToTarget(snap, PARAMS, P, FEE);
    assert.ok(ids.length > 0, "should close at least one lot");
    assert.ok(ids.length < snap.futures.positions.length, "should leave >=1 lot open (strict subset)");

    // The chosen subset lands the account in the [MM, IM] buffer band.
    const after = simulateFuturesClose(snap, ids, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n, "post-close: healthy at MM");
    assert.ok(imSurplus(after, PARAMS, P) <= 0n, "post-close: at/under IM (no over-liquidation)");
  });

  it("is the DEEPEST in-band subset — closing one more worst-first lot breaches IM", () => {
    const snap = twelveLongLots();
    const P = P_MODERATE;
    const ids = solveFuturesLotsToTarget(snap, PARAMS, P, FEE);

    // There is still a lot to add and doing so would push balance over IM.
    if (ids.length < snap.futures.positions.length - 1) {
      const remaining = snap.futures.positions.find((p) => !ids.includes(p.id));
      assert.ok(remaining, "expected a remaining lot to test the deepest boundary");
      const oneMore = simulateFuturesClose(snap, [...ids, remaining.id], P, FEE);
      assert.ok(
        imSurplus(oneMore, PARAMS, P) > 0n,
        "closing one more lot should overshoot IM (proves the subset is the deepest)",
      );
    }
  });

  it("returns the full set (all ids) on a deep crash with no in-band subset", () => {
    const snap = twelveLongLots();
    const P = 100_000n; // ~98% crash → bad debt even after closing everything
    const ids = solveFuturesLotsToTarget(snap, PARAMS, P, FEE);
    assert.equal(ids.length, snap.futures.positions.length, "deep crash fully closes");
  });

  it("degenerate IM == MM: targets minimal healthy (no upper IM bound)", () => {
    const snap = twelveLongLots();
    const P = P_MODERATE;
    const degenerate: MMParams = { ...PARAMS, imSpotShock: PARAMS.mmSpotShock };
    const ids = solveFuturesLotsToTarget(snap, degenerate, P, FEE);
    assert.ok(ids.length > 0 && ids.length <= snap.futures.positions.length);
    const after = simulateFuturesClose(snap, ids, P, FEE);
    assert.ok(mmSurplus(after, degenerate, P) >= 0n, "healthy at MM");
  });

  it("balances the close across futures expirations (does not drain one expiry's book)", () => {
    // 12 identical $4.21/day long lots split evenly across two expiration
    // dates (markets). With equal per-lot loss, an expiry-blind worst-first
    // solver would just take a prefix in input order — draining EXPIRY_A
    // entirely before touching EXPIRY_B. The balanced solver must instead
    // spread the closures across both books.
    const positions: AccountSnapshot["futures"]["positions"] = [];
    for (let i = 0; i < 6; i++) {
      positions.push(futuresLot(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, ENTRY_PER_DAY, true, EXPIRY_A));
    }
    for (let i = 6; i < 12; i++) {
      positions.push(futuresLot(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, ENTRY_PER_DAY, true, EXPIRY_B));
    }
    const snap = futuresSnapshot({ balance: BALANCE, futures: { positions, orderMargin: 0n } });
    const P = P_MODERATE;
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n, "fixture must start underwater");

    const ids = solveFuturesLotsToTarget(snap, PARAMS, P, FEE);
    assert.ok(ids.length > 1, "should close more than one lot so balancing is observable");

    const byExpiry = (deliveryAt: bigint) =>
      ids.filter((id) => positions.find((p) => p.id === id)?.deliveryAt === deliveryAt).length;
    const countA = byExpiry(EXPIRY_A);
    const countB = byExpiry(EXPIRY_B);

    assert.ok(countA >= 1 && countB >= 1, `both expirations must be reduced (A=${countA}, B=${countB})`);
    assert.ok(
      countA - countB <= 1 && countB - countA <= 1,
      `closures must be balanced across expirations within one lot (A=${countA}, B=${countB})`,
    );

    // Still lands in the [MM, IM] band — balancing must not sacrifice the target.
    const after = simulateFuturesClose(snap, ids, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n, "post-close: healthy at MM");
    assert.ok(imSurplus(after, PARAMS, P) <= 0n, "post-close: at/under IM");
  });

  it("balances proportionally to each expiry's book size when expiries differ in size", () => {
    // EXPIRY_A holds 8 lots, EXPIRY_B holds 4 lots (2:1). A balanced close
    // should reduce them roughly in proportion — A closes about twice as many
    // lots as B — rather than emptying the smaller book first.
    const positions: AccountSnapshot["futures"]["positions"] = [];
    for (let i = 0; i < 8; i++) {
      positions.push(futuresLot(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, ENTRY_PER_DAY, true, EXPIRY_A));
    }
    for (let i = 8; i < 12; i++) {
      positions.push(futuresLot(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, ENTRY_PER_DAY, true, EXPIRY_B));
    }
    const snap = futuresSnapshot({ balance: BALANCE, futures: { positions, orderMargin: 0n } });
    const P = P_MODERATE;

    const ids = solveFuturesLotsToTarget(snap, PARAMS, P, FEE);
    const byExpiry = (deliveryAt: bigint) =>
      ids.filter((id) => positions.find((p) => p.id === id)?.deliveryAt === deliveryAt).length;
    const countA = byExpiry(EXPIRY_A);
    const countB = byExpiry(EXPIRY_B);

    // The larger book (A, 2×) is reduced at least as much as the smaller (B),
    // and the smaller book is not fully drained while the larger is untouched.
    assert.ok(countA >= countB, `larger book should not close fewer (A=${countA}, B=${countB})`);
    assert.ok(countB >= 1, "smaller book still participates");
  });
});

function perpSnapshot(netQty: bigint, entryPrice: bigint, balance: bigint): AccountSnapshot {
  return {
    user: USER,
    balance,
    perp: { netQty, entryPrice, orderMargin: 0n, fundingOwed: 0n },
    futures: { positions: [], orderMargin: 0n },
  };
}

describe("predict/solve: solvePerpCloseToTarget", () => {
  it("returns 0 when the account is already healthy", () => {
    const snap = perpSnapshot(40n * QTY_SCALE, 4_210_000n, 1_000_000_000n);
    assert.equal(solvePerpCloseToTarget(snap, PARAMS, 3_000_000n, FEE), 0n);
  });

  it("returns a partial closeQty that lands inside the [MM, IM] band", () => {
    // Long 40 @ $4.21, deposit $52, crash to $3.00 — the integration
    // `perpsPartialCrash` shape.
    const snap = perpSnapshot(40n * QTY_SCALE, 4_210_000n, 52_000_000n);
    const P = 3_000_000n;
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n, "fixture must start underwater");

    const q = solvePerpCloseToTarget(snap, PARAMS, P, FEE);
    const absNet = 40n * QTY_SCALE;
    assert.ok(q > 0n, "should close a positive quantity");
    assert.ok(q < absNet, "should be a PARTIAL close (residual position remains)");

    const after = simulatePerpClose(snap, q, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n, "post-close: healthy at MM");
    assert.ok(imSurplus(after, PARAMS, P) <= 0n, "post-close: at/under IM");
  });

  it("returns the full quantity on a deep crash (bad-debt full close)", () => {
    const snap = perpSnapshot(40n * QTY_SCALE, 4_210_000n, 52_000_000n);
    const q = solvePerpCloseToTarget(snap, PARAMS, 100_000n, FEE);
    assert.equal(q, 40n * QTY_SCALE, "deep crash fully closes");
  });

  it("handles a short position (pump) symmetrically", () => {
    // Short 40 @ $4.21, deposit $52, pump to $5.47 (+30%).
    const snap = perpSnapshot(-40n * QTY_SCALE, 4_210_000n, 52_000_000n);
    const P = 5_470_000n;
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n, "short must start underwater on the pump");
    const q = solvePerpCloseToTarget(snap, PARAMS, P, FEE);
    assert.ok(q > 0n && q < 40n * QTY_SCALE, "partial close of the short");
    const after = simulatePerpClose(snap, q, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n);
    assert.ok(imSurplus(after, PARAMS, P) <= 0n);
  });
});
