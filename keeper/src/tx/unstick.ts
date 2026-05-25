import type pino from "pino";
import type { Hex } from "viem";
import type { Chain } from "../chain.ts";

/**
 * Recovery for `replacement transaction underpriced`.
 *
 * Scenario this fixes (the only one we've actually seen in production):
 *
 *   1. Keeper broadcasts tx at nonce N. The RPC accepts it into the
 *      mempool but the receipt poll times out (ours, viem's, or the
 *      RPC provider's) before we hear back.
 *   2. Process restarts (deploy, crash, `pnpm dev` reload). The new
 *      run reads `getTransactionCount` which the provider answers from
 *      `latest` blockTag → returns N (the stuck tx hasn't mined yet).
 *   3. New run tries to send its first tx at nonce N. Mempool already
 *      has one there → rejects with `replacement transaction
 *      underpriced` (gas was equal, not strictly higher).
 *
 * Without intervention this loops forever — every sweep retries with
 * the same gas, every retry hits the same revert. The user has to
 * manually unstick the wallet (cast a high-gas self-transfer).
 *
 * `unstickPendingNonces` automates that recovery: it walks every nonce
 * in `[latest, pending)` and submits a 0-value self-transfer at
 * aggressively-bumped gas (3× current EIP-1559 fees). Each self-transfer
 * either:
 *   - replaces the stuck tx by using the same nonce + higher gas
 *     (mempool drops the original, mines our cancel instead), or
 *   - races the stuck tx to inclusion (whichever lands first wins; our
 *     subsequent retry handles "nonce too low" the same way it handles
 *     a successful unstick — by moving to the next pending nonce).
 *
 * Self-transfers cost 21k gas × bumped price each — at base-sepolia
 * defaults that's a fraction of a cent per stuck nonce. Bounded loop
 * with a hard cap on the number of nonces we'll cancel in one go, so a
 * misreporting RPC can't drain the wallet by claiming millions of
 * pending txs.
 */
const MAX_NONCES_PER_UNSTICK = 32;

/**
 * Multiplier applied to current `maxFeePerGas` / `maxPriorityFeePerGas`.
 * EIP-1559 / geth requires both to be ≥ 110% of the replaced tx for the
 * mempool to accept the swap. We go to 300% so we don't have to reason
 * about whether the stuck tx was already at our previous estimate or
 * something higher (manual `cast send`, prior unstick attempt, etc).
 */
const GAS_BUMP_MULTIPLIER = 3n;

/**
 * Walks pending nonces and submits high-gas cancellations until the
 * mempool agrees `pending == latest`. Returns the number of cancellations
 * actually broadcast (0 means there was nothing stuck — the original
 * `replacement underpriced` was a transient state, retry will succeed).
 *
 * Throws only on RPC failures during the unstick itself (e.g. the
 * provider is unreachable). Per-nonce errors during the cancellation
 * loop are logged and skipped — `nonce too low` is expected when the
 * stuck tx clears between our pending-count read and our cancel send.
 */
export async function unstickPendingNonces(
  chain: Chain,
  logger: pino.Logger,
): Promise<number> {
  const address = chain.account.address;
  const [latestNonce, pendingNonce] = await Promise.all([
    chain.publicClient.getTransactionCount({ address, blockTag: "latest" }),
    chain.publicClient.getTransactionCount({ address, blockTag: "pending" }),
  ]);

  if (pendingNonce <= latestNonce) {
    logger.info(
      { address, latestNonce, pendingNonce },
      "unstick: no pending txs in mempool — nothing to cancel",
    );
    return 0;
  }

  const stuckCount = pendingNonce - latestNonce;
  if (stuckCount > MAX_NONCES_PER_UNSTICK) {
    // Defensive cap. Either the provider is reporting nonsense or
    // someone has been hammering the wallet from outside the keeper.
    // Log loud and refuse to cancel hundreds of nonces in one shot.
    logger.error(
      { address, latestNonce, pendingNonce, stuckCount, cap: MAX_NONCES_PER_UNSTICK },
      "unstick: refusing to cancel more than the configured cap — investigate manually before retrying",
    );
    throw new Error(
      `unstick refusing to process ${stuckCount} stuck nonces (cap ${MAX_NONCES_PER_UNSTICK})`,
    );
  }

  // Estimate current network fees once. We use the same bumped rate
  // for every cancellation in this batch — they all need to win against
  // the same mempool snapshot, and re-estimating per-iteration would
  // race a mining mempool.
  const fees = await chain.publicClient.estimateFeesPerGas();
  const bumpedMaxFee = fees.maxFeePerGas * GAS_BUMP_MULTIPLIER;
  const bumpedTip = fees.maxPriorityFeePerGas * GAS_BUMP_MULTIPLIER;

  logger.warn(
    {
      address,
      latestNonce,
      pendingNonce,
      stuckCount,
      bumpedMaxFee: bumpedMaxFee.toString(),
      bumpedTip: bumpedTip.toString(),
    },
    "unstick: cancelling stuck mempool txs to clear the way for the next broadcast",
  );

  let cancelled = 0;
  for (let nonce = latestNonce; nonce < pendingNonce; nonce++) {
    try {
      // 0-value self-transfer: 21k gas, never reverts, evicts the
      // stuck tx at this nonce by replacing it with a properly-priced
      // one. We don't wait for the receipt of EACH cancel before
      // sending the next — they're independent nonces, the mempool
      // accepts them in parallel, and we only need to await the LAST
      // one to know the wallet is clear.
      const hash = await chain.walletClient.sendTransaction({
        account: chain.account,
        chain: chain.walletClient.chain ?? null,
        to: address,
        value: 0n,
        nonce,
        maxFeePerGas: bumpedMaxFee,
        maxPriorityFeePerGas: bumpedTip,
      });
      logger.info({ nonce, hash }, "unstick: cancellation broadcast");
      cancelled++;
    } catch (err) {
      // `nonce too low` here means the stuck tx mined between our
      // pending-count read and our cancel send. That's a happy path
      // — the slot is free, no cancellation needed. Anything else
      // (rate limit, malformed) we log and keep going so one bad
      // nonce doesn't block the rest.
      const message = err instanceof Error ? err.message.toLowerCase() : "";
      if (message.includes("nonce too low") || message.includes("already known")) {
        logger.info({ nonce, err: message }, "unstick: nonce already cleared, skipping");
        continue;
      }
      logger.warn({ nonce, err }, "unstick: cancellation send failed — continuing with next nonce");
    }
  }

  // Wait for the highest-nonce cancellation to confirm. Once that's
  // mined, all lower-nonce cancellations are guaranteed mined too
  // (nonce ordering), so a single waitForTransactionReceipt drains
  // the entire batch. We don't have the hash readily here, so we
  // poll the on-chain nonce count until it catches up.
  await waitForNonceToClear(chain, logger, pendingNonce);
  return cancelled;
}

/**
 * Polls `getTransactionCount({blockTag: "latest"})` until it reaches
 * `targetNonce`, indicating every pending tx has either mined or been
 * cancelled. Bounded by `timeoutMs` so a stalled mempool can't hang
 * the calling sweep indefinitely.
 */
async function waitForNonceToClear(
  chain: Chain,
  logger: pino.Logger,
  targetNonce: number,
  timeoutMs = 60_000,
  pollMs = 2_000,
): Promise<void> {
  const address = chain.account.address;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await chain.publicClient.getTransactionCount({
      address,
      blockTag: "latest",
    });
    if (current >= targetNonce) {
      logger.info({ address, latestNonce: current }, "unstick: mempool drained");
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  logger.warn(
    { address, targetNonce, timeoutMs },
    "unstick: timeout waiting for mempool to drain — proceeding anyway, retry may still hit replacement-underpriced",
  );
}

/**
 * Wraps a write that may fail with `replacement transaction underpriced`.
 * On that specific error, runs `unstickPendingNonces` and retries the
 * write exactly once. Any other error (including a second
 * `replacement-underpriced` after unstick) propagates.
 *
 * Use this for any write that talks to the keeper's shared signer.
 * Safe to nest because the inner write is wrapped in the same recovery
 * — the second attempt either succeeds or surfaces the underlying
 * problem (e.g. funds, gas estimation) without infinite recursion.
 */
export async function withUnstickRetry<T>(
  chain: Chain,
  logger: pino.Logger,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!isReplacementUnderpriced(err)) throw err;
    logger.warn(
      { err },
      "withUnstickRetry: hit `replacement transaction underpriced` — running unstick before retrying",
    );
    await unstickPendingNonces(chain, logger);
    // Single retry. If the second attempt also hits replacement-
    // underpriced, something is structurally wrong (RPC reporting bad
    // nonces, another writer hammering the same key) — let it surface
    // rather than masking with infinite retries.
    return await write();
  }
}

/**
 * Identifies the specific viem / RPC error shape that means "your
 * intended nonce is already pending in the mempool". Match by message
 * substring because the error code (-32000) is shared across many
 * provider-side rejections and viem does not give us a stable
 * discriminator.
 */
export function isReplacementUnderpriced(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const haystack = `${err.message ?? ""} ${(err as { details?: string }).details ?? ""} ${
    (err as { shortMessage?: string }).shortMessage ?? ""
  }`.toLowerCase();
  return (
    haystack.includes("replacement transaction underpriced") ||
    haystack.includes("transaction underpriced")
  );
}
