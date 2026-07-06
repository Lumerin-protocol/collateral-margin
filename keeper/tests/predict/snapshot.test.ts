import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { readAccountSnapshot, readMMParams } from "../../src/predict/snapshot.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const VAULT = "0x000000000000000000000000000000000000aa01" as Address;
const PME = "0x000000000000000000000000000000000000aa02" as Address;
const PERPS = "0x000000000000000000000000000000000000aa03" as Address;
const FUTURES = "0x000000000000000000000000000000000000aa04" as Address;
const USER = "0x1111111111111111111111111111111111111111" as Address;
const BUYER_POS_ID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SELLER_POS_ID = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeConfig(): Config {
  return {
    vault: { address: VAULT },
    pme: { address: PME },
    perps: { address: PERPS },
    futures: { address: FUTURES },
  } as Config;
}

/**
 * Builds a chain stub with scripted multicall responses keyed on
 * `functionName` — same pattern as the coordinator harness, kept local so
 * each test reads as a self-contained record of the on-chain shape it
 * exercises.
 */
function makeChain(scripted: {
  futuresPositionIds?: readonly string[];
  futuresPositions?: Record<
    string,
    { buyer: string; seller: string; buyPricePerDay: bigint; sellPricePerDay: bigint; deliveryAt: bigint }
  >;
  perpNetQty?: bigint;
  perpEntry?: bigint;
  perpOrderMargin?: bigint;
  perpFunding?: bigint;
  futuresOrderMargin?: bigint;
  balance?: bigint;
  imShock?: bigint;
  mmShock?: bigint;
  tokenDecimals?: number;
  perpQtyDecimals?: number;
  deliveryDays?: number;
}): Chain {
  return {
    publicClient: {
      multicall: async ({
        contracts,
      }: {
        contracts: readonly { functionName: string; args?: readonly unknown[] }[];
      }) => {
        return contracts.map((c) => {
          switch (c.functionName) {
            case "balanceOf":
              return scripted.balance ?? 0n;
            case "getUserPosition":
              return {
                netQuantity: scripted.perpNetQty ?? 0n,
                aggregatedEntryPrice: scripted.perpEntry ?? 0n,
              };
            case "getOrderMargin":
              return scripted.perpOrderMargin ?? 0n;
            case "getPendingFunding":
              return scripted.perpFunding ?? 0n;
            case "getFuturesOrderMargin":
              return scripted.futuresOrderMargin ?? 0n;
            case "getPositionIds":
              return scripted.futuresPositionIds ?? [];
            case "deliveryDurationDays":
              return scripted.deliveryDays ?? 30;
            case "getPositionById": {
              const id = c.args?.[0] as string;
              const pos = scripted.futuresPositions?.[id];
              if (pos === undefined) throw new Error(`unscripted position ${id}`);
              return pos;
            }
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
    assert.equal(snap.futures.deliveryDays, 30n);
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

  it("hydrates futures positions and assigns isBuyer based on the buyer field", async () => {
    const chain = makeChain({
      futuresPositionIds: [BUYER_POS_ID, SELLER_POS_ID],
      futuresPositions: {
        [BUYER_POS_ID]: {
          buyer: USER,
          seller: "0x000000000000000000000000000000000000feed",
          buyPricePerDay: 50n,
          sellPricePerDay: 51n,
          deliveryAt: 1_756_416_000n,
        },
        [SELLER_POS_ID]: {
          buyer: "0x000000000000000000000000000000000000feed",
          seller: USER,
          buyPricePerDay: 60n,
          sellPricePerDay: 59n,
          deliveryAt: 1_759_008_000n,
        },
      },
    });
    const snap = await readAccountSnapshot(chain, makeConfig(), USER);
    assert.equal(snap.futures.positions.length, 2);
    const buyer = snap.futures.positions.find((p) => p.id === BUYER_POS_ID);
    const seller = snap.futures.positions.find((p) => p.id === SELLER_POS_ID);
    assert.equal(buyer?.isBuyer, true);
    assert.equal(buyer?.entryPricePerDay, 50n);
    assert.equal(buyer?.deliveryAt, 1_756_416_000n);
    assert.equal(seller?.isBuyer, false);
    assert.equal(seller?.entryPricePerDay, 59n);
    assert.equal(seller?.deliveryAt, 1_759_008_000n);
  });
});
