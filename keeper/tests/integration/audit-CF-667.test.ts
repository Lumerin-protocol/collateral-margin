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
  expectReducedToImBuffer,
  readPerpsPosition,
  runOneSweep,
} from "./helpers.ts";

/** Mirrors the perps on-chain `TimeInForce`. */
const GTC = 0;

/**
 * CF-667 (High): `liquidatePosition` settles the user's pending funding before its
 * OverLiquidation guard. For a funding receiver the fund credits that amount to the
 * balance, but the keeper's close solver ignores it and targets the exact IM edge, so
 * the close lands above IM on chain and reverts. The planner retries the same quantity
 * and never trims the account.
 *
 * Alice is short while a two-sided book sits above the index, so shorts receive funding
 * at the rate cap. Three days of accrual leave her owed about $60. The index then jumps
 * enough that she is below MM even after that credit, yet a partial close restores the
 * band. One sweep must land her inside `[MM, IM]` with the short still open.
 */

let node: HardhatNode;
let testClient: TestClient;
let keeper: KeeperHarness | undefined;
let receiverFixture: () => Promise<ReceiverFixture>;

interface ReceiverFixture extends BaseFixture {
  aliceQty: bigint;
  /** Index after the jump that puts Alice below MM. */
  jumpedMark: bigint;
}

const usd = (value: string) => parseUnits(value, 6);

function receiverFixtureBuilder(rpcUrl: string) {
  return async (): Promise<ReceiverFixture> => {
    const base = await baseFixture(rpcUrl);
    const { owner, alice, bob } = base.accounts;
    const mark = usd("50");
    const aliceQty = parseUnits("40", base.config.quantityDecimals);
    const bookQty = parseUnits("1", base.config.quantityDecimals);

    await base.setMark(mark);
    // 1% per day at most, the example in `setFundingParameters`.
    await write(base, owner, "setFundingParameters", [100n, 86_400n]);
    await base.deposit(alice.account.address, usd("250"));
    await base.deposit(bob.account.address, usd("5000"));

    // Alice rests the ask and is filled as maker (no fee): short 40 at $50.
    await write(base, alice, "createOrder", [mark, -aliceQty, GTC]);
    await write(base, bob, "createOrder", [mark, aliceQty, GTC]);
    // A two-sided book above the index: mid $50.75 vs index $50 clamps to the cap,
    // so longs pay and Alice's short receives.
    await write(base, bob, "createOrder", [usd("50.5"), bookQty, GTC]);
    await write(base, bob, "createOrder", [usd("51"), -bookQty, GTC]);

    await base.testClient.increaseTime({ seconds: 3 * 86_400 });
    // Refresh the oracle (1 h staleness), then any order accrues the window.
    await base.setMark(mark);
    await write(base, bob, "createOrder", [usd("50.4"), bookQty, GTC]);

    return { ...base, aliceQty, jumpedMark: usd("56") };
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
    receiverFixture = receiverFixtureBuilder(node.rpcUrl);
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

describe("CF-667 — the keeper partially liquidates a funding receiver", () => {
  it("one sweep closes part of the short into the [MM, IM] band", {
    timeout: 60_000,
  }, async () => {
    const ctx = await loadFixture(receiverFixture, testClient);
    const alice = ctx.accounts.alice.account.address;
    const pending = (await ctx.publicClient.readContract({
      address: ctx.addresses.perps,
      abi: ctx.abis.perps,
      functionName: "getPendingFunding",
      args: [alice],
    })) as bigint;
    assert.ok(
      pending < 0n,
      `precondition: alice receives funding, got ${pending}`,
    );

    keeper = buildKeeper(ctx);
    await keeper.start();
    // Her trade predates the watcher and any action of hers would settle the funding.
    keeper.tracker.add(alice);
    await ctx.setMark(ctx.jumpedMark);
    await runOneSweep(keeper, alice);

    await expectReducedToImBuffer(ctx, alice, 15_000);
    const after = await readPerpsPosition(ctx, alice);
    assert.ok(
      after.netQuantity < 0n && -after.netQuantity < ctx.aliceQty,
      `expected a partial close of the short, got netQuantity=${after.netQuantity}`,
    );
  });
});

async function write(
  stack: BaseFixture,
  wallet: Wallet,
  functionName: string,
  args: unknown[],
) {
  const hash = await wallet.client.writeContract({
    address: stack.addresses.perps,
    abi: stack.abis.perps,
    functionName,
    args: args as never,
    chain: hardhat,
    account: wallet.account,
  });
  const receipt = await stack.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error(`perps.${functionName} reverted`);
}
