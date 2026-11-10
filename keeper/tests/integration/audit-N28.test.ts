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
import { HashPowerFuturesAbi } from "../../src/abi/HashPowerFutures.ts";
import { startHardhatNode, type HardhatNode } from "./nodeProcess.ts";
import { loadFixture } from "./loadFixture.ts";
import { buildKeeper, type KeeperHarness } from "./buildKeeper.ts";
import { baseFixture } from "./scenarios.ts";

/**
 * N28: the venue keeps its delivery dates clear of the halving by pinning each slot's date when
 * it comes within one of the tradable window. The keeper's delivery sweep pins any due slot so
 * the date is final before anyone trades it; the venue itself pins on the first trade otherwise.
 */

let node: HardhatNode;
let testClient: TestClient;
let keeper: KeeperHarness | undefined;
let stackFixture: () => ReturnType<typeof baseFixture>;

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
    stackFixture = () => baseFixture(node.rpcUrl);
  },
  { timeout: 60_000 },
);

after(async () => {
  await keeper?.stop();
  await node?.stop();
});

describe("N28 — the keeper pins due futures delivery dates", () => {
  it("the delivery sweep pins the slot past the window, and the next one after a roll", {
    timeout: 60_000,
  }, async () => {
    const ctx = await loadFixture(stackFixture, testClient);
    keeper = buildKeeper(ctx, { delivery: true });
    const futures = { address: ctx.addresses.futures, abi: HashPowerFuturesAbi } as const;
    const count = BigInt(
      await ctx.publicClient.readContract({ ...futures, functionName: "futureExpirationDatesCount" }),
    );
    const [, pinnedAtStart] = await ctx.publicClient.readContract({ ...futures, functionName: "deliverySchedule" });
    assert.equal(pinnedAtStart, count, "initialize pins the window");

    assert.ok(keeper.delivery, "delivery coordinator built");
    await keeper.delivery.pinDueExpiries();
    const [, pinnedAfterFirst] = await ctx.publicClient.readContract({ ...futures, functionName: "deliverySchedule" });
    assert.equal(pinnedAfterFirst, count + 1n, "one slot past the window is pinned");

    // Nothing more to pin until the window rolls.
    await keeper.delivery.pinDueExpiries();
    const [, pinnedAgain] = await ctx.publicClient.readContract({ ...futures, functionName: "deliverySchedule" });
    assert.equal(pinnedAgain, count + 1n);

    const dates = await ctx.publicClient.readContract({ ...futures, functionName: "getExpirationDates" });
    await testClient.request({
      method: "evm_setNextBlockTimestamp",
      params: [`0x${(dates[0] + 1n).toString(16)}`] as unknown as never,
    });
    await testClient.request({ method: "evm_mine", params: [] as unknown as never });
    await keeper.delivery.pinDueExpiries();
    const [currentSlot, pinnedAfterRoll, previousExpiry] = await ctx.publicClient.readContract({
      ...futures,
      functionName: "deliverySchedule",
    });
    assert.equal(currentSlot, 1n);
    assert.equal(pinnedAfterRoll, count + 2n, "the slot that became pinnable after the roll");
    assert.equal(previousExpiry, dates[0], "the matured date for settlement tracking");
  });
});
