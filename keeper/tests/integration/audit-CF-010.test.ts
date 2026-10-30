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
  readFuturesOrderIds,
  readPerpsOrderIds,
  readPerpsPosition,
  runOneSweep,
  waitFor,
} from "./helpers.ts";

/** Mirrors both venues' on-chain `TimeInForce`. */
const GTC = 0;
/** EIP-7825 per-transaction gas cap, which Base enforces. */
const TX_GAS_CAP = 16_777_216n;

/**
 * CF-010 (High): the keeper cancels every resting order of an underwater account in one
 * `liquidateOrders` call per venue. Each cancel re-checks the whole portfolio, so a full
 * dust book (100 perps orders, 100 per futures expiry) needs more gas than one
 * transaction may use. The call fails the same way on every retry, the orders leg never
 * clears, and the positions behind it are never liquidated.
 *
 * Alice rests the maximum dust book on perps and on two futures expiries, then her perps
 * long crashes. With the node held to the per-transaction cap, one sweep must cancel every
 * order and close the long.
 */

let node: HardhatNode;
let testClient: TestClient;
let keeper: KeeperHarness | undefined;
let dustFixture: () => Promise<DustFixture>;

interface DustFixture extends BaseFixture {
  crashedMark: bigint;
}

const usd = (value: string) => parseUnits(value, 6);

function dustFixtureBuilder(rpcUrl: string) {
  return async (): Promise<DustFixture> => {
    const base = await baseFixture(rpcUrl);
    const { alice, bob } = base.accounts;
    const mark = usd("50");
    const longQty = parseUnits("400", base.config.quantityDecimals);
    const dustQty = parseUnits("0.01", base.config.quantityDecimals);

    await base.setMark(mark);
    await base.deposit(alice.account.address, usd("6000"));
    await base.deposit(bob.account.address, usd("9500"));
    await write(base, bob, "perps", "createOrder", [mark, -longQty, GTC]);
    await write(base, alice, "perps", "createOrder", [mark, longQty, GTC]);

    // Dust bids far below the mark: no fill loss, almost no margin.
    const perpsMax = Number(
      await read(base, "perps", "MAX_ORDERS_PER_PARTICIPANT"),
    );
    for (let i = 0; i < perpsMax; i++) {
      await write(base, alice, "perps", "createOrder", [
        usd("5") + BigInt(i) * base.config.minimumPriceIncrement,
        dustQty,
        GTC,
      ]);
    }
    const futuresMax = Number(
      await read(base, "futures", "MAX_ORDERS_PER_PARTICIPANT_PER_EXPIRATION"),
    );
    const first = base.config.futuresFirstExpirationAt;
    for (const expirationAt of [first, first + 30n * 86_400n]) {
      for (let i = 0; i < futuresMax; i++) {
        await write(base, alice, "futures", "createOrder", [
          usd("5") + BigInt(i) * base.config.minimumPriceIncrement,
          expirationAt,
          1n,
          GTC,
        ]);
      }
    }

    return { ...base, crashedMark: usd("30") };
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
    dustFixture = dustFixtureBuilder(node.rpcUrl);
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

describe("CF-010 — a full dust order book cannot block liquidation", () => {
  it("one sweep cancels every order under the per-transaction gas cap and closes the long", {
    timeout: 120_000,
  }, async () => {
    const ctx = await loadFixture(dustFixture, testClient);
    const alice = ctx.accounts.alice.account.address;
    await ctx.testClient.request({
      method: "evm_setBlockGasLimit",
      params: [`0x${TX_GAS_CAP.toString(16)}`] as never,
    });

    keeper = buildKeeper(ctx);
    await keeper.start();
    keeper.tracker.add(alice);
    await ctx.setMark(ctx.crashedMark);
    await runOneSweep(keeper, alice);

    await waitFor(async () => {
      const [perpsIds, futuresIds, position] = await Promise.all([
        readPerpsOrderIds(ctx, alice),
        readFuturesOrderIds(ctx, alice),
        readPerpsPosition(ctx, alice),
      ]);
      return (
        perpsIds.length === 0 &&
        futuresIds.length === 0 &&
        position.netQuantity === 0n
      );
    }, 60_000).catch(() => undefined);

    assert.equal(
      (await readPerpsOrderIds(ctx, alice)).length,
      0,
      "perps orders left",
    );
    assert.equal(
      (await readFuturesOrderIds(ctx, alice)).length,
      0,
      "futures orders left",
    );
    assert.equal(
      (await readPerpsPosition(ctx, alice)).netQuantity,
      0n,
      "perps long not closed",
    );
  });
});

type Target = "perps" | "futures";

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
  })) as bigint | number;
}
