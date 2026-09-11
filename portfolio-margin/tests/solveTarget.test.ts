import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  simulateFuturesClose,
  simulatePerpClose,
  solveFuturesClosesToTarget,
  solvePerpCloseToTarget,
} from "../src/solve.ts";
import {
  futuresUnrealizedPnl,
  imSurplus,
  mmSurplus,
  perpUnrealizedPnl,
  unrealizedLoss,
} from "../src/mm.ts";
import type {
  AccountSnapshot,
  Address,
  FuturesCloseLeg,
  MMParams,
  RestingOrders,
} from "../src/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;

/** An empty book on one venue. */
const NO_ORDERS: RestingOrders = {
  buyDelta: 0n,
  sellDelta: 0n,
  buyValue: 0n,
  sellValue: 0n,
};

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

function futuresAgg(
  netQuantity: bigint,
  entry: bigint,
  expirationAt = EXPIRY_A,
  settlementPrice = 0n,
) {
  return {
    expirationAt,
    netQuantity,
    netEntryValue: entry * netQuantity,
    settlementPrice,
  };
}

function futuresSnapshot(
  overrides: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    user: USER,
    balance: 0n,
    perp: { netQty: 0n, entryPrice: 0n, orders: NO_ORDERS, fundingOwed: 0n },
    futures: { positions: [], orders: NO_ORDERS },
    ...overrides,
  };
}

/** 12-contract long aggregate — same economics as the old twelve-lot fixture. */
function twelveLong(): AccountSnapshot {
  return futuresSnapshot({
    balance: BALANCE,
    futures: { positions: [futuresAgg(12n, ENTRY)], orders: NO_ORDERS },
  });
}

function totalCloseQty(closes: readonly FuturesCloseLeg[]): bigint {
  return closes.reduce((s, c) => s + c.closeQty, 0n);
}

describe("predict/solve: solveFuturesClosesToTarget", () => {
  it("returns an empty set when the account is already healthy", () => {
    const snap = futuresSnapshot({
      balance: 1_000_000_000n,
      futures: { positions: [futuresAgg(1n, ENTRY)], orders: NO_ORDERS },
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
        orders: NO_ORDERS,
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
    assert.ok(
      countA >= 1n && countB >= 1n,
      `both expirations must be reduced (A=${countA}, B=${countB})`,
    );
    assert.ok(
      countA - countB <= 1n && countB - countA <= 1n,
      `closures must be balanced within one contract (A=${countA}, B=${countB})`,
    );

    const after = simulateFuturesClose(snap, closes, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n);
    assert.ok(imSurplus(after, PARAMS, P) <= 0n);
  });

  it("closes the expiry whose unit close moves the requirement most, not the biggest book", () => {
    // Two long books, equal standalone loss ($20 each) at the $30 mark: 10 lots
    // entered at $32, and 2 lots entered at $40. The old ranking scored them by that
    // standalone loss, tied, and fell to the notional tiebreak — starting on the
    // 10-lot book. But under netting what matters is the requirement's response, and
    // one lot of the $40 book carries $10 of the netted loss against the $2 a lot of
    // the $32 book carries. The 2-lot book must go first.
    const snap = futuresSnapshot({
      balance: 50_000_000n,
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 10n,
            netEntryValue: 320_000_000n,
            settlementPrice: 0n,
          },
          {
            expirationAt: EXPIRY_B,
            netQuantity: 2n,
            netEntryValue: 80_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    const P = P_MODERATE;
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n, "fixture must start underwater");

    // Production passes a zero fee (the on-chain payout is disabled).
    const closes = solveFuturesClosesToTarget(snap, PARAMS, P, 0n);
    assert.ok(closes.length > 0, "should close something");
    assert.equal(
      closes[0]?.expirationAt,
      EXPIRY_B,
      "highest per-lot requirement drop first",
    );

    const after = simulateFuturesClose(snap, closes, P, 0n);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n, "post-close: healthy at MM");
    assert.ok(imSurplus(after, PARAMS, P) <= 0n, "post-close: at/under IM");
  });

  it("balances proportionally when expiries differ in size", () => {
    const snap = futuresSnapshot({
      balance: BALANCE,
      futures: {
        positions: [
          futuresAgg(8n, ENTRY, EXPIRY_A),
          futuresAgg(4n, ENTRY, EXPIRY_B),
        ],
        orders: NO_ORDERS,
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
      assert.ok(
        countA >= countB,
        `A=${countA} should close at least as many as B=${countB}`,
      );
    }
  });
});

describe("predict/solve: solvePerpCloseToTarget (smoke)", () => {
  it("returns 0 when healthy", () => {
    const snap = futuresSnapshot({
      balance: 1_000_000_000n,
      perp: {
        netQty: 1_000_000n,
        entryPrice: ENTRY,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    assert.equal(solvePerpCloseToTarget(snap, PARAMS, P_MODERATE, FEE), 0n);
  });

  it("simulatePerpClose reduces qty toward zero", () => {
    const snap = futuresSnapshot({
      balance: BALANCE,
      perp: {
        netQty: 5_000_000n,
        entryPrice: ENTRY,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const after = simulatePerpClose(snap, 2_000_000n, P_MODERATE, FEE);
    assert.equal(after.perp.netQty, 3_000_000n);
  });

  it("finds the bounded in-band island when resting asks un-monotone the requirement", () => {
    // The precondition the old single bisection rested on, and the reason it had to go.
    // Long 10 perp contracts with resting futures asks for 6. Closing the long walks net
    // delta from +10 toward 0, so the `netDelta + 0` leg shrinks — but the
    // `netDelta − 6` leg turns around at net delta +3 and *grows* from there. The MM
    // surplus therefore rises to a peak at 7 contracts closed and falls away again, and
    // the healthy set is a bounded island rather than a suffix:
    //
    //   closed:   0      6      7      8      8.5     10
    //   mmSurplus −8.0m  0     +1.5m   0     −0.75m  −3.0m
    //
    // A monotone bisection for "first quantity that clears the band" runs off the top of
    // that island and lands at ~9_999_999 — a close that leaves the account under MM,
    // so the keeper would burn a transaction and the account would stay liquidatable.
    const snap: AccountSnapshot = {
      user: USER,
      balance: 107_000_000n,
      perp: {
        netQty: 10_000_000n,
        entryPrice: ENTRY,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
      futures: {
        positions: [],
        orders: {
          buyDelta: 0n,
          sellDelta: 6_000_000n,
          buyValue: 0n,
          sellValue: 180_000_000n,
        },
      },
    };
    assert.ok(
      mmSurplus(snap, PARAMS, P_MODERATE) < 0n,
      "fixture must start underwater",
    );

    const q = solvePerpCloseToTarget(snap, PARAMS, P_MODERATE, FEE);
    assert.equal(q, 8_000_000n, "deepest close on the island");

    const after = simulatePerpClose(snap, q, P_MODERATE, FEE);
    assert.ok(mmSurplus(after, PARAMS, P_MODERATE) >= 0n, "reaches MM");
    assert.ok(imSurplus(after, PARAMS, P_MODERATE) <= 0n, "stays under IM");

    // One unit deeper falls off the island — so this really is the deepest legal close,
    // and the on-chain `OverLiquidation` guard has nothing to complain about.
    const deeper = simulatePerpClose(snap, q + 1n, P_MODERATE, FEE);
    assert.ok(
      mmSurplus(deeper, PARAMS, P_MODERATE) < 0n,
      "closing more re-breaks MM",
    );

    // And a full close is strictly worse than doing nothing about the asks.
    const full = simulatePerpClose(snap, 10_000_000n, P_MODERATE, FEE);
    assert.ok(mmSurplus(full, PARAMS, P_MODERATE) < 0n);
  });

  it("finds the in-band close when the netted PnL crosses zero partway through", () => {
    // The kink the per-market clamp let us ignore. A futures calendar spread (long 1
    // @ $50 against short 1 @ $150) carries a constant +$100 — zero net quantity, so
    // it contributes no delta and no price dependence. The perp is 10 contracts long
    // at $45, marked at $30: −$150.
    //
    // Closing the perp walks its PnL from −$150 to $0, so the portfolio total walks
    // from −$50 to +$100 and crosses zero at a third of the way in. MM's clamp turns
    // there, and with it the surplus: rising while the netted loss is still being
    // erased, falling afterwards once only realized losses and the fee land on the
    // balance. The healthy set is a bounded island in the middle.
    //
    //   closed:   0       2.0     10/3    3.48    5.0     10
    //   mmSurplus −2.0m   0      +2.0m    ~0     −20.5m  −88.0m
    //
    // Without a kink at 10/3 the interval is [0, 10] with both ends negative,
    // `nonNegativeRange` reports nothing, and the solver falls back to a full close —
    // which leaves the account $88 under MM, so the keeper spends a transaction and
    // the account stays liquidatable.
    const snap: AccountSnapshot = {
      user: USER,
      balance: 63_000_000n,
      perp: {
        netQty: 10_000_000n,
        entryPrice: 45_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 1n,
            netEntryValue: 50_000_000n,
            settlementPrice: 0n,
          },
          {
            expirationAt: EXPIRY_B,
            netQuantity: -1n,
            netEntryValue: -150_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    };
    const P = P_MODERATE;
    assert.equal(futuresUnrealizedPnl(snap, P), 100_000_000n);
    assert.equal(perpUnrealizedPnl(snap, PARAMS, P), -150_000_000n);
    // MM nets to a $50 charge; IM charges the perp's $150 and ignores the gain.
    assert.equal(unrealizedLoss(snap, PARAMS, P, "mm"), 50_000_000n);
    assert.equal(unrealizedLoss(snap, PARAMS, P, "im"), 150_000_000n);
    assert.ok(mmSurplus(snap, PARAMS, P) < 0n, "fixture must start underwater");

    const q = solvePerpCloseToTarget(snap, PARAMS, P, FEE);
    assert.ok(
      q > 0n && q < 10_000_000n,
      `expected a strict partial close, got ${q}`,
    );

    const after = simulatePerpClose(snap, q, P, FEE);
    assert.ok(mmSurplus(after, PARAMS, P) >= 0n, "post-close: healthy at MM");
    assert.ok(imSurplus(after, PARAMS, P) <= 0n, "post-close: at/under IM");

    // Deepest on the island: one unit more falls back under MM.
    const deeper = simulatePerpClose(snap, q + 1n, P, FEE);
    assert.ok(mmSurplus(deeper, PARAMS, P) < 0n, "closing more re-breaks MM");

    // The fallback the missing kink used to produce.
    const full = simulatePerpClose(snap, 10_000_000n, P, FEE);
    assert.ok(
      mmSurplus(full, PARAMS, P) < 0n,
      "a full close does not reach MM",
    );
  });
});
