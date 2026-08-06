import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { readAccountSnapshot, readMMParams } from "../../src/predict/snapshot.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import type { RestingOrders } from "@hashpower/portfolio-margin";

/** An empty book on one venue. */
const NO_ORDERS: RestingOrders = { buyDelta: 0n, sellDelta: 0n, buyValue: 0n, sellValue: 0n };

const VAULT = "0x000000000000000000000000000000000000aa01" as Address;
const PME = "0x000000000000000000000000000000000000aa02" as Address;
const PERPS = "0x000000000000000000000000000000000000aa03" as Address;
const FUTURES = "0x000000000000000000000000000000000000aa04" as Address;
const USER = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x000000000000000000000000000000000000aa05" as Address;

const EXPIRY_A = 1_756_416_000n;
const EXPIRY_B = 1_759_008_000n;

function makeConfig(): Config {
  return {
    vault: { address: VAULT },
    pme: { address: PME },
    perps: { address: PERPS },
    futures: { address: FUTURES },
  } as Config;
}

function makeChain(scripted: {
  activeExpirationAts?: readonly bigint[];
  futuresPositions?: Record<string, { netQuantity: bigint; netEntryValue: bigint }>;
  /** Keyed by expiry; absent means the expiry has not settled. */
  settlementPrices?: Record<string, bigint>;
  perpNetQty?: bigint;
  perpEntry?: bigint;
  perpFunding?: bigint;
  perpOrders?: RestingOrders;
  futuresOrders?: RestingOrders;
  balance?: bigint;
  imShock?: bigint;
  mmShock?: bigint;
  tokenDecimals?: number;
  perpQtyDecimals?: number;
}): Chain {
  return {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "collateralToken") return USDC;
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      multicall: async ({
        contracts,
      }: {
        contracts: readonly { functionName: string; args?: readonly unknown[]; address?: Address }[];
      }) => {
        return contracts.map((c) => {
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
                aggregatedEntryPrice: scripted.perpEntry ?? 0n,
              };
            }
            case "settlementPrice": {
              const expirationAt = c.args?.[0] as bigint;
              return scripted.settlementPrices?.[expirationAt.toString()] ?? 0n;
            }
            case "getRiskView": {
              const orders =
                (c.address === PERPS ? scripted.perpOrders : scripted.futuresOrders) ?? NO_ORDERS;
              return {
                netPositionDelta: 0n,
                unrealizedPnl: 0n,
                // Only the perps venue accrues funding.
                pendingFunding: c.address === PERPS ? scripted.perpFunding ?? 0n : 0n,
                buyOrderDelta: orders.buyDelta,
                sellOrderDelta: orders.sellDelta,
                buyOrderFillLoss: 0n,
                sellOrderFillLoss: 0n,
              };
            }
            case "getOrderValues": {
              const orders =
                (c.address === PERPS ? scripted.perpOrders : scripted.futuresOrders) ?? NO_ORDERS;
              return [orders.buyValue, orders.sellValue];
            }
            case "getActiveExpirationDates":
              return scripted.activeExpirationAts ?? [];
            case "imSpotShock":
              return scripted.imShock ?? 10n ** 17n;
            case "mmSpotShock":
              return scripted.mmShock ?? 5n * 10n ** 16n;
            case "decimals":
              return scripted.tokenDecimals ?? 6;
            case "QUANTITY_DECIMALS":
              return scripted.perpQtyDecimals ?? 6;
            default:
              throw new Error(`unscripted call: ${c.functionName}`);
          }
        });
      },
    },
  } as unknown as Chain;
}

describe("predict/snapshot: readMMParams", () => {
  it("returns the engine-wide constants in one multicall", async () => {
    const params = await readMMParams(makeChain({}), makeConfig());
    assert.equal(params.imSpotShock, 10n ** 17n);
    assert.equal(params.mmSpotShock, 5n * 10n ** 16n);
    assert.equal(params.tokenDecimals, 6);
    assert.equal(params.perpQuantityDecimals, 6);
  });
});

describe("predict/snapshot: readAccountSnapshot", () => {
  it("returns a flat snapshot for a fresh user with no positions or orders", async () => {
    const chain = makeChain({ balance: 0n });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.equal(snap.user, USER);
    assert.equal(snap.balance, 0n);
    assert.equal(snap.perp.netQty, 0n);
    assert.equal(snap.perp.fundingOwed, 0n);
    assert.equal(snap.futures.positions.length, 0);
    assert.deepEqual(snap.perp.orders, NO_ORDERS);
    assert.deepEqual(snap.futures.orders, NO_ORDERS);
  });

  it("pairs each venue's getRiskView deltas with its getOrderValues totals", async () => {
    const perpOrders: RestingOrders = {
      buyDelta: 2_000_000n,
      sellDelta: 500_000n,
      buyValue: 190_000_000n,
      sellValue: 55_000_000n,
    };
    const futuresOrders: RestingOrders = {
      buyDelta: 1_000_000n,
      sellDelta: 0n,
      buyValue: 42_000_000n,
      sellValue: 0n,
    };
    const chain = makeChain({ perpOrders, futuresOrders });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    // The snapshot carries limit-price totals rather than the venue's fill loss at the
    // current mark, because the clamp makes that figure non-invertible once it reads
    // zero and the predictor needs the loss at prices other than the current one.
    assert.deepEqual(snap.perp.orders, perpOrders);
    assert.deepEqual(snap.futures.orders, futuresOrders);
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
