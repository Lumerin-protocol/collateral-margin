import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { FuturesVenue } from "../../src/venues/futures.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const FUTURES = "0x000000000000000000000000000000000000F00d" as Address;
const USER = "0x0000000000000000000000000000000000000b0b" as Address;
const EXPIRY = 1_756_416_000n;

const IM_SHOCK = 10n ** 17n;
const MM_SHOCK = 5n * 10n ** 16n;

interface ReadCall {
  functionName: string;
  args?: readonly unknown[];
}

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ConstructorParameters<typeof FuturesVenue>[2];

function makeConfigStub(dryRun: boolean, maxLots = 50): Config {
  return {
    futures: { address: FUTURES, maxLotsPerLiquidationTx: maxLots },
    vault: { address: "0x000000000000000000000000000000000000aa01" as Address },
    pme: { address: "0x000000000000000000000000000000000000aa02" as Address },
    perps: { address: "0x000000000000000000000000000000000000aa03" as Address },
    keeper: { dryRun },
    coordinator: { confirmationBlocks: 1 },
  } as Config;
}

function makeChainStub(opts: {
  balance: bigint;
  marketPrice: bigint;
  netQuantity: bigint;
  netEntryValue: bigint;
  onSimulate: (call: ReadCall) => void;
}): Chain {
  return {
    account: { address: "0x0000000000000000000000000000000000009999" as Address },
    publicClient: {
      readContract: async (call: ReadCall) => {
        if (call.functionName === "getMarketPrice") return opts.marketPrice;
        throw new Error(`unexpected readContract: ${call.functionName}`);
      },
      multicall: async ({ contracts }: { contracts: readonly ReadCall[] }) => {
        const fns = contracts.map((c) => c.functionName);
        if (fns[0] === "imSpotShock") return [IM_SHOCK, MM_SHOCK, 6, 6];
        if (fns[0] === "balanceOf") {
          return [
            opts.balance,
            { netQuantity: 0n, aggregatedEntryPrice: 0n },
            0n,
            0n,
            0n,
            [EXPIRY],
          ];
        }
        if (fns[0] === "getUserPosition") {
          return contracts.map(() => ({
            netQuantity: opts.netQuantity,
            netEntryValue: opts.netEntryValue,
          }));
        }
        throw new Error(`unexpected multicall head: ${fns[0]}`);
      },
      simulateContract: async (call: ReadCall) => {
        opts.onSimulate(call);
        return { request: { ...call } };
      },
    },
  } as unknown as Chain;
}

describe("futures venue: reduceToTarget", () => {
  it("sizes a closeQty and submits liquidatePositions(expirationAts, closeQtys)", async () => {
    let simulated: ReadCall | undefined;
    const chain = makeChainStub({
      balance: 136_000_000n,
      marketPrice: 30_000_000n,
      netQuantity: 12n,
      netEntryValue: 12n * 40_000_000n,
      onSimulate: (call) => {
        simulated = call;
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(true), silentLogger);
    const outcome = await venue.reduceToTarget(USER);

    assert.ok(simulated, "should simulate a liquidatePositions call");
    assert.equal(simulated?.functionName, "liquidatePositions");
    const [participant, expirationAts, closeQtys] = simulated?.args as [
      Address,
      bigint[],
      bigint[],
    ];
    assert.equal(participant, USER);
    assert.ok(expirationAts.length >= 1);
    assert.ok(expirationAts.every((e) => e === EXPIRY));
    const totalClose = closeQtys.reduce((s, q) => s + q, 0n);
    assert.ok(totalClose > 0n && totalClose < 12n, "strict subset of contracts");
    assert.ok("feeEarned" in outcome && outcome.positionsClosed === Number(totalClose));
  });

  it("caps the batch to maxLotsPerLiquidationTx (expiry-leg chunking)", async () => {
    const EXPIRY_B = EXPIRY + 86_400n;
    let simulated: ReadCall | undefined;
    const chain = {
      account: { address: "0x0000000000000000000000000000000000009999" as Address },
      publicClient: {
        readContract: async (call: ReadCall) => {
          if (call.functionName === "getMarketPrice") return 100_000n;
          throw new Error(`unexpected readContract: ${call.functionName}`);
        },
        multicall: async ({ contracts }: { contracts: readonly ReadCall[] }) => {
          const fns = contracts.map((c) => c.functionName);
          if (fns[0] === "imSpotShock") return [IM_SHOCK, MM_SHOCK, 6, 6];
          if (fns[0] === "balanceOf") {
            return [
              1_000_000n,
              { netQuantity: 0n, aggregatedEntryPrice: 0n },
              0n,
              0n,
              0n,
              [EXPIRY, EXPIRY_B, EXPIRY + 172_800n],
            ];
          }
          if (fns[0] === "getUserPosition") {
            return contracts.map((c) => {
              const expirationAt = c.args?.[1] as bigint;
              return {
                netQuantity: 4n,
                netEntryValue: 4n * 40_000_000n,
                _expirationAt: expirationAt,
              };
            });
          }
          throw new Error(`unexpected multicall head: ${fns[0]}`);
        },
        simulateContract: async (call: ReadCall) => {
          simulated = call;
          return { request: { ...call } };
        },
      },
    } as unknown as Chain;

    const venue = new FuturesVenue(chain, makeConfigStub(true, 2), silentLogger);
    const outcome = await venue.reduceToTarget(USER);
    assert.ok(simulated);
    const [, expirationAts] = simulated?.args as [Address, bigint[], bigint[]];
    assert.equal(expirationAts.length, 2, "capped to 2 expiry legs");
    assert.ok("feeEarned" in outcome);
  });

  it("returns nothingToClose when already healthy", async () => {
    const chain = makeChainStub({
      balance: 1_000_000_000n,
      marketPrice: 30_000_000n,
      netQuantity: 1n,
      netEntryValue: 40_000_000n,
      onSimulate: () => {
        throw new Error("should not simulate");
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(true), silentLogger);
    const outcome = await venue.reduceToTarget(USER);
    assert.deepEqual(outcome, { skipped: "nothingToClose" });
  });
});
