import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type pino from "pino";
import {
  type FillLossCheck,
  readAccountSnapshot,
  readMMParams,
} from "../../src/predict/snapshot.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import { type MMParams, type RestingOrders, venueFillLoss } from "@hashpower/portfolio-margin";

/** An empty book on one venue. */
const NO_ORDERS: RestingOrders = {
  buyQty: 0n,
  sellQty: 0n,
  buyPQ: 0n,
  buyP2Q: 0n,
  sellPQ: 0n,
  sellP2Q: 0n,
};

/** One `[price, |quantity|]` level per side, reduced to the venue's moments. */
function book(bid?: readonly [bigint, bigint], ask?: readonly [bigint, bigint]): RestingOrders {
  const [bp, bq] = bid ?? [0n, 0n];
  const [ap, aq] = ask ?? [0n, 0n];
  return {
    buyQty: bq,
    sellQty: aq,
    buyPQ: bp * bq,
    buyP2Q: bp * bp * bq,
    sellPQ: ap * aq,
    sellP2Q: ap * ap * aq,
  };
}

const VAULT = "0x000000000000000000000000000000000000aa01" as Address;
const PME = "0x000000000000000000000000000000000000aa02" as Address;
const PERPS = "0x000000000000000000000000000000000000aa03" as Address;
const FUTURES = "0x000000000000000000000000000000000000aa04" as Address;
const USER = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x000000000000000000000000000000000000aa05" as Address;

const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;
const BLOCK = 4_242n;
const TOKEN_SCALE = 1_000_000n;

const PARAMS: MMParams = {
  imSpotShock: 10n ** 17n,
  mmSpotShock: 5n * 10n ** 16n,
  tokenDecimals: 6,
  perpQuantityDecimals: 6,
};

function makeConfig(): Config {
  return {
    vault: { address: VAULT },
    pme: { address: PME },
    perps: { address: PERPS },
    futures: { address: FUTURES },
  } as Config;
}

interface Scripted {
  activeExpirationAts?: readonly bigint[];
  /** Tradable window for futures order aggregates; defaults to activeExpirationAts. */
  tradableExpirationAts?: readonly bigint[];
  futuresPositions?: Record<string, { netQuantity: bigint; netEntryValue: bigint }>;
  /** Keyed by expiry; absent means the expiry has not settled. */
  settlementPrices?: Record<string, bigint>;
  perpNetQty?: bigint;
  perpNetEntryValue?: bigint;
  perpFunding?: bigint;
  perpOrders?: RestingOrders;
  /** Keyed by expiry; absent means no resting orders there. */
  futuresBooks?: Record<string, RestingOrders>;
  /** What each venue's `getRiskView` reports as buy + sell fill loss (put on the buy side). */
  perpReportedFillLoss?: bigint;
  futuresReportedFillLoss?: bigint;
  perpsMark?: bigint;
  futuresMark?: bigint;
  balance?: bigint;
}

interface Recorded {
  /** `blockNumber` of every multicall, in call order. */
  multicallBlocks: (bigint | undefined)[];
  /** Every multicall function name, in call order. */
  calls: string[];
}

function makeChain(scripted: Scripted, recorded?: Recorded): Chain {
  const futuresBooks = Object.values(scripted.futuresBooks ?? {});
  const futuresBuyQty = futuresBooks.reduce((sum, b) => sum + b.buyQty, 0n);
  const futuresSellQty = futuresBooks.reduce((sum, b) => sum + b.sellQty, 0n);
  return {
    publicClient: {
      getBlockNumber: async () => BLOCK,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "collateralToken") return USDC;
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      multicall: async ({
        contracts,
        blockNumber,
      }: {
        contracts: readonly { functionName: string; args?: readonly unknown[]; address?: Address }[];
        blockNumber?: bigint;
      }) => {
        recorded?.multicallBlocks.push(blockNumber);
        return contracts.map((c) => {
          recorded?.calls.push(c.functionName);
          switch (c.functionName) {
            case "balanceOf":
              return scripted.balance ?? 0n;
            case "getUserPosition": {
              // Perps: getUserPosition(user). Futures: getUserPosition(user, expirationAt).
              if ((c.args?.length ?? 0) >= 2) {
                const expirationAt = c.args?.[1] as bigint;
                const pos = scripted.futuresPositions?.[expirationAt.toString()];
                if (pos === undefined) throw new Error(`unscripted futures position ${expirationAt}`);
                return pos;
              }
              return {
                netQuantity: scripted.perpNetQty ?? 0n,
                netEntryValue: scripted.perpNetEntryValue ?? 0n,
              };
            }
            case "settlementPrice": {
              const expirationAt = c.args?.[0] as bigint;
              return scripted.settlementPrices?.[expirationAt.toString()] ?? 0n;
            }
            case "getRiskView": {
              const isPerps = c.address === PERPS;
              const perpOrders = scripted.perpOrders ?? NO_ORDERS;
              return {
                netPositionDelta: 0n,
                unrealizedPnl: 0n,
                // Only the perps venue accrues funding.
                pendingFunding: isPerps ? (scripted.perpFunding ?? 0n) : 0n,
                // Perps quantity decimals equal token decimals; futures are whole contracts.
                buyOrderDelta: isPerps ? perpOrders.buyQty : futuresBuyQty * TOKEN_SCALE,
                sellOrderDelta: isPerps ? perpOrders.sellQty : futuresSellQty * TOKEN_SCALE,
                buyOrderFillLoss: isPerps
                  ? (scripted.perpReportedFillLoss ?? 0n)
                  : (scripted.futuresReportedFillLoss ?? 0n),
                sellOrderFillLoss: 0n,
              };
            }
            case "getOrderAggregate":
              return scripted.perpOrders ?? NO_ORDERS;
            case "getOrderAggregateAtExpiration": {
              const expirationAt = c.args?.[1] as bigint;
              return scripted.futuresBooks?.[expirationAt.toString()] ?? NO_ORDERS;
            }
            case "getMarketPrice": {
              const mark = c.address === PERPS ? scripted.perpsMark : scripted.futuresMark;
              if (mark === undefined) throw new Error(`unscripted mark for ${c.address}`);
              return mark;
            }
            case "getActiveExpirationDates":
              return scripted.activeExpirationAts ?? [];
            case "getExpirationDates":
              return scripted.tradableExpirationAts ?? scripted.activeExpirationAts ?? [];
            case "imSpotShock":
              return PARAMS.imSpotShock;
            case "mmSpotShock":
              return PARAMS.mmSpotShock;
            case "decimals":
              return PARAMS.tokenDecimals;
            case "QUANTITY_DECIMALS":
              return PARAMS.perpQuantityDecimals;
            default:
              throw new Error(`unscripted call: ${c.functionName}`);
          }
        });
      },
    },
  } as unknown as Chain;
}

/** A check whose logger records every warning. */
function recordingCheck(): { check: FillLossCheck; warnings: Record<string, unknown>[] } {
  const warnings: Record<string, unknown>[] = [];
  const logger = {
    warn: (fields: Record<string, unknown>) => {
      warnings.push(fields);
    },
  } as unknown as pino.Logger;
  return { check: { params: PARAMS, logger }, warnings };
}

describe("predict/snapshot: readMMParams", () => {
  it("returns the engine-wide constants in one multicall", async () => {
    const params = await readMMParams(makeChain({}), makeConfig());
    assert.deepEqual(params, PARAMS);
  });
});

describe("predict/snapshot: readAccountSnapshot", () => {
  it("returns a flat snapshot for a fresh user with no positions or orders", async () => {
    const chain = makeChain({ balance: 0n });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.equal(snap.user, USER);
    assert.equal(snap.balance, 0n);
    assert.equal(snap.perp.netQty, 0n);
    assert.equal(snap.perp.entryPrice, 0n);
    assert.equal(snap.perp.fundingOwed, 0n);
    assert.equal(snap.futures.positions.length, 0);
    assert.deepEqual(snap.perp.orders, NO_ORDERS);
    assert.deepEqual(snap.futures.orders, []);
  });

  it("carries each venue's order moments, futures per expiry", async () => {
    const perpOrders = book([95_000_000n, 2_000_000n], [110_000_000n, 500_000n]);
    const bookA = book([42_000_000n, 1n]);
    const bookB = book(undefined, [61_000_000n, 3n]);
    const chain = makeChain({
      tradableExpirationAts: [EXPIRY_A, EXPIRY_B],
      perpOrders,
      futuresBooks: { [EXPIRY_A.toString()]: bookA, [EXPIRY_B.toString()]: bookB },
    });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.deepEqual(snap.perp.orders, perpOrders);
    assert.deepEqual(snap.futures.orders, [
      { ...bookA, expirationAt: EXPIRY_A, settlementPrice: 0n },
      { ...bookB, expirationAt: EXPIRY_B, settlementPrice: 0n },
    ]);
  });

  it("drops window expiries without orders and carries a settled expiry's price", async () => {
    const bookB = book([42_000_000n, 1n]);
    const chain = makeChain({
      tradableExpirationAts: [EXPIRY_A, EXPIRY_B],
      futuresBooks: { [EXPIRY_B.toString()]: bookB },
      settlementPrices: { [EXPIRY_B.toString()]: 40_000_000n },
    });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.deepEqual(snap.futures.orders, [
      { ...bookB, expirationAt: EXPIRY_B, settlementPrice: 40_000_000n },
    ]);
  });

  it("skips the futures aggregate reads when the venue reports no order delta", async () => {
    const recorded: Recorded = { multicallBlocks: [], calls: [] };
    const chain = makeChain({ tradableExpirationAts: [EXPIRY_A, EXPIRY_B] }, recorded);
    await readAccountSnapshot(chain, makeConfig(), USER);
    assert.ok(!recorded.calls.includes("getOrderAggregateAtExpiration"));
  });

  it("pins both multicalls to one block", async () => {
    const recorded: Recorded = { multicallBlocks: [], calls: [] };
    const chain = makeChain(
      {
        activeExpirationAts: [EXPIRY_A],
        futuresPositions: { [EXPIRY_A.toString()]: { netQuantity: 1n, netEntryValue: 50n } },
        futuresBooks: { [EXPIRY_A.toString()]: book([42_000_000n, 1n]) },
      },
      recorded,
    );
    await readAccountSnapshot(chain, makeConfig(), USER);
    assert.deepEqual(recorded.multicallBlocks, [BLOCK, BLOCK]);
  });

  it("clamps pending funding to >= 0 (PME treats credits as not-owed)", async () => {
    const chain = makeChain({ perpFunding: -5n });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.equal(snap.perp.fundingOwed, 0n);
  });

  it("preserves positive funding owed", async () => {
    const chain = makeChain({ perpFunding: 1_000n });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.equal(snap.perp.fundingOwed, 1_000n);
  });

  it("derives the perps average entry price from signed entry value", async () => {
    const chain = makeChain({
      perpNetQty: -2_000_000n,
      perpNetEntryValue: -240_000_000n,
    });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);

    assert.equal(snap.perp.entryPrice, 120_000_000n);
  });

  it("hydrates futures aggregates from active delivery dates", async () => {
    const chain = makeChain({
      activeExpirationAts: [EXPIRY_A, EXPIRY_B],
      futuresPositions: {
        [EXPIRY_A.toString()]: { netQuantity: 1n, netEntryValue: 50n },
        [EXPIRY_B.toString()]: { netQuantity: -2n, netEntryValue: -118n },
      },
    });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.equal(snap.futures.positions.length, 2);
    const long = snap.futures.positions.find((p) => p.expirationAt === EXPIRY_A);
    const short = snap.futures.positions.find((p) => p.expirationAt === EXPIRY_B);
    assert.equal(long?.netQuantity, 1n);
    assert.equal(long?.netEntryValue, 50n);
    assert.equal(short?.netQuantity, -2n);
    assert.equal(short?.netEntryValue, -118n);
  });

  it("hydrates each expiry's settlement price, defaulting unsettled ones to zero", async () => {
    const chain = makeChain({
      activeExpirationAts: [EXPIRY_A, EXPIRY_B],
      futuresPositions: {
        [EXPIRY_A.toString()]: { netQuantity: 1n, netEntryValue: 50n },
        [EXPIRY_B.toString()]: { netQuantity: -2n, netEntryValue: -118n },
      },
      settlementPrices: { [EXPIRY_B.toString()]: 61n },
    });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);

    assert.equal(
      snap.futures.positions.find((p) => p.expirationAt === EXPIRY_A)?.settlementPrice,
      0n,
      "still live",
    );
    assert.equal(
      snap.futures.positions.find((p) => p.expirationAt === EXPIRY_B)?.settlementPrice,
      61n,
      "settled but not yet swept — the margin math must not reprice it",
    );
  });
});

describe("predict/snapshot: fill-loss check against getRiskView", () => {
  const MARK = 50_000_000n;
  const perpOrders = book([60_000_000n, 10_000_000n]);
  const futuresBook = book(undefined, [40_000_000n, 10n]);
  const scripted: Scripted = {
    tradableExpirationAts: [EXPIRY_A],
    perpOrders,
    futuresBooks: { [EXPIRY_A.toString()]: futuresBook },
    perpsMark: MARK,
    futuresMark: MARK,
    perpReportedFillLoss: venueFillLoss(perpOrders, MARK, TOKEN_SCALE),
    futuresReportedFillLoss: venueFillLoss(futuresBook, MARK, 1n),
  };

  it("stays silent when the replica matches both venues", async () => {
    const { check, warnings } = recordingCheck();
    await readAccountSnapshot(makeChain(scripted), makeConfig(), USER, check);
    assert.equal(scripted.perpReportedFillLoss, 100_000_000n, "fixture: perps bid $10 over the mark");
    assert.deepEqual(warnings, []);
  });

  it("warns, naming the venue, when a venue reports a different fill loss", async () => {
    const { check, warnings } = recordingCheck();
    const reported = (scripted.futuresReportedFillLoss ?? 0n) + 1n;
    await readAccountSnapshot(
      makeChain({ ...scripted, futuresReportedFillLoss: reported }),
      makeConfig(),
      USER,
      check,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.venue, "futures");
    assert.equal(warnings[0]?.reported, reported);
    assert.equal(warnings[0]?.blockNumber, BLOCK);
  });

  it("reads no marks without a check", async () => {
    const recorded: Recorded = { multicallBlocks: [], calls: [] };
    await readAccountSnapshot(makeChain(scripted, recorded), makeConfig(), USER);
    assert.ok(!recorded.calls.includes("getMarketPrice"));
  });
});
