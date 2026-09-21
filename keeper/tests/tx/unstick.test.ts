import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address, Hex } from "viem";
import {
  unstickPendingNonces,
  withUnstickRetry,
  isReplacementUnderpriced,
} from "../../src/tx/unstick.ts";
import type { Chain } from "../../src/chain.ts";

const SIGNER: Address = "0x000000000000000000000000000000000000A157";

const silentLogger = pino({ level: "silent" });

interface ChainStubOpts {
  /** Sequence of `getTransactionCount` answers per blockTag. Cycled if exhausted. */
  latestNonces?: number[];
  pendingNonces?: number[];
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** Per-call hook for sendTransaction; throws to simulate RPC errors. */
  onSendTransaction?: (req: unknown, callIdx: number) => Promise<Hex>;
}

interface RecordedSend {
  nonce: number;
  to: Address;
  value: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

function makeChain(opts: ChainStubOpts = {}) {
  const sends: RecordedSend[] = [];
  const txCountCalls: Array<"latest" | "pending"> = [];
  let latestIdx = 0;
  let pendingIdx = 0;
  const latestSeq = opts.latestNonces ?? [10];
  const pendingSeq = opts.pendingNonces ?? [10];
  let sendIdx = 0;

  const chain = {
    account: { address: SIGNER },
    publicClient: {
      getTransactionCount: async ({ blockTag }: { blockTag: "latest" | "pending" }) => {
        txCountCalls.push(blockTag);
        if (blockTag === "latest") {
          const v = latestSeq[Math.min(latestIdx, latestSeq.length - 1)] as number;
          latestIdx++;
          return v;
        }
        const v = pendingSeq[Math.min(pendingIdx, pendingSeq.length - 1)] as number;
        pendingIdx++;
        return v;
      },
      estimateFeesPerGas: async () =>
        opts.fees ?? {
          maxFeePerGas: 1_000_000_000n, // 1 gwei
          maxPriorityFeePerGas: 100_000_000n, // 0.1 gwei
        },
    },
    walletClient: {
      chain: null,
      sendTransaction: async (req: {
        nonce: number;
        to: Address;
        value: bigint;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }) => {
        const idx = sendIdx++;
        if (opts.onSendTransaction !== undefined) return opts.onSendTransaction(req, idx);
        sends.push({
          nonce: req.nonce,
          to: req.to,
          value: req.value,
          maxFeePerGas: req.maxFeePerGas,
          maxPriorityFeePerGas: req.maxPriorityFeePerGas,
        });
        return ("0x" + idx.toString(16).padStart(64, "0")) as Hex;
      },
    },
  } as unknown as Chain;

  return { chain, sends, txCountCalls };
}

describe("isReplacementUnderpriced", () => {
  it("matches the exact error string viem surfaces from Alchemy / Geth", () => {
    const err = new Error("Some wrapper text\nreplacement transaction underpriced");
    assert.equal(isReplacementUnderpriced(err), true);
  });

  it("matches the bare 'transaction underpriced' variant from non-replacement cases", () => {
    const err = new Error("transaction underpriced (gas tip too low)");
    assert.equal(isReplacementUnderpriced(err), true);
  });

  it("matches errors that surface the cause via viem's `details` field", () => {
    // Viem's ContractFunctionExecutionError flattens the RPC error body
    // into a `details` property; the top-level `message` may not contain
    // the underpriced string at all.
    const err = Object.assign(new Error("ContractFunctionExecutionError"), {
      details: "replacement transaction underpriced",
    });
    assert.equal(isReplacementUnderpriced(err), true);
  });

  it("does not match unrelated errors", () => {
    assert.equal(isReplacementUnderpriced(new Error("nonce too low")), false);
    assert.equal(isReplacementUnderpriced(new Error("insufficient funds for gas")), false);
    assert.equal(isReplacementUnderpriced("not even an Error"), false);
    assert.equal(isReplacementUnderpriced(undefined), false);
  });
});

describe("unstickPendingNonces", () => {
  it("is a no-op when pending == latest (nothing stuck)", async () => {
    const { chain, sends } = makeChain({ latestNonces: [42], pendingNonces: [42] });
    const cancelled = await unstickPendingNonces(chain, silentLogger);
    assert.equal(cancelled, 0);
    assert.equal(sends.length, 0, "no cancellation broadcasts when mempool is clear");
  });

  it("cancels every nonce in [latest, pending) with a 3x-bumped self-transfer", async () => {
    // 3 stuck nonces (latest=10, pending=13) → 3 cancellations.
    // After we send the cancels, the polling loop reads latest again
    // and sees it caught up to pending — exits cleanly.
    const { chain, sends } = makeChain({
      latestNonces: [10, 13],
      pendingNonces: [13],
      fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 200_000_000n },
    });
    const cancelled = await unstickPendingNonces(chain, silentLogger);
    assert.equal(cancelled, 3);
    assert.deepEqual(
      sends.map((s) => s.nonce),
      [10, 11, 12],
      "covers every stuck nonce in order",
    );
    // Each cancel is a 0-value self-transfer at 3x the estimated fees.
    // Locking in the multiplier here so a future tweak from 3x → 1.5x
    // can't regress without breaking the test (mempools that demand
    // big bumps to evict have bitten us before).
    for (const s of sends) {
      assert.equal(s.to, SIGNER);
      assert.equal(s.value, 0n);
      assert.equal(s.maxFeePerGas, 6_000_000_000n);
      assert.equal(s.maxPriorityFeePerGas, 600_000_000n);
    }
  });

  it("skips nonces that already cleared (`nonce too low`) without aborting the rest", async () => {
    // Race: between our pending-count read and our cancel send, the
    // first stuck tx mined on its own. The cancel for that nonce now
    // gets `nonce too low` from the node — we must skip it and keep
    // cancelling the others, not bail out.
    const sends: RecordedSend[] = [];
    const { chain } = makeChain({
      latestNonces: [10, 13],
      pendingNonces: [13],
      onSendTransaction: async (req, idx) => {
        if (idx === 0) throw new Error("nonce too low");
        const r = req as RecordedSend;
        sends.push({
          nonce: r.nonce,
          to: r.to,
          value: r.value,
          maxFeePerGas: r.maxFeePerGas,
          maxPriorityFeePerGas: r.maxPriorityFeePerGas,
        });
        return ("0x" + idx.toString(16).padStart(64, "0")) as Hex;
      },
    });
    // No exception, no abort — successful cancels still recorded.
    const cancelled = await unstickPendingNonces(chain, silentLogger);
    // First send returned an error so wasn't recorded into `sends`,
    // but the loop kept going for nonces 11 and 12.
    assert.equal(cancelled, 2);
    assert.deepEqual(
      sends.map((s) => s.nonce),
      [11, 12],
    );
  });

  it("refuses to cancel more than the safety cap to defend against a misreporting RPC", async () => {
    // 33 stuck > 32 cap → throw. Without this guard, a buggy provider
    // claiming "you have 100M pending txs" would drain the wallet on
    // 21k-gas cancellations.
    const { chain, sends } = makeChain({
      latestNonces: [0],
      pendingNonces: [33],
    });
    await assert.rejects(
      () => unstickPendingNonces(chain, silentLogger),
      /refusing to process 33 stuck nonces/,
    );
    assert.equal(sends.length, 0, "must not broadcast anything when the cap is exceeded");
  });

  it("uses pending blockTag when reading the upper nonce bound, not just latest", async () => {
    // Important RPC contract assertion: latest=N, pending=N+K. If we
    // accidentally read both as latest we'd never cancel anything.
    const { chain, txCountCalls } = makeChain({
      latestNonces: [5, 7],
      pendingNonces: [7],
    });
    await unstickPendingNonces(chain, silentLogger);
    assert.ok(txCountCalls.includes("pending"), "must query pending blockTag");
    assert.ok(txCountCalls.includes("latest"), "must query latest blockTag");
  });
});

describe("withUnstickRetry", () => {
  it("returns the write result directly when no error occurs", async () => {
    const { chain } = makeChain();
    let called = 0;
    const out = await withUnstickRetry(chain, silentLogger, async () => {
      called++;
      return "0xabc" as Hex;
    });
    assert.equal(out, "0xabc");
    assert.equal(called, 1, "no retry when first attempt succeeds");
  });

  it("propagates errors that are not `replacement transaction underpriced` without retrying", async () => {
    // Permanent errors (insufficient funds, ABI mismatch, signature
    // mismatch) must not be papered over with an unstick — that would
    // silently drain gas on every sweep.
    const { chain } = makeChain();
    let called = 0;
    await assert.rejects(
      () =>
        withUnstickRetry(chain, silentLogger, async () => {
          called++;
          throw new Error("insufficient funds for gas");
        }),
      /insufficient funds/,
    );
    assert.equal(called, 1, "no retry for non-recoverable errors");
  });

  it("on `replacement transaction underpriced` runs unstick then retries the write exactly once", async () => {
    // First attempt throws the underpriced error → triggers unstick →
    // second attempt is the retry (here it succeeds). The whole point
    // of the helper is to make this happen invisibly to callers.
    const { chain, sends } = makeChain({
      latestNonces: [5, 8],
      pendingNonces: [8],
    });
    let writeAttempts = 0;
    const out = await withUnstickRetry(chain, silentLogger, async () => {
      writeAttempts++;
      if (writeAttempts === 1) throw new Error("replacement transaction underpriced");
      return "0xdeadbeef" as Hex;
    });
    assert.equal(out, "0xdeadbeef");
    assert.equal(writeAttempts, 2, "exactly one retry");
    assert.equal(sends.length, 3, "unstick cancelled all 3 pending nonces between attempts");
  });

  it("does not retry more than once — a second underpriced error surfaces", async () => {
    // If unstick + 1 retry didn't fix it, something structural is
    // wrong (RPC reporting bad nonces, another writer using the same
    // key from outside the keeper). We must NOT loop forever — let
    // the caller see the error so the next sweep can decide what to
    // do, or so the operator gets a visible signal.
    const { chain } = makeChain({ latestNonces: [5, 5], pendingNonces: [5] });
    let writeAttempts = 0;
    await assert.rejects(
      () =>
        withUnstickRetry(chain, silentLogger, async () => {
          writeAttempts++;
          throw new Error("replacement transaction underpriced");
        }),
      /replacement transaction underpriced/,
    );
    assert.equal(writeAttempts, 2, "exactly two attempts (initial + one retry), no infinite loop");
  });
});
