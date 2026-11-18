import { describe, it, before, after } from "node:test";
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
import { baseFixture, type BaseFixture } from "./scenarios.ts";
import type { Wallet } from "./deployStack.ts";

/** Mirrors both venues' on-chain `TimeInForce`. */
const GTC = 0;
const IOC = 1;

/**
 * CF-669 (Critical): a perps long hedged by a futures short nets to zero margin across venues,
 * but each venue realizes its own leg against the vault. At expiry anyone settles the losing
 * futures leg first, so its loss is written off at a zero balance, and the winning perps leg is
 * then paid in full. With a colluder on the other side of both legs the pair takes both gains
 * from the insurance fund.
 *
 * End-to-end exploit on the real stack. Setup runs normally; the extraction steps may revert
 * on a fixed stack. The test asserts the safe invariant: the pair ends with no more than it put
 * in, the fund is not drained, nothing is borrowed and nothing halts.
 */

let node: HardhatNode;
let testClient: TestClient;
let basisFixture: () => Promise<BasisFixture>;

interface BasisFixture extends BaseFixture {
  mark: bigint;
  perpsQty: bigint;
  futuresQty: bigint;
  expirationAt: bigint;
  /** USDC held outside plus inside the vault by the attacking pair after setup deposits. */
  wealthBefore: bigint;
}

const usd = (value: string) => parseUnits(value, 6);

function basisFixtureBuilder(rpcUrl: string) {
  return async (): Promise<BasisFixture> => {
    const base = await baseFixture(rpcUrl);
    const mark = usd("50");
    await base.setMark(mark);
    const { alice, bob } = base.accounts;
    const futuresQty = 1_000n;
    const perpsQty = parseUnits("1000", base.config.quantityDecimals);
    const expirationAt = base.config.futuresFirstExpirationAt;
    const wealthBefore = await wealth(base, [alice, bob]);

    // Transient collateral covers the perps leg until the futures leg hedges it.
    await base.deposit(alice.account.address, usd("6000"));
    await base.deposit(bob.account.address, usd("6000"));
    await write(base, bob, "perps", "createOrder", [mark, -perpsQty, GTC]);
    await write(base, alice, "perps", "createOrder", [mark, perpsQty, IOC]);
    await write(base, bob, "futures", "createOrder", [
      mark,
      expirationAt,
      futuresQty,
      GTC,
    ]);
    await write(base, alice, "futures", "createOrder", [
      mark,
      expirationAt,
      -futuresQty,
      IOC,
    ]);
    await withdrawAll(base, alice);
    await withdrawAll(base, bob);

    return { ...base, mark, perpsQty, futuresQty, expirationAt, wealthBefore };
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
    basisFixture = basisFixtureBuilder(node.rpcUrl);
  },
  { timeout: 60_000 },
);

after(async () => {
  await node?.stop();
});

describe("CF-669 — a cross-venue basis hedge realized loser-first cannot drain the insurance fund", () => {
  it("settling the losing futures leg first does not let the pair keep the perps gain", {
    timeout: 60_000,
  }, async () => {
    const ctx = await loadFixture(basisFixture, testClient);
    const { alice, bob, liquidator: keeper } = ctx.accounts;
    assert.equal(
      await vaultBalance(ctx, alice),
      0n,
      "alice holds the hedge at zero balance",
    );
    assert.equal(
      await vaultBalance(ctx, bob),
      0n,
      "bob holds the hedge at zero balance",
    );
    const fundBefore = await read(ctx, "vault", "insuranceFundBalance", []);

    await ctx.testClient.setNextBlockTimestamp({ timestamp: ctx.expirationAt });
    const moved = (ctx.mark * 110n) / 100n;
    await ctx.setMark(moved);

    try {
      // Alice's futures short loses: settled first, its loss is written off.
      await write(ctx, keeper, "futures", "settlePosition", [
        alice.account.address,
        ctx.expirationAt,
      ]);
      // Bob buys back his losing perps short as the maker; Alice sells her winning long into it.
      await write(ctx, bob, "perps", "createOrder", [moved, ctx.perpsQty, GTC]);
      await write(ctx, alice, "perps", "createOrder", [
        moved,
        -ctx.perpsQty,
        IOC,
      ]);
      // Bob's winning futures long settles last.
      await write(ctx, keeper, "futures", "settlePosition", [
        bob.account.address,
        ctx.expirationAt,
      ]);
      await withdrawAll(ctx, alice);
      await withdrawAll(ctx, bob);
    } catch {
      // extraction refused — no value moved
    }

    assert.ok(
      (await wealth(ctx, [alice, bob])) <= ctx.wealthBefore,
      "colluding pair must not end with more than it put in",
    );
    assert.ok(
      (await read(ctx, "vault", "insuranceFundBalance", [])) >= fundBefore,
      "insurance fund must not be drained",
    );
    assert.equal(
      await read(ctx, "vault", "insuranceDebt", []),
      0n,
      "nothing may be borrowed against the fund",
    );
    assert.equal(
      await read(ctx, "vault", "halted", []),
      false,
      "the attack must not latch the vault halt",
    );
  });
});

type Target = "vault" | "perps" | "futures" | "usdc";

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

async function read(
  stack: BaseFixture,
  target: Target,
  functionName: string,
  args: unknown[],
) {
  return (await stack.publicClient.readContract({
    address: stack.addresses[target],
    abi: stack.abis[target],
    functionName,
    args: args as never,
  })) as bigint | boolean;
}

async function vaultBalance(stack: BaseFixture, wallet: Wallet) {
  return (await read(stack, "vault", "balanceOf", [
    wallet.account.address,
  ])) as bigint;
}

async function withdrawAll(stack: BaseFixture, wallet: Wallet) {
  const balance = await vaultBalance(stack, wallet);
  if (balance > 0n) await write(stack, wallet, "vault", "withdraw", [balance]);
}

async function wealth(stack: BaseFixture, wallets: Wallet[]) {
  let total = 0n;
  for (const w of wallets) {
    total += (await read(stack, "usdc", "balanceOf", [
      w.account.address,
    ])) as bigint;
    total += await vaultBalance(stack, w);
  }
  return total;
}
