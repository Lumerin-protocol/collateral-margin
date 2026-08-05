import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fillLoss,
  futuresUnrealizedPnl,
  imRequired,
  imSurplus,
  mmRequired,
  mmSurplus,
  netDeltaWad,
  perpUnrealizedPnl,
  stressLoss,
  unrealizedLoss,
  venueFillLoss,
  worstLegStressLoss,
} from "../src/mm.ts";
import type {
  AccountSnapshot,
  Address,
  MMParams,
  RestingOrders,
} from "../src/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;

const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n, // 0.10e18 = 10%
  mmSpotShock: 5n * 10n ** 16n, // 0.05e18 = 5%
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

const QTY_SCALE = 10n ** 6n;

const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;

/** An empty book on one venue. */
const NO_ORDERS: RestingOrders = {
  buyDelta: 0n,
  sellDelta: 0n,
  buyValue: 0n,
  sellValue: 0n,
};

/**
 * Skeleton with everything zeroed — tests override the bits they care about
 * so each case stays focused on the math under test.
 */
function emptySnapshot(
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

describe("predict/mm: netDeltaWad", () => {
  it("returns 0 for an idle account", () => {
    assert.equal(netDeltaWad(emptySnapshot(), PARAMS), 0n);
  });

  it("converts a long perp position to WAD using qty decimals", () => {
    // 1.5 contracts long → 1.5 * 1e18 = 1.5e18 WAD delta.
    const snap = emptySnapshot({
      perp: {
        netQty: 1_500_000n,
        entryPrice: 100n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    assert.equal(netDeltaWad(snap, PARAMS), 1_500_000_000_000_000_000n);
  });

  it("subtracts a short perp position", () => {
    const snap = emptySnapshot({
      perp: {
        netQty: -2_000_000n,
        entryPrice: 100n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    assert.equal(netDeltaWad(snap, PARAMS), -2_000_000_000_000_000_000n);
  });

  it("adds futures buyer delta (±1 per contract, no duration factor)", () => {
    // Buyer of 1 contract → +1 * 1e18 WAD delta.
    const snap = emptySnapshot({
      futures: {
        positions: [
          {
            expirationAt: 1_756_416_000n,
            netQuantity: 1n,
            netEntryValue: 50n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    assert.equal(netDeltaWad(snap, PARAMS), 1n * 10n ** 18n);
  });

  it("subtracts futures seller delta", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [
          {
            expirationAt: 1_756_416_000n,
            netQuantity: -1n,
            netEntryValue: -50n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    assert.equal(netDeltaWad(snap, PARAMS), -1n * 10n ** 18n);
  });

  it("sums perps + futures legs into one signed delta", () => {
    const snap = emptySnapshot({
      perp: {
        netQty: 1_000_000n,
        entryPrice: 100n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      }, // +1e18
      futures: {
        positions: [
          {
            expirationAt: 1_756_416_000n,
            netQuantity: 1n,
            netEntryValue: 50n,
            settlementPrice: 0n,
          },
          {
            expirationAt: 1_756_416_000n,
            netQuantity: -1n,
            netEntryValue: -60n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    // Perp +1e18; futures +1e18 - 1e18 = 0 → net = +1e18.
    assert.equal(netDeltaWad(snap, PARAMS), 1n * 10n ** 18n);
  });
});

describe("predict/mm: stressLoss", () => {
  it("is 0 when delta is 0", () => {
    assert.equal(stressLoss(0n, PARAMS.mmSpotShock, 100_000_000n, 6), 0n);
  });

  it("scales linearly with |delta|", () => {
    const a = stressLoss(1n * 10n ** 18n, PARAMS.mmSpotShock, 100_000_000n, 6);
    const b = stressLoss(2n * 10n ** 18n, PARAMS.mmSpotShock, 100_000_000n, 6);
    assert.equal(b, 2n * a);
  });

  it("scales linearly with shock", () => {
    const a = stressLoss(1n * 10n ** 18n, PARAMS.mmSpotShock, 100_000_000n, 6);
    const b = stressLoss(1n * 10n ** 18n, PARAMS.imSpotShock, 100_000_000n, 6); // imSpotShock = 2x mmSpotShock
    assert.equal(b, 2n * a);
  });

  it("uses |delta| (sign is irrelevant — worst-case scenario)", () => {
    const long = stressLoss(
      1n * 10n ** 18n,
      PARAMS.mmSpotShock,
      100_000_000n,
      6,
    );
    const short = stressLoss(
      -1n * 10n ** 18n,
      PARAMS.mmSpotShock,
      100_000_000n,
      6,
    );
    assert.equal(short, long);
  });

  it("matches the closed-form |delta|*shock*P / (WAD * 10^(18-tokenDec))", () => {
    // delta = 1e18, shock = 0.05e18, P = 100_000_000 (token dec 6 → $100), tokenDec = 6.
    // stressWad = 1e18 * 0.05e18 * (100_000_000 * 1e12) / (1e18 * 1e18) = 5e15 WAD
    // tokens = 5e15 / 1e12 = 5_000 (token dec) = $0.005 — wait, that's tiny.
    // Let me recompute. P_wad = P * 10^(18 - tokenDec) = 100_000_000 * 1e12 = 1e20.
    // stressWad = (1e18 * 0.05e18 * 1e20) / 1e36 = 1e20 * 0.05 = 5e18 WAD.
    // tokens = 5e18 / 1e12 = 5_000_000 (token dec 6 = $5).
    // 5% of $100 long position = $5. Correct.
    const out = stressLoss(1n * 10n ** 18n, 5n * 10n ** 16n, 100_000_000n, 6);
    assert.equal(out, 5_000_000n);
  });
});

describe("predict/mm: perpUnrealizedPnl", () => {
  it("returns 0 for a flat user", () => {
    assert.equal(perpUnrealizedPnl(emptySnapshot(), PARAMS, 100_000_000n), 0n);
  });

  it("is positive for a profitable long (P > entry)", () => {
    const snap = emptySnapshot({
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    assert.equal(perpUnrealizedPnl(snap, PARAMS, 110_000_000n), 10_000_000n);
  });

  it("is negative for a long below entry (linear in price)", () => {
    // 1 contract long at $100, P = $90 → pnl = ($90 - $100) * 1 = -$10.
    const snap = emptySnapshot({
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    assert.equal(perpUnrealizedPnl(snap, PARAMS, 90_000_000n), -10_000_000n);
  });

  it("is negative for a short above entry", () => {
    // 1 contract short at $100, P = $110 → pnl = -($110 - $100) * 1 = -$10.
    const snap = emptySnapshot({
      perp: {
        netQty: -1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    assert.equal(perpUnrealizedPnl(snap, PARAMS, 110_000_000n), -10_000_000n);
  });
});

/**
 * An expiry that has settled but has not yet been swept out of the participant's
 * active set. `Futures.getRiskView` drops its delta (the price is pinned, so it
 * cannot move again) while still marking its PnL at that frozen price. Both halves
 * have to hold off-chain or the keeper prices a leg that no longer carries risk.
 */
describe("predict/mm: settled-but-unswept expiries", () => {
  /** One live contract alongside five settled at $60 against a $50 entry. */
  function withSettledLeg(): AccountSnapshot {
    return emptySnapshot({
      futures: {
        positions: [
          { expirationAt: EXPIRY_A, netQuantity: 1n, netEntryValue: 50n, settlementPrice: 0n },
          { expirationAt: EXPIRY_B, netQuantity: 5n, netEntryValue: 250n, settlementPrice: 60n },
        ],
        orders: NO_ORDERS,
      },
    });
  }

  it("leaves a settled leg out of net delta", () => {
    assert.equal(
      netDeltaWad(withSettledLeg(), PARAMS),
      1n * 10n ** 18n,
      "only the live contract is stressed — the settled five cannot move with spot",
    );
  });

  it("marks a settled leg at its pinned price rather than the hypothetical spot", () => {
    const snap = withSettledLeg();
    // Settled leg: 5 × ($60 − $50) = +$50, fixed. Live leg: P × 1 − 50.
    assert.equal(futuresUnrealizedPnl(snap, 40n), 50n + (40n - 50n));
    assert.equal(futuresUnrealizedPnl(snap, 90n), 50n + (90n - 50n));
  });

  it("carries a fully settled book as PnL alone, with no stress term left", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [
          { expirationAt: EXPIRY_A, netQuantity: 2n, netEntryValue: 200n, settlementPrice: 60n },
        ],
        orders: NO_ORDERS,
      },
    });

    assert.equal(netDeltaWad(snap, PARAMS), 0n, "nothing left to stress");
    // 2 × ($60 − $100) = −$80, and it stays that whatever spot does next.
    for (const P of [1n, 60n, 1_000_000n]) {
      assert.equal(futuresUnrealizedPnl(snap, P), -80n);
      assert.equal(
        unrealizedLoss(snap, PARAMS, P, "mm"),
        80n,
        "a settled loss is a debt awaiting sweep, not an exposure that reprices",
      );
    }
  });
});

describe("predict/mm: futuresUnrealizedPnl", () => {
  it("returns 0 with no positions", () => {
    assert.equal(futuresUnrealizedPnl(emptySnapshot(), 100_000_000n), 0n);
  });

  it("buyer loses when P drops below entry (no duration factor)", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 1n,
            netEntryValue: 50n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    // pnl = P * qty - entryValue = 40 - 50 = -10.
    assert.equal(futuresUnrealizedPnl(snap, 40n), -10n);
  });

  it("seller loses when P rises above entry", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: -1n,
            netEntryValue: -50n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    assert.equal(futuresUnrealizedPnl(snap, 60n), -10n);
  });

  it("nets signed PnL across expiries into one number, as the venue does", () => {
    // Calendar spread: long the near expiry at $50, short the far one at $30.
    // `Futures.getRiskView` accumulates one signed `totalPnl` over both, so this
    // is the only futures number the engine ever sees.
    const snap = emptySnapshot({
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 1n,
            netEntryValue: 50n,
            settlementPrice: 0n,
          }, // P=60 → +10
          {
            expirationAt: EXPIRY_B,
            netQuantity: -1n,
            netEntryValue: -30n,
            settlementPrice: 0n,
          }, // P=60 → -30
        ],
        orders: NO_ORDERS,
      },
    });
    assert.equal(futuresUnrealizedPnl(snap, 60n), -20n);
  });
});

describe("predict/mm: unrealizedLoss", () => {
  it("charges both losing futures legs under either clamp", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 1n,
            netEntryValue: 50n,
            settlementPrice: 0n,
          }, // P=40 → -10
          {
            expirationAt: EXPIRY_B,
            netQuantity: -1n,
            netEntryValue: -30n,
            settlementPrice: 0n,
          }, // P=40 → -10
        ],
        orders: NO_ORDERS,
      },
    });
    // Both legs lose, so netting has nothing to cancel and the netted sum (-20)
    // charges exactly what the two legs charge separately. IM and MM agree here;
    // they only diverge once a gain is present.
    assert.equal(unrealizedLoss(snap, PARAMS, 40n, "im"), 20n);
    assert.equal(unrealizedLoss(snap, PARAMS, 40n, "mm"), 20n);
  });

  it("nets a futures calendar spread across expiries even on the IM path", () => {
    // Long 1 @ $50 and short 1 @ $30, marked at $60: +$10 against -$30.
    //
    // The venue nets first and reports -$20, and the engine clamps that single
    // number — so IM charges $20 even though it clamps per market. Clamping per
    // *expiry* (which this module used to do) would charge the $30 leg in full and
    // over-margin every calendar spread by the offsetting leg's gain.
    const snap = emptySnapshot({
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
            netEntryValue: -30_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    assert.equal(futuresUnrealizedPnl(snap, 60_000_000n), -20_000_000n);
    assert.equal(unrealizedLoss(snap, PARAMS, 60_000_000n, "im"), 20_000_000n);
    assert.equal(unrealizedLoss(snap, PARAMS, 60_000_000n, "mm"), 20_000_000n);
  });

  it("IM charges a cross-venue loss in full; MM nets it against the other venue's gain", () => {
    // Perp long 1 @ $100 (-$10 at the $90 mark) hedged by a futures long 1 @ $80
    // (+$10 at the same mark). One vault, one currency, net zero.
    const snap = emptySnapshot({
      balance: 100_000_000n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 1n,
            netEntryValue: 80_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    const P = 90_000_000n;
    assert.equal(perpUnrealizedPnl(snap, PARAMS, P), -10_000_000n);
    assert.equal(futuresUnrealizedPnl(snap, P), 10_000_000n);

    // IM clamps per market: the losing venue is charged, the winning one is invisible.
    assert.equal(unrealizedLoss(snap, PARAMS, P, "im"), 10_000_000n);
    // MM clamps the sum once: the gain offsets the loss exactly.
    assert.equal(unrealizedLoss(snap, PARAMS, P, "mm"), 0n);

    // And it shows up in the requirements. Net delta is 2 contracts long, so stress
    // is $9 at the 5% MM shock and $18 at the 10% IM shock.
    assert.equal(mmRequired(snap, PARAMS, P), 9_000_000n);
    assert.equal(imRequired(snap, PARAMS, P), 18_000_000n + 10_000_000n);
  });

  it("MM never goes below zero — a net gain funds no reduction", () => {
    // Perp +$10, futures +$10: the netted sum is a gain, and the clamp floors it.
    const snap = emptySnapshot({
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
      futures: {
        positions: [
          {
            expirationAt: EXPIRY_A,
            netQuantity: 1n,
            netEntryValue: 100_000_000n,
            settlementPrice: 0n,
          },
        ],
        orders: NO_ORDERS,
      },
    });
    const P = 110_000_000n;
    assert.equal(unrealizedLoss(snap, PARAMS, P, "mm"), 0n);
    assert.equal(unrealizedLoss(snap, PARAMS, P, "im"), 0n);
  });
});

describe("predict/mm: mmRequired / mmSurplus / imRequired / imSurplus", () => {
  it("for an idle account with no orders, all four return only owed funding", () => {
    const snap = emptySnapshot({
      balance: 1_000n,
      perp: { netQty: 0n, entryPrice: 0n, orders: NO_ORDERS, fundingOwed: 50n },
    });
    // No delta → no stress, no PnL, no fill loss.
    assert.equal(mmRequired(snap, PARAMS, 100_000_000n), 50n);
    assert.equal(imRequired(snap, PARAMS, 100_000_000n), 50n);
    assert.equal(mmSurplus(snap, PARAMS, 100_000_000n), 950n);
    assert.equal(imSurplus(snap, PARAMS, 100_000_000n), 950n);
  });

  it("a flat account's resting bid is stressed as post-fill delta, plus its fill loss", () => {
    // One contract bid at $101 with the mark at $100. Flat position, so the buy leg
    // carries the whole delta and the sell leg is flat.
    const snap = emptySnapshot({
      balance: 100_000_000n,
      perp: {
        netQty: 0n,
        entryPrice: 0n,
        orders: {
          buyDelta: 1_000_000n,
          sellDelta: 0n,
          buyValue: 101_000_000n,
          sellValue: 0n,
        },
        fundingOwed: 50n,
      },
    });
    // Stress on 1 delta: $5 at the 5% MM shock, $10 at the 10% IM shock.
    // Fill loss: the bid pays $101 for something marked at $100 → $1.
    assert.equal(
      mmRequired(snap, PARAMS, 100_000_000n),
      5_000_000n + 1_000_000n + 50n,
    );
    assert.equal(
      imRequired(snap, PARAMS, 100_000_000n),
      10_000_000n + 1_000_000n + 50n,
    );
  });

  it("for a delta-only long, mmRequired equals stress and imRequired is strictly larger", () => {
    const snap = emptySnapshot({
      balance: 0n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    // At entry price: no PnL. Pure stress contribution = $5 (mm) / $10 (im).
    assert.equal(mmRequired(snap, PARAMS, 100_000_000n), 5_000_000n);
    assert.equal(imRequired(snap, PARAMS, 100_000_000n), 10_000_000n);
  });

  it("is not constant in price for an order-only account", () => {
    // The regression this whole change exists to fix: the predictor used to treat the
    // order reservation as a scalar snapshotted at the current mark, so `mmRequired`
    // was flat in P across the order term. It is not. One contract bid at $101:
    const snap = emptySnapshot({
      perp: {
        netQty: 0n,
        entryPrice: 0n,
        orders: {
          buyDelta: 1_000_000n,
          sellDelta: 0n,
          buyValue: 101_000_000n,
          sellValue: 0n,
        },
        fundingOwed: 0n,
      },
    });
    // Below the bid's own limit the requirement carries both stress and fill loss.
    assert.equal(
      mmRequired(snap, PARAMS, 100_000_000n),
      5_000_000n + 1_000_000n,
    );
    // Above it the fill loss vanishes and only the (larger) stress remains, so the
    // requirement *falls* through the breakeven before resuming its climb.
    assert.equal(mmRequired(snap, PARAMS, 102_000_000n), 5_100_000n);
    assert.equal(mmRequired(snap, PARAMS, 104_000_000n), 5_200_000n);
  });

  it("nets a resting ask against a long instead of charging for it", () => {
    const long = emptySnapshot({
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    // An ask of exactly the position size at the mark: the sell leg lands flat, the
    // buy leg is the bare position, and there is no fill loss at the mark.
    const hedged = emptySnapshot({
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: {
          buyDelta: 0n,
          sellDelta: 1_000_000n,
          buyValue: 0n,
          sellValue: 100_000_000n,
        },
        fundingOwed: 0n,
      },
    });
    assert.equal(
      mmRequired(hedged, PARAMS, 100_000_000n),
      mmRequired(long, PARAMS, 100_000_000n),
    );
  });

  it("charges the worse leg when an oversized ask flips the portfolio short", () => {
    // Long 1, asks for 3. Buy leg = |+1| = 1; sell leg = |1 − 3| = 2. The engine must
    // take the sell leg, so the requirement is twice the bare position's.
    const snap = emptySnapshot({
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: {
          buyDelta: 0n,
          sellDelta: 3_000_000n,
          buyValue: 0n,
          sellValue: 300_000_000n,
        },
        fundingOwed: 0n,
      },
    });
    assert.equal(
      worstLegStressLoss(snap, PARAMS, PARAMS.mmSpotShock, 100_000_000n),
      10_000_000n,
    );
    assert.equal(mmRequired(snap, PARAMS, 100_000_000n), 10_000_000n);
  });

  it("clamps fill loss per side rather than letting the sides offset", () => {
    // Bid at $101 and ask at $99, both one contract, mark $100. Each side is out of
    // the money by $1 and both are charged; a net-across-sides figure would be zero.
    const orders = {
      buyDelta: 1_000_000n,
      sellDelta: 1_000_000n,
      buyValue: 101_000_000n,
      sellValue: 99_000_000n,
    };
    assert.equal(venueFillLoss(orders, 100_000_000n, 6), 2_000_000n);
    // Move the mark above both limits: the bid is now a gain (clamped to 0) and the
    // ask's loss grows to $2.
    assert.equal(venueFillLoss(orders, 101_000_000n, 6), 2_000_000n);
    assert.equal(venueFillLoss(orders, 102_000_000n, 6), 3_000_000n);
  });

  it("sums fill loss across both venues", () => {
    const snap = emptySnapshot({
      perp: {
        netQty: 0n,
        entryPrice: 0n,
        orders: {
          buyDelta: 1_000_000n,
          sellDelta: 0n,
          buyValue: 101_000_000n,
          sellValue: 0n,
        },
        fundingOwed: 0n,
      },
      futures: {
        positions: [],
        orders: {
          buyDelta: 0n,
          sellDelta: 1_000_000n,
          buyValue: 0n,
          sellValue: 97_000_000n,
        },
      },
    });
    // Perps bid $1 out of the money, futures ask $3 out of the money.
    assert.equal(fillLoss(snap, PARAMS, 100_000_000n), 4_000_000n);
  });

  it("mmSurplus drops as price moves below a long's entry (PnL kicks in)", () => {
    const snap = emptySnapshot({
      balance: 50_000_000n,
      perp: {
        netQty: 1n * QTY_SCALE,
        entryPrice: 100_000_000n,
        orders: NO_ORDERS,
        fundingOwed: 0n,
      },
    });
    const atEntry = mmSurplus(snap, PARAMS, 100_000_000n);
    const below = mmSurplus(snap, PARAMS, 80_000_000n);
    // Below entry: stress + perp PnL loss compound; surplus shrinks.
    assert.ok(
      below < atEntry,
      `expected surplus(80) < surplus(100), got ${below} vs ${atEntry}`,
    );
  });
});
