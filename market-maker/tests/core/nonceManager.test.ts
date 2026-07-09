import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Account, Chain, PublicClient, WalletClient } from "viem";
import { NonceManager } from "../../src/core/nonceManager.ts";

const noop = () => {};
function makeLogger(): never {
  return {
    child: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
  } as never;
}

const account = {
  address: "0x1111111111111111111111111111111111111111",
} as unknown as Account;
const chain = { id: 31337 } as Chain;
const RECEIPT = { gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n };

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

interface Mocks {
  publicClient: PublicClient;
  walletClient: WalletClient;
  cancelCalls: { nonce: number }[];
}

function makeMocks(opts: {
  startNonce: number;
  receiptFor: (hash: string) => Promise<typeof RECEIPT>;
}): Mocks {
  const cancelCalls: { nonce: number }[] = [];
  const publicClient = {
    getTransactionCount: async () => opts.startNonce,
    waitForTransactionReceipt: ({ hash }: { hash: string }) => opts.receiptFor(hash),
  } as unknown as PublicClient;
  const walletClient = {
    sendTransaction: async ({ nonce }: { nonce: number }) => {
      cancelCalls.push({ nonce });
      return "0xcancel" as const;
    },
  } as unknown as WalletClient;
  return { publicClient, walletClient, cancelCalls };
}

describe("NonceManager", () => {
  it("assigns sequential nonces across submits and returns receipts", async () => {
    const mocks = makeMocks({ startNonce: 5, receiptFor: async () => RECEIPT });
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      {},
      makeLogger(),
    );

    const seenNonces: number[] = [];
    const broadcast = ({ nonce }: { nonce: number }) => {
      seenNonces.push(nonce);
      return Promise.resolve(`0x${nonce.toString(16)}` as `0x${string}`);
    };

    const a = await nm.submit(broadcast, { maxFeePerGas: 1n, label: "a" });
    const b = await nm.submit(broadcast, { maxFeePerGas: 1n, label: "b" });

    assert.deepEqual(seenNonces, [5, 6]);
    assert.equal(a.gasUsed, RECEIPT.gasUsed);
    assert.equal(b.gasUsed, RECEIPT.gasUsed);
  });

  it("serializes concurrent submits so nonces never collide", async () => {
    const mocks = makeMocks({ startNonce: 0, receiptFor: async () => RECEIPT });
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      {},
      makeLogger(),
    );
    const seen: number[] = [];
    const broadcast = ({ nonce }: { nonce: number }) => {
      seen.push(nonce);
      return Promise.resolve("0xaa" as const);
    };
    await Promise.all([
      nm.submit(broadcast, { maxFeePerGas: 1n, label: "1" }),
      nm.submit(broadcast, { maxFeePerGas: 1n, label: "2" }),
      nm.submit(broadcast, { maxFeePerGas: 1n, label: "3" }),
    ]);
    assert.deepEqual(seen, [0, 1, 2]);
  });

  it("replaces by fee on confirmation timeout, reusing the same nonce", async () => {
    // First broadcast's receipt never lands; second one confirms.
    const mocks = makeMocks({
      startNonce: 9,
      receiptFor: (hash) => (hash === "0xfirst" ? pending<typeof RECEIPT>() : Promise.resolve(RECEIPT)),
    });
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { confirmationTimeoutMs: 20, maxReplacements: 2, replacementFeeBumpPct: 10 },
      makeLogger(),
    );

    const attempts: { nonce: number; fee: bigint }[] = [];
    const broadcast = ({ nonce, maxFeePerGas }: { nonce: number; maxFeePerGas: bigint }) => {
      attempts.push({ nonce, fee: maxFeePerGas });
      return Promise.resolve((attempts.length === 1 ? "0xfirst" : "0xsecond") as `0x${string}`);
    };

    const outcome = await nm.submit(broadcast, { maxFeePerGas: 100n, label: "rbf" });
    assert.equal(outcome.gasUsed, RECEIPT.gasUsed);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].nonce, 9);
    assert.equal(attempts[1].nonce, 9); // same nonce
    assert.equal(attempts[1].fee, 110n); // +10%
    assert.equal(mocks.cancelCalls.length, 0);
  });

  it("escalates to a cancel-tx and advances after exhausting replacements", async () => {
    const mocks = makeMocks({ startNonce: 3, receiptFor: () => pending<typeof RECEIPT>() });
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { confirmationTimeoutMs: 10, maxReplacements: 1 },
      makeLogger(),
    );

    const broadcast = () => Promise.resolve("0xstuck" as const);
    await assert.rejects(nm.submit(broadcast, { maxFeePerGas: 100n, label: "stuck" }), /stuck at nonce 3/);
    assert.equal(mocks.cancelCalls.length, 1);
    assert.equal(mocks.cancelCalls[0].nonce, 3);

    // Nonce advanced past the wedged one for the next submit.
    const seen: number[] = [];
    const ok = ({ nonce }: { nonce: number }) => {
      seen.push(nonce);
      // receiptFor is still "pending" for all hashes, so return a landing one:
      return Promise.resolve("0xok" as const);
    };
    // Swap receiptFor to resolve now.
    (mocks.publicClient as unknown as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt =
      async () => RECEIPT;
    await nm.submit(ok, { maxFeePerGas: 1n, label: "next" });
    assert.deepEqual(seen, [4]);
  });

  it("fee-bumps and retries a transient submission error, then confirms", async () => {
    const mocks = makeMocks({ startNonce: 7, receiptFor: async () => RECEIPT });
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { maxReplacements: 2, replacementFeeBumpPct: 20 },
      makeLogger(),
    );

    const attempts: { nonce: number; fee: bigint }[] = [];
    const broadcast = ({ nonce, maxFeePerGas }: { nonce: number; maxFeePerGas: bigint }) => {
      attempts.push({ nonce, fee: maxFeePerGas });
      if (attempts.length === 1) return Promise.reject(new Error("nonce too low"));
      return Promise.resolve("0xok" as const);
    };

    const outcome = await nm.submit(broadcast, { maxFeePerGas: 100n, label: "flaky" });
    assert.equal(outcome.gasUsed, RECEIPT.gasUsed);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].nonce, 7, "same nonce reused on retry");
    assert.equal(attempts[1].fee, 120n, "fee bumped +20% after the error");
    assert.equal(mocks.cancelCalls.length, 0, "no cancel-tx for a recovered submit");
  });

  it("escalates to a cancel-tx and re-reads the nonce after a persistent send error", async () => {
    const mocks = makeMocks({ startNonce: 2, receiptFor: async () => RECEIPT });
    let counts = 0;
    (mocks.publicClient as unknown as { getTransactionCount: () => Promise<number> }).getTransactionCount =
      async () => {
        counts++;
        return counts === 1 ? 2 : 50; // desync: chain jumps ahead after reset
      };
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { maxReplacements: 1 },
      makeLogger(),
    );

    const broadcast = () => Promise.reject(new Error("execution reverted"));
    await assert.rejects(nm.submit(broadcast, { maxFeePerGas: 100n, label: "dead" }), /execution reverted/);
    assert.equal(mocks.cancelCalls.length, 1, "cancel-tx sent to free the wedged nonce");
    assert.equal(mocks.cancelCalls[0].nonce, 2);

    // resetNonce() forced a re-read; next submit picks up the chain's value.
    const seen: number[] = [];
    await nm.submit(
      ({ nonce }: { nonce: number }) => {
        seen.push(nonce);
        return Promise.resolve("0xok" as const);
      },
      { maxFeePerGas: 1n, label: "after" },
    );
    assert.deepEqual(seen, [50], "nonce re-read from chain after desync");
  });

  it("swallows a failing cancel-tx and still advances", async () => {
    const mocks = makeMocks({ startNonce: 8, receiptFor: () => pending<typeof RECEIPT>() });
    (mocks.walletClient as unknown as { sendTransaction: () => Promise<never> }).sendTransaction =
      async () => {
        throw new Error("cancel broadcast failed");
      };
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { confirmationTimeoutMs: 10, maxReplacements: 0 },
      makeLogger(),
    );
    // Timeout with 0 replacements → straight to cancel escalation, which fails
    // internally but must not propagate; the stuck error is what surfaces.
    await assert.rejects(
      nm.submit(() => Promise.resolve("0xstuck" as const), { maxFeePerGas: 1n, label: "wedged" }),
      /stuck at nonce 8/,
    );
  });

  it("resetNonce() forces a fresh chain read on the next submit", async () => {
    let counts = 0;
    const mocks = makeMocks({ startNonce: 0, receiptFor: async () => RECEIPT });
    (mocks.publicClient as unknown as { getTransactionCount: () => Promise<number> }).getTransactionCount =
      async () => {
        counts++;
        return counts === 1 ? 10 : 20;
      };
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      {},
      makeLogger(),
    );
    const seen: number[] = [];
    const broadcast = ({ nonce }: { nonce: number }) => {
      seen.push(nonce);
      return Promise.resolve("0xok" as const);
    };

    await nm.submit(broadcast, { maxFeePerGas: 1n, label: "1" });
    nm.resetNonce();
    await nm.submit(broadcast, { maxFeePerGas: 1n, label: "2" });
    assert.deepEqual(seen, [10, 20], "second submit re-read the nonce from chain");
  });
});
