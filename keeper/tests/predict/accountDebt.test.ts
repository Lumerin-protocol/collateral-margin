import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import { readAccountSnapshot } from "../../src/predict/snapshot.ts";

const VAULT = "0x000000000000000000000000000000000000aa01" as Address;
const PME = "0x000000000000000000000000000000000000aa02" as Address;
const PERPS = "0x000000000000000000000000000000000000aa03" as Address;
const FUTURES = "0x000000000000000000000000000000000000aa04" as Address;
const USER = "0x1111111111111111111111111111111111111111" as Address;
const DEBT = 8_000_000_000n;

const chain = {
  publicClient: {
    getBlockNumber: async () => 42n,
    multicall: async ({
      contracts,
    }: {
      contracts: readonly { functionName: string }[];
    }) =>
      contracts.map(({ functionName }) => {
        switch (functionName) {
          case "balanceOf":
            return 0n;
          case "accountDebt":
            return DEBT;
          case "getUserPosition":
            return { netQuantity: 0n, netEntryValue: 0n };
          case "getRiskView":
            return {
              netPositionDelta: 0n,
              unrealizedPnl: 0n,
              pendingFunding: 0n,
              buyOrderDelta: 0n,
              sellOrderDelta: 0n,
              buyOrderFillLoss: 0n,
              sellOrderFillLoss: 0n,
            };
          case "getOrderAggregate":
            return {
              buyQty: 0n,
              sellQty: 0n,
              buyPQ: 0n,
              buyP2Q: 0n,
              sellPQ: 0n,
              sellP2Q: 0n,
            };
          case "getActiveExpirationDates":
          case "getExpirationDates":
            return [];
          default:
            throw new Error(`unexpected call: ${functionName}`);
        }
      }),
  },
} as unknown as Chain;

const config = {
  vault: { address: VAULT },
  pme: { address: PME },
  perps: { address: PERPS },
  futures: { address: FUTURES },
} as Config;

describe("CF-665 step B: keeper snapshot carries account debt", () => {
  it("reads debt from the vault into the off-chain margin snapshot", async () => {
    const snapshot = await readAccountSnapshot(chain, config, USER);
    const withDebt = snapshot as typeof snapshot & { accountDebt: bigint };
    assert.equal(withDebt.accountDebt, DEBT);
  });
});
