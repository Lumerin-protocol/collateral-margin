import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Account,
  Chain,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from "viem";
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

function makeMocks(opts: {
  startNonce: number;
  receiptFor: (hash: string) => Promise<typeof RECEIPT>;
}) {
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
    mocks.publicClient.waitForTransactionReceipt = async () =>
      RECEIPT as TransactionReceipt;
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
      // A non-nonce transient error (RPC hiccup) → fee-bump + retry same nonce.
      if (attempts.length === 1) return Promise.reject(new Error("429 Too Many Requests"));
      return Promise.resolve("0xok" as const);
    };

    const outcome = await nm.submit(broadcast, { maxFeePerGas: 100n, label: "flaky" });
    assert.equal(outcome.gasUsed, RECEIPT.gasUsed);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].nonce, 7, "same nonce reused on retry");
    assert.equal(attempts[1].fee, 120n, "fee bumped +20% after the error");
    assert.equal(mocks.cancelCalls.length, 0, "no cancel-tx for a recovered submit");
  });

  it("resyncs to the chain nonce (no fee-bump, no cancel) when another party advances it", async () => {
    // A keeper sharing this wallet consumes nonce 100 before our broadcast lands,
    // so the first send is rejected "nonce too low". We must re-read the chain and
    // retry at the fresh nonce — NOT fee-bump a spent nonce or send a cancel-tx.
    let reads = 0;
    const mocks = makeMocks({ startNonce: 100, receiptFor: async () => RECEIPT });
    mocks.publicClient.getTransactionCount = async () => {
      reads++;
      return reads === 1 ? 100 : 101; // chain advanced by the other party
    };
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { maxReplacements: 2, replacementFeeBumpPct: 20, maxNonceResyncs: 5 },
      makeLogger(),
    );

    const attempts: { nonce: number; fee: bigint }[] = [];
    const broadcast = ({ nonce, maxFeePerGas }: { nonce: number; maxFeePerGas: bigint }) => {
      attempts.push({ nonce, fee: maxFeePerGas });
      if (attempts.length === 1) {
        return Promise.reject(
          new Error("Nonce provided for the transaction (100) is lower than the current nonce"),
        );
      }
      return Promise.resolve("0xok" as const);
    };

    const outcome = await nm.submit(broadcast, { maxFeePerGas: 100n, label: "shared" });
    assert.equal(outcome.gasUsed, RECEIPT.gasUsed);
    assert.deepEqual(
      attempts.map((a) => a.nonce),
      [100, 101],
      "retried at the fresh chain nonce",
    );
    assert.equal(attempts[1].fee, 100n, "fee reset to base for the fresh nonce (not bumped)");
    assert.equal(mocks.cancelCalls.length, 0, "no cancel-tx for a nonce someone else spent");
  });

  it("keeps the same nonce and bumps fee on 'replacement transaction underpriced'", async () => {
    // A same-nonce replacement that was under-bumped must retry the SAME nonce
    // with a higher fee — it must NOT be treated as a stolen nonce and resynced.
    let reads = 0;
    const mocks = makeMocks({ startNonce: 42, receiptFor: async () => RECEIPT });
    mocks.publicClient.getTransactionCount = async () => {
      reads++;
      return 42; // if this were wrongly treated as desync, a re-read would happen
    };
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
      if (attempts.length === 1) {
        return Promise.reject(new Error("replacement transaction underpriced"));
      }
      return Promise.resolve("0xok" as const);
    };

    const outcome = await nm.submit(broadcast, { maxFeePerGas: 100n, label: "rbf" });
    assert.equal(outcome.gasUsed, RECEIPT.gasUsed);
    assert.deepEqual(
      attempts.map((a) => a.nonce),
      [42, 42],
      "same nonce reused for the replacement",
    );
    assert.equal(attempts[1].fee, 120n, "fee bumped +20% for the replacement");
    assert.equal(reads, 1, "no nonce re-read for a same-nonce replacement");
    assert.equal(mocks.cancelCalls.length, 0);
  });

  it("gives up after maxNonceResyncs when the nonce keeps getting stolen", async () => {
    const mocks = makeMocks({ startNonce: 5, receiptFor: async () => RECEIPT });
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { maxReplacements: 0, maxNonceResyncs: 2 },
      makeLogger(),
    );

    let calls = 0;
    const broadcast = () => {
      calls++;
      return Promise.reject(new Error("nonce too low"));
    };
    await assert.rejects(
      nm.submit(broadcast, { maxFeePerGas: 1n, label: "contended" }),
      /nonce too low/,
    );
    // 1 initial + 2 resyncs = 3 broadcast attempts, then throw immediately.
    assert.equal(calls, 3, "bounded by maxNonceResyncs");
    assert.equal(
      mocks.cancelCalls.length,
      0,
      "no cancel-tx: a nonce someone else spent cannot be cancelled",
    );
  });

  it("escalates to a cancel-tx and re-reads the nonce after a persistent send error", async () => {
    const mocks = makeMocks({ startNonce: 2, receiptFor: async () => RECEIPT });
    let counts = 0;
    mocks.publicClient.getTransactionCount = async () => {
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
    mocks.walletClient.sendTransaction = async () => {
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

  it("retries a fee cap below the base fee from the fresh base fee, logging warnings only", async () => {
    // Base's base fee can triple within half a minute (daily around 00:02 UTC), so a fee
    // read seconds earlier is rejected; a 15% bump alone stays below the new base fee.
    const mocks = makeMocks({ startNonce: 106_830, receiptFor: async () => RECEIPT });
    mocks.publicClient.getBlock = (async () => ({
      baseFeePerGas: 18_800_000n,
    })) as PublicClient["getBlock"];
    const levels: string[] = [];
    const record = (level: string) => () => levels.push(level);
    const logger = {
      child: () => ({ info: noop, debug: noop, warn: record("warn"), error: record("error") }),
    } as never;
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { maxReplacements: 2, replacementFeeBumpPct: 15 },
      logger,
    );

    const attempts: { nonce: number; fee: bigint }[] = [];
    const broadcast = ({ nonce, maxFeePerGas }: { nonce: number; maxFeePerGas: bigint }) => {
      attempts.push({ nonce, fee: maxFeePerGas });
      if (maxFeePerGas < 18_800_000n) {
        return Promise.reject(
          new Error("The fee cap (`maxFeePerGas` = 0.012 gwei) cannot be lower than the block base fee."),
        );
      }
      return Promise.resolve("0xok" as const);
    };

    const outcome = await nm.submit(broadcast, { maxFeePerGas: 12_000_000n, label: "perps" });
    assert.equal(outcome.gasUsed, RECEIPT.gasUsed);
    assert.deepEqual(
      attempts.map((a) => a.nonce),
      [106_830, 106_830],
      "recovered on the first retry, same nonce",
    );
    assert.ok(attempts[1].fee > 18_800_000n, "retry fee above the fresh base fee");
    assert.ok(levels.includes("warn"), "the rejected attempt is logged");
    assert.ok(!levels.includes("error"), "a recovered send logs no error");
    assert.equal(mocks.cancelCalls.length, 0);
  });

  it("resetNonce() forces a fresh chain read on the next submit", async () => {
    let counts = 0;
    const mocks = makeMocks({ startNonce: 0, receiptFor: async () => RECEIPT });
    mocks.publicClient.getTransactionCount = async () => {
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

/**
 * N11: a tx mined after the confirmation timeout made its same-nonce replacement fail
 * "nonce too low", which read as another party spending the nonce, so the same calldata
 * was broadcast again at the next nonce and the update could land twice.
 */
describe("N11 — a late receipt is not sent again", () => {
  it("returns the original tx when its replacement finds the nonce spent", async () => {
    const mined = new Set<string>();
    const mocks = makeMocks({
      startNonce: 7,
      // Only the original's receipt arrives after the confirmation timeout.
      receiptFor: (hash) =>
        new Promise((resolve) =>
          setTimeout(
            () => {
              mined.add(hash);
              resolve(RECEIPT);
            },
            hash === "0xa" ? 40 : 0,
          ),
        ),
    });
    let reads = 0;
    mocks.publicClient.getTransactionCount = async () => (reads++ === 0 ? 7 : 8);
    mocks.publicClient.getTransactionReceipt = async ({ hash }) => {
      if (!mined.has(hash))
        throw new Error(
          `Transaction receipt with hash "${hash}" could not be found.`,
        );
      return { ...RECEIPT, status: "success" } as TransactionReceipt;
    };
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      { confirmationTimeoutMs: 20, maxReplacements: 2 },
      makeLogger(),
    );

    const attempts: number[] = [];
    const broadcast = async ({ nonce }: { nonce: number }) => {
      attempts.push(nonce);
      if (attempts.length === 1) return "0xa" as const;
      // The replacement goes out after the original was mined.
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (nonce === 7)
        throw new Error("nonce too low: next nonce 8, tx nonce 7");
      return "0xb" as const;
    };

    const outcome = await nm.submit(broadcast, {
      maxFeePerGas: 100n,
      label: "perps",
    });
    assert.equal(outcome.gasUsed, RECEIPT.gasUsed);
    assert.deepEqual(
      attempts,
      [7, 7],
      "the update must not be broadcast again at nonce 8",
    );
    assert.equal(mocks.cancelCalls.length, 0);
  });

  it("rejects when the tx lands reverted", async () => {
    const mocks = makeMocks({
      startNonce: 3,
      receiptFor: async () => ({ ...RECEIPT, status: "reverted" }),
    });
    const nm = new NonceManager(
      mocks.publicClient,
      mocks.walletClient,
      account,
      chain,
      {},
      makeLogger(),
    );

    await assert.rejects(
      nm.submit(() => Promise.resolve("0xr" as const), {
        maxFeePerGas: 1n,
        label: "futures",
      }),
      /reverted/,
    );
  });
});
