import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import {
  imRequired,
  imSurplus,
  mmRequired,
  mmSurplus,
  netDeltaWad,
  perpUnrealizedLoss,
  futuresUnrealizedLoss,
  stressLoss,
} from "../../src/predict/mm.ts";
import type { AccountSnapshot, MMParams } from "../../src/predict/types.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;

const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n, // 0.10e18 = 10%
  mmSpotShock: 5n * 10n ** 16n, // 0.05e18 = 5%
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

const QTY_SCALE = 10n ** 6n;

/**
 * Skeleton with everything zeroed — tests override the bits they care about
 * so each case stays focused on the math under test.
 */
function emptySnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    user: USER,
    balance: 0n,
    perp: { netQty: 0n, entryPrice: 0n, orderMargin: 0n, fundingOwed: 0n },
    futures: { positions: [], orderMargin: 0n },
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
      perp: { netQty: 1_500_000n, entryPrice: 100n, orderMargin: 0n, fundingOwed: 0n },
    });
    assert.equal(netDeltaWad(snap, PARAMS), 1_500_000_000_000_000_000n);
  });

  it("subtracts a short perp position", () => {
    const snap = emptySnapshot({
      perp: { netQty: -2_000_000n, entryPrice: 100n, orderMargin: 0n, fundingOwed: 0n },
    });
    assert.equal(netDeltaWad(snap, PARAMS), -2_000_000_000_000_000_000n);
  });

  it("adds futures buyer delta (±1 per contract, no duration factor)", () => {
    // Buyer of 1 contract → +1 * 1e18 WAD delta.
    const snap = emptySnapshot({
      futures: {
        positions: [{ expirationAt: 1_756_416_000n, netQuantity: 1n, netEntryValue: 50n }],
        orderMargin: 0n,
      },
    });
    assert.equal(netDeltaWad(snap, PARAMS), 1n * 10n ** 18n);
  });

  it("subtracts futures seller delta", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [{ expirationAt: 1_756_416_000n, netQuantity: -1n, netEntryValue: -50n }],
        orderMargin: 0n,
      },
    });
    assert.equal(netDeltaWad(snap, PARAMS), -1n * 10n ** 18n);
  });

  it("sums perps + futures legs into one signed delta", () => {
    const snap = emptySnapshot({
      perp: { netQty: 1_000_000n, entryPrice: 100n, orderMargin: 0n, fundingOwed: 0n }, // +1e18
      futures: {
        positions: [
          { expirationAt: 1_756_416_000n, netQuantity: 1n, netEntryValue: 50n },
          { expirationAt: 1_756_416_000n, netQuantity: -1n, netEntryValue: -60n },
        ],
        orderMargin: 0n,
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
    const long = stressLoss(1n * 10n ** 18n, PARAMS.mmSpotShock, 100_000_000n, 6);
    const short = stressLoss(-1n * 10n ** 18n, PARAMS.mmSpotShock, 100_000_000n, 6);
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

describe("predict/mm: perpUnrealizedLoss", () => {
  it("returns 0 for a flat user", () => {
    assert.equal(perpUnrealizedLoss(emptySnapshot(), PARAMS, 100_000_000n), 0n);
  });

  it("returns 0 for a profitable long (P > entry)", () => {
    const snap = emptySnapshot({
      perp: { netQty: 1_000_000n, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    assert.equal(perpUnrealizedLoss(snap, PARAMS, 110_000_000n), 0n);
  });

  it("returns the underwater amount for a long below entry (linear in price)", () => {
    // 1 contract long at $100, P = $90 → loss = ($100 - $90) * 1 = $10.
    const snap = emptySnapshot({
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    assert.equal(perpUnrealizedLoss(snap, PARAMS, 90_000_000n), 10_000_000n);
  });

  it("returns the underwater amount for a short above entry", () => {
    // 1 contract short at $100, P = $110 → loss = ($110 - $100) * 1 = $10.
    const snap = emptySnapshot({
      perp: { netQty: -1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    assert.equal(perpUnrealizedLoss(snap, PARAMS, 110_000_000n), 10_000_000n);
  });
});

describe("predict/mm: futuresUnrealizedLoss", () => {
  it("returns 0 with no positions", () => {
    assert.equal(futuresUnrealizedLoss(emptySnapshot(), 100_000_000n), 0n);
  });

  it("buyer loses when P drops below entry (no duration factor)", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [{ expirationAt: 1_756_416_000n, netQuantity: 1n, netEntryValue: 50n }],
        orderMargin: 0n,
      },
    });
    // diffPerDay = P - entry = 40 - 50 = -10. pnl = -10. loss = 10.
    assert.equal(futuresUnrealizedLoss(snap, 40n), 10n);
  });

  it("seller loses when P rises above entry", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [{ expirationAt: 1_756_416_000n, netQuantity: -1n, netEntryValue: -50n }],
        orderMargin: 0n,
      },
    });
    assert.equal(futuresUnrealizedLoss(snap, 60n), 10n);
  });

  it("sums losses across multiple positions; profitable legs do not net out", () => {
    const snap = emptySnapshot({
      futures: {
        positions: [
          { expirationAt: 1_756_416_000n, netQuantity: 1n, netEntryValue: 50n }, // P=40 → loses 10
          { expirationAt: 1_756_416_000n, netQuantity: -1n, netEntryValue: -30n }, // P=40 → loses 10
        ],
        orderMargin: 0n,
      },
    });
    // Loss is sum of *losing* legs only (consistent with `max(0, -pnl)` per leg
    // mirroring the on-chain `getUnrealizedPnl` aggregation, which
    // would be 0 net but PME treats them piecewise via stress + per-leg PnL).
    // Here both happen to be losing — buyer down, seller up.
    assert.equal(futuresUnrealizedLoss(snap, 40n), 20n);
  });
});

describe("predict/mm: mmRequired / mmSurplus / imRequired / imSurplus", () => {
  it("for an idle account, all four return only the constant add-ons", () => {
    const snap = emptySnapshot({
      balance: 1_000n,
      perp: { netQty: 0n, entryPrice: 0n, orderMargin: 100n, fundingOwed: 50n },
      futures: { positions: [], orderMargin: 25n },
    });
    // No delta → no stress, no PnL. orderMargin + funding = 175.
    assert.equal(mmRequired(snap, PARAMS, 100_000_000n), 175n);
    assert.equal(imRequired(snap, PARAMS, 100_000_000n), 175n);
    assert.equal(mmSurplus(snap, PARAMS, 100_000_000n), 825n);
    assert.equal(imSurplus(snap, PARAMS, 100_000_000n), 825n);
  });

  it("for a delta-only long, mmRequired equals stress and imRequired is strictly larger", () => {
    const snap = emptySnapshot({
      balance: 0n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    // At entry price: no PnL. Pure stress contribution = $5 (mm) / $10 (im).
    assert.equal(mmRequired(snap, PARAMS, 100_000_000n), 5_000_000n);
    assert.equal(imRequired(snap, PARAMS, 100_000_000n), 10_000_000n);
  });

  it("mmSurplus drops as price moves below a long's entry (PnL kicks in)", () => {
    const snap = emptySnapshot({
      balance: 50_000_000n,
      perp: { netQty: 1n * QTY_SCALE, entryPrice: 100_000_000n, orderMargin: 0n, fundingOwed: 0n },
    });
    const atEntry = mmSurplus(snap, PARAMS, 100_000_000n);
    const below = mmSurplus(snap, PARAMS, 80_000_000n);
    // Below entry: stress + perp PnL loss compound; surplus shrinks.
    assert.ok(below < atEntry, `expected surplus(80) < surplus(100), got ${below} vs ${atEntry}`);
  });
});
