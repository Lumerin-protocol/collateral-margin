import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createTestClient,
  http,
  publicActions,
  walletActions,
  type TestClient,
} from "viem";
import { hardhat } from "viem/chains";
import { startHardhatNode, type HardhatNode } from "./nodeProcess.ts";
import { loadFixture } from "./loadFixture.ts";
import { buildKeeper, type KeeperHarness } from "./buildKeeper.ts";
import {
  expectReducedToImBuffer,
  readPerpsPosition,
  runOneSweep,
} from "./helpers.ts";
import { halvingPerpsPartialCrashFixtureBuilder } from "./scenarios.ts";

/**
 * CF-321: the keeper sizes a perps partial close with the replica, which takes the index and
 * moves the perps mark (the glide) with it. Handing it the glide instead values the position
 * twice discounted, so the close is mis-sized during the glide.
 */

let node: HardhatNode;
let testClient: TestClient;
let keeper: KeeperHarness | undefined;
let halvingPerpsPartialCrashFixture: ReturnType<
  typeof halvingPerpsPartialCrashFixtureBuilder
>;

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
    halvingPerpsPartialCrashFixture = halvingPerpsPartialCrashFixtureBuilder(
      node.rpcUrl,
    );
  },
  { timeout: 60_000 },
);

after(async () => {
  await keeper?.stop();
  await node?.stop();
});

describe("CF-321 — keeper liquidation sizing with perps on the glide", () => {
  it("reduces a perps long on the glide into the [MM, IM] band", {
    timeout: 60_000,
  }, async () => {
    const ctx = await loadFixture(halvingPerpsPartialCrashFixture, testClient);
    keeper = buildKeeper(ctx);
    await keeper.start();

    const alice = ctx.accounts.alice.account.address;
    const before = await readPerpsPosition(ctx, alice);
    assert.equal(
      before.netQuantity,
      ctx.aliceQty,
      "precondition: alice long 5",
    );

    await ctx.makeLiquidatable();
    await runOneSweep(keeper, alice);

    await expectReducedToImBuffer(ctx, alice);
    const after = await readPerpsPosition(ctx, alice);
    assert.ok(
      after.netQuantity > 0n && after.netQuantity < before.netQuantity,
      `expected a partial close, before=${before.netQuantity} after=${after.netQuantity}`,
    );
  });
});
