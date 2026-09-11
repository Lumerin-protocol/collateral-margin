import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { PortfolioCollateralAccount } from "../../src/core/portfolioCollateral.ts";
import type {
  BatchableCollateralAccount,
  CollateralAccount,
  CollateralSnapshot,
  MarginReadPlan,
} from "../../src/core/adapter.ts";

/** A multicall mock that echoes each contract's `args[0]` back as its result. */
function makeMulticallSpy(): { publicClient: PublicClient; state: { calls: number } } {
  const state = { calls: 0 };
  const publicClient = {
    multicall: async ({ contracts }: { contracts: { args: unknown[] }[] }) => {
      state.calls++;
      return contracts.map((c) => c.args[0]);
    },
  } as unknown as PublicClient;
  return { publicClient, state };
}

function reads(values: bigint[]): MarginReadPlan["shared"] {
  return values.map((v) => ({
    address: "0x0000000000000000000000000000000000000001",
    abi: [],
    functionName: "x",
    args: [v],
  })) as unknown as MarginReadPlan["shared"];
}

// vault, IM, MM, wallet, native, portfolio order margin
const SHARED = [100n, 200n, 300n, 400n, 500n, 600n];

function decodeShared(results: readonly unknown[]): Omit<CollateralSnapshot, "venueUnrealizedPnl"> {
  const r = results as bigint[];
  return {
    vaultBalance: r[0],
    portfolioIM: r[1],
    portfolioMM: r[2],
    walletTokenBalance: r[3],
    nativeBalance: r[4],
    portfolioOrderMargin: r[5],
    collateralToken: "0x00000000000000000000000000000000000000aa",
  };
}

function makeBatchable(sharedValues: bigint[], pnl: bigint): BatchableCollateralAccount {
  const buildMarginReadPlan = async (): Promise<MarginReadPlan> => ({
    shared: reads(sharedValues),
    venue: reads([pnl]),
    decode: (results) => ({
      ...decodeShared(results),
      venueUnrealizedPnl: (results as bigint[])[6],
    }),
  });
  return {
    buildMarginReadPlan,
    snapshot: async () => {
      const plan = await buildMarginReadPlan();
      return plan.decode([...sharedValues, pnl]);
    },
    imSpotShock: async () => 0n,
    deposit: async () => {},
    canPlace: async () => true,
  };
}

describe("PortfolioCollateralAccount", () => {
  it("batches all venues into one multicall, reading shared state once", async () => {
    const spy = makeMulticallSpy();
    const a = makeBatchable(SHARED, 22n);
    // b's shared values are ignored (aggregator reads shared from the first plan).
    const b = makeBatchable([9n, 9n, 9n, 9n, 9n, 9n], 44n);
    const acct = new PortfolioCollateralAccount([a, b], spy.publicClient);

    const snap = await acct.snapshot();

    assert.equal(spy.state.calls, 1); // single RPC round trip
    assert.equal(snap.vaultBalance, 100n); // shared from first plan
    assert.equal(snap.portfolioIM, 200n);
    // Order margin is a shared read of the engine's portfolio-wide figure, so it is
    // taken once and not summed across venues the way per-venue PnL is.
    assert.equal(snap.portfolioOrderMargin, 600n);
    assert.equal(snap.venueUnrealizedPnl, 66n); // 22 + 44
  });

  it("falls back to per-account snapshot when an account is not batchable", async () => {
    const spy = makeMulticallSpy();
    const legacy: CollateralAccount = {
      snapshot: async () => ({
        vaultBalance: 1_000n,
        portfolioIM: 50n,
        portfolioMM: 25n,
        portfolioOrderMargin: 7n,
        venueUnrealizedPnl: -3n,
        walletTokenBalance: 0n,
        nativeBalance: 0n,
        collateralToken: "0x00000000000000000000000000000000000000aa",
      }),
      imSpotShock: async () => 0n,
      deposit: async () => {},
      canPlace: async () => true,
    };
    const batchable = makeBatchable(SHARED, 5n);
    const acct = new PortfolioCollateralAccount([legacy, batchable], spy.publicClient);

    const snap = await acct.snapshot();
    assert.equal(spy.state.calls, 0); // no batched multicall; each account snapshots itself
    assert.equal(snap.vaultBalance, 1_000n); // primary = first (legacy)
    assert.equal(snap.portfolioOrderMargin, 7n); // from the primary, not summed
    assert.equal(snap.venueUnrealizedPnl, 2n); // -3 + 5
  });

  it("rejects construction with no accounts", () => {
    const spy = makeMulticallSpy();
    assert.throws(
      () => new PortfolioCollateralAccount([], spy.publicClient),
      /at least one account/,
    );
  });

  it("delegates the shared-vault operations to the first account", async () => {
    const spy = makeMulticallSpy();
    const calls: string[] = [];
    const primary: CollateralAccount = {
      snapshot: async () => makeBatchable(SHARED, 0n).snapshot(),
      imSpotShock: async () => {
        calls.push("shock");
        return 42n;
      },
      deposit: async (amount) => {
        calls.push(`deposit:${amount}`);
      },
      canPlace: async (im) => {
        calls.push(`canPlace:${im}`);
        return im < 100n;
      },
    };
    const secondary = makeBatchable(SHARED, 1n);
    const acct = new PortfolioCollateralAccount([primary, secondary], spy.publicClient);

    assert.equal(await acct.imSpotShock(), 42n);
    await acct.deposit(7n);
    assert.equal(await acct.canPlace(50n), true);
    assert.equal(await acct.canPlace(150n), false);
    assert.deepEqual(calls, ["shock", "deposit:7", "canPlace:50", "canPlace:150"]);
  });
});
