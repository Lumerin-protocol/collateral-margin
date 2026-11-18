import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { imRequired, mmRequired, mmSurplus } from "../src/mm.ts";
import {
  simulateFuturesClose,
  simulatePerpClose,
  solveLiquidationThresholds,
} from "../src/solve.ts";
import type { AccountSnapshot, Address, MMParams } from "../src/types.ts";
import { book } from "./books.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;
const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n, // 10%
  mmSpotShock: 5n * 10n ** 16n, // 5%
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};
const usd = (dollars: bigint) => dollars * 1_000_000n;
const INDEX = usd(40n);
/** Perps part way down the glide, a date settling after the halving, a date inside the window. */
const GLIDE = usd(30n);
const POST = usd(20n);
const POST_DATE = 1_756_416_000n;
const WINDOW_DATE = 1_759_008_000n;

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    user: USER,
    balance: 0n,
    accountDebt: 0n,
    index: INDEX,
    perp: {
      netQty: 0n,
      entryPrice: 0n,
      orders: book(),
      fundingOwed: 0n,
      mark: GLIDE,
    },
    futures: { positions: [], orders: [] },
    ...overrides,
  };
}

/** 10 perps long at the glide and 10 contracts short on the post-halving date at its mark. */
function glideLongPostShort(balance: bigint): AccountSnapshot {
  const base = snapshot({ balance });
  return {
    ...base,
    perp: { ...base.perp, netQty: 10_000_000n, entryPrice: GLIDE },
    futures: {
      positions: [
        {
          expirationAt: POST_DATE,
          netQuantity: -10n,
          netEntryValue: -10n * POST,
          settlementPrice: 0n,
          low: POST,
          high: POST,
        },
      ],
      orders: [],
    },
  };
}

describe("portfolio-margin: marks (CF-321)", () => {
  it("prices a snapshot whose marks equal the index like one without marks", () => {
    const withMarks = glideLongPostShort(usd(500n));
    const atIndex: AccountSnapshot = {
      ...withMarks,
      perp: { ...withMarks.perp, mark: INDEX, entryPrice: INDEX },
      futures: {
        ...withMarks.futures,
        positions: withMarks.futures.positions.map((p) => ({
          ...p,
          netEntryValue: -10n * INDEX,
          low: INDEX,
          high: INDEX,
        })),
      },
    };
    const plain: AccountSnapshot = {
      ...atIndex,
      index: undefined,
      perp: { ...atIndex.perp, mark: undefined },
      futures: {
        ...atIndex.futures,
        positions: atIndex.futures.positions.map(
          ({ low: _low, high: _high, ...p }) => p,
        ),
      },
    };
    for (const P of [INDEX, (INDEX * 7n) / 10n, (INDEX * 13n) / 10n]) {
      assert.equal(
        mmRequired(atIndex, PARAMS, P),
        mmRequired(plain, PARAMS, P),
      );
      assert.equal(
        imRequired(atIndex, PARAMS, P),
        imRequired(plain, PARAMS, P),
      );
    }
  });

  it("values exposure and PnL at each leg's mark, moved with the index", () => {
    const snap = glideLongPostShort(usd(500n));
    // At twice the index: perps marks 60, the date 40. Exposure 10·60 − 10·40 = 200;
    // PnL perps +300, futures −200.
    const P = INDEX * 2n;
    // MM: 5% of 200, the netted PnL (+100) clamps to 0.
    assert.equal(mmRequired(snap, PARAMS, P), usd(10n));
    // IM: 10% of 200, plus the futures venue's loss on its own.
    assert.equal(imRequired(snap, PARAMS, P), usd(20n) + usd(200n));
  });

  it("values a window date's longs at low and its shorts at high", () => {
    const leg = (netQuantity: bigint): AccountSnapshot =>
      snapshot({
        futures: {
          positions: [
            {
              expirationAt: WINDOW_DATE,
              netQuantity,
              netEntryValue: netQuantity * INDEX,
              settlementPrice: 0n,
              low: POST,
              high: INDEX,
            },
          ],
          orders: [],
        },
      });
    // Long: exposure 10·20 = 200 → 5% = 10; PnL (20 − 40)·10 = −200.
    assert.equal(mmRequired(leg(10n), PARAMS, INDEX), usd(10n) + usd(200n));
    // Short: exposure 10·40 = 400 → 5% = 20; PnL 0.
    assert.equal(mmRequired(leg(-10n), PARAMS, INDEX), usd(20n));
  });

  it("finds a real liquidation crossing with the perps glide and a post-halving short", () => {
    const snap = glideLongPostShort(usd(40n));
    const { liqDown, liqUp } = solveLiquidationThresholds(snap, PARAMS, INDEX);
    // Marks 0.75·P and 0.5·P: PnL 2.5·P − 100, exposure 2.5·P, so the MM surplus is
    // 2.375·P − 60 below the index (zero near 25.26) and 40 − 0.125·P above it (zero at 320).
    assert.ok(liqDown !== undefined && liqUp !== undefined);
    assert.ok(liqDown > usd(25n) && liqDown < usd(26n));
    assert.ok(mmSurplus(snap, PARAMS, liqDown - 1n) < 0n);
    assert.ok(mmSurplus(snap, PARAMS, liqDown + 1n) >= 0n);
    // Rounded marks make the surplus a staircase: it rests at zero for a few units there.
    assert.ok(liqUp > usd(319n) && liqUp < usd(321n));
    assert.ok(mmSurplus(snap, PARAMS, liqUp) <= 0n);
    assert.ok(mmSurplus(snap, PARAMS, liqUp - usd(1n)) > 0n);
    assert.ok(mmSurplus(snap, PARAMS, liqUp + usd(1n)) < 0n);
  });

  it("closes a futures leg at its side mark and charges the fee there", () => {
    const base = glideLongPostShort(usd(100n));
    const closed = simulateFuturesClose(
      base,
      [{ expirationAt: POST_DATE, closeQty: 10n }],
      INDEX,
      50n,
    );
    // Taken over at the date's mark (20), its entry: no PnL; fee 0.5% of 10·20.
    assert.equal(closed.balance, usd(100n) - usd(1n));
    assert.deepEqual(closed.futures.positions, []);
  });

  it("realizes a perps close's share of pending drift", () => {
    const base = snapshot({ balance: usd(100n) });
    const snap: AccountSnapshot = {
      ...base,
      perp: {
        ...base.perp,
        netQty: 10_000_000n,
        entryPrice: GLIDE,
        pendingDrift: usd(5n),
      },
    };
    const closed = simulatePerpClose(snap, 4_000_000n, INDEX, 0n);
    assert.equal(closed.balance, usd(102n));
    assert.equal(closed.perp.pendingDrift, usd(3n));
    assert.equal(closed.perp.netQty, 6_000_000n);
  });
});
