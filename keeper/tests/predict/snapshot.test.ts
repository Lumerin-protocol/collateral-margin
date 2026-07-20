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
}): Chain {
  return {
    publicClient: {
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
            case "getOrderMargin":
              return scripted.perpOrderMargin ?? 0n;
            case "getPendingFunding":
              return scripted.perpFunding ?? 0n;
            case "getOrderMargin":
              return scripted.futuresOrderMargin ?? 0n;
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
});
