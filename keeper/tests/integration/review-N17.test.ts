import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createTestClient,
  http,
  parseUnits,
  publicActions,
  walletActions,
  type TestClient,
} from "viem";
import { hardhat } from "viem/chains";
import { startHardhatNode, type HardhatNode } from "./nodeProcess.ts";
import { loadFixture } from "./loadFixture.ts";
import { buildKeeper, type KeeperHarness } from "./buildKeeper.ts";
import { baseFixture, type BaseFixture } from "./scenarios.ts";
import type { Wallet } from "./deployStack.ts";
import {
  expectLiquidated,
  readAccountMargins,
  readFuturesNetQuantity,
} from "./helpers.ts";

/** Mirrors both venues' on-chain `TimeInForce`. */
const GTC = 0;
/** Prd margin levels (IM 15% / MM 10% spot shock), in WAD. */
const IM_SPOT_SHOCK = parseUnits("0.15", 18);
const MM_SPOT_SHOCK = parseUnits("0.10", 18);
/** Prd futures `liquidationFeeBps`. */
const LIQUIDATION_FEE_BPS = 200;

/**
 * N17 (Medium): the keeper sizes futures liquidations with a zero liquidation fee, but the
 * venue charges `liquidationFeeBps` of the closed notional before its `OverLiquidation`
 * guard. Since the solver only returns closes its model says the venue accepts, it reports
 * nothing to close for an account the venue would liquidate.
 *
 * Alice holds one long at $59 and one at $57 on two expiries; at a $50 mark her $23.69
 * balance is under the $26 MM. Without the fee, closing either contract leaves her $0.19
 * above IM, which the guard rejects. With the 2% fee ($1 a contract) either close lands
 * between MM and IM, and the venue accepts it.
 */

let node: HardhatNode;
let testClient: TestClient;
let keeper: KeeperHarness | undefined;
let feeFixture: () => Promise<FeeFixture>;

interface FeeFixture extends BaseFixture {
  expirationAts: readonly [bigint, bigint];
  crashedMark: bigint;
}

const usd = (value: string) => parseUnits(value, 6);

function feeFixtureBuilder(rpcUrl: string) {
  return async (): Promise<FeeFixture> => {
    const base = await baseFixture(rpcUrl);
    const { owner, alice, bob } = base.accounts;
    const first = base.config.futuresFirstExpirationAt;
    const expirationAts = [first, first + 30n * 86_400n] as const;

    const [imVolShock, mmVolShock] = await Promise.all([
      read(base, "pme", "imVolShock"),
      read(base, "pme", "mmVolShock"),
    ]);
    await write(base, owner, "pme", "setShocks", [
      IM_SPOT_SHOCK,
      MM_SPOT_SHOCK,
      imVolShock,
      mmVolShock,
    ]);
    await write(base, owner, "futures", "setLiquidationFeeBps", [
      LIQUIDATION_FEE_BPS,
    ]);

    await base.setMark(usd("58"));
    await base.deposit(alice.account.address, usd("23.69"));
    await base.deposit(bob.account.address, usd("3000"));
    for (const [expirationAt, price] of [
      [expirationAts[0], usd("59")],
      [expirationAts[1], usd("57")],
    ] as const) {
      await write(base, bob, "futures", "createOrder", [
        price,
        expirationAt,
        -1n,
        GTC,
      ]);
      await write(base, alice, "futures", "createOrder", [
        price,
        expirationAt,
        1n,
        GTC,
      ]);
    }

    return { ...base, expirationAts, crashedMark: usd("50") };
  };
}

before(
  async () => {
    node = await startHardhatNode();
    testClient = createTestClient({
      chain: hardhat,
      mode: "hardhat",
      transport: http(node.rpcUrl),
    })
      .extend(publicActions)
      .extend(walletActions);
    feeFixture = feeFixtureBuilder(node.rpcUrl);
  },
  { timeout: 60_000 },
);

afterEach(async () => {
  await keeper?.stop();
  keeper = undefined;
});

after(async () => {
  await node?.stop();
});

describe("N17 — the keeper models the futures liquidation fee", () => {
  it("liquidates an account the venue accepts only once the fee is charged", {
    timeout: 120_000,
  }, async () => {
    const ctx = await loadFixture(feeFixture, testClient);
    const alice = ctx.accounts.alice.account.address;
    await ctx.crashOracles(ctx.crashedMark);

    const before = await readAccountMargins(ctx, alice);
    assert.ok(
      before.balance < before.mmRequired,
      `fixture must start underwater: balance=${before.balance}n mm=${before.mmRequired}n`,
    );
    for (const expirationAt of ctx.expirationAts) {
      await ctx.publicClient.simulateContract({
        address: ctx.addresses.futures,
        abi: ctx.abis.futures,
        functionName: "liquidatePositions",
        args: [alice, [expirationAt], [1n]],
        account: ctx.accounts.liquidator.account,
      });
    }

    keeper = buildKeeper(ctx);
    const outcome = await keeper.planner.run(alice);

    expectLiquidated(outcome);
    const open = await Promise.all(
      ctx.expirationAts.map((e) => readFuturesNetQuantity(ctx, alice, e)),
    );
    assert.equal(open[0] + open[1], 1n, "one of the two contracts closed");
    const m = await readAccountMargins(ctx, alice);
    assert.ok(
      m.balance >= m.mmRequired && m.balance <= m.imRequired,
      `expected MM <= balance <= IM, got balance=${m.balance}n mm=${m.mmRequired}n im=${m.imRequired}n`,
    );
  });
});

type Target = "pme" | "futures";

async function write(
  stack: BaseFixture,
  wallet: Wallet,
  target: Target,
  functionName: string,
  args: unknown[],
) {
  const hash = await wallet.client.writeContract({
    address: stack.addresses[target],
    abi: stack.abis[target],
    functionName,
    args: args as never,
    chain: hardhat,
    account: wallet.account,
  });
  const receipt = await stack.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error(`${target}.${functionName} reverted`);
}

async function read(stack: BaseFixture, target: Target, functionName: string) {
  return (await stack.publicClient.readContract({
    address: stack.addresses[target],
    abi: stack.abis[target],
    functionName,
  })) as bigint;
}
