import type { Account, Chain, Hex, PublicClient, WalletClient } from "viem";
import type pino from "pino";

export interface NonceManagerConfig {
  /** How long to wait for a tx receipt before treating it as stuck. Default 60s. */
  confirmationTimeoutMs?: number;
  /** Max replacement-by-fee attempts before escalating to a cancel-tx. Default 2. */
  maxReplacements?: number;
  /** Fee bump per replacement attempt, in percent. Default 15%. */
  replacementFeeBumpPct?: number;
  /**
   * Max times, within a single submit, to re-read the chain nonce and retry when
   * a *third party* advanced the nonce out from under us (e.g. a keeper sharing
   * this wallet). Guards against the pathological "nonce too low" thrash when the
   * signer is not exclusively owned by this process. Default 5.
   *
   * NOTE: This is a resilience workaround for a shared signer. The correct fix is
   * a dedicated wallet per process — a single EOA nonce cannot be safely shared.
   */
  maxNonceResyncs?: number;
}

/** Broadcasts one logical tx at the given nonce/fee and returns its hash. */
export type Broadcast = (params: {
  nonce: number;
  maxFeePerGas: bigint;
}) => Promise<Hex>;

export interface TxOutcome {
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

interface MinedReceipt extends TxOutcome {
  status?: "success" | "reverted";
}

/**
 * Owns the shared wallet's nonce for a single-wallet, multi-venue process.
 *
 * All submissions are **serialized** through an internal queue so nonces are
 * assigned in a single deterministic order across venues — a perps tx and a
 * futures tx in the same cycle get consecutive nonces and never race.
 *
 * Stuck-tx recovery keeps one wedged venue tx from starving the other:
 *   1. Broadcast at nonce N; await the receipt with a timeout.
 *   2. On timeout, resubmit the **same nonce** with a bumped fee
 *      (replacement-by-fee — at most one of original/replacement can land, so
 *      this is safe even for non-idempotent creates).
 *   3. After `maxReplacements`, escalate to a `cancel-tx` (0-value self-send at
 *      nonce N with an aggressive fee) to free the nonce, then advance.
 *
 * A replacement rejected "nonce too low" may only mean an earlier broadcast at
 * N landed after its timeout, so the hashes already sent at N are checked
 * before the tx is treated as displaced and sent again at a fresh nonce.
 */
export class NonceManager {
  private next: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private readonly confirmationTimeoutMs: number;
  private readonly maxReplacements: number;
  private readonly bumpPct: number;
  private readonly maxNonceResyncs: number;

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;
  private readonly chain: Chain;
  private readonly logger: pino.Logger;

  constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    account: Account,
    chain: Chain,
    cfg: NonceManagerConfig,
    logger: pino.Logger,
  ) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.account = account;
    this.chain = chain;
    this.confirmationTimeoutMs = cfg.confirmationTimeoutMs ?? 60_000;
    this.maxReplacements = cfg.maxReplacements ?? 2;
    this.bumpPct = cfg.replacementFeeBumpPct ?? 15;
    this.maxNonceResyncs = cfg.maxNonceResyncs ?? 5;
    this.logger = logger.child({ component: "nonce" });
  }

  /**
   * Submit one logical tx. Resolves with the receipt's gas figures, or throws
   * if the tx could not be landed even after replacement + cancel escalation.
   * Serialized against every other in-flight `submit`.
   */
  submit(broadcast: Broadcast, opts: { maxFeePerGas: bigint; label: string }): Promise<TxOutcome> {
    return this.enqueue(() => this.submitInner(broadcast, opts));
  }

  /** Force a nonce re-read from chain on the next submit (after a desync). */
  resetNonce(): void {
    this.next = null;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive regardless of individual outcomes.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async nextNonce(): Promise<number> {
    if (this.next === null) {
      this.next = await this.publicClient.getTransactionCount({
        address: this.account.address,
        blockTag: "pending",
      });
    }
    return this.next;
  }

  private async submitInner(
    broadcast: Broadcast,
    opts: { maxFeePerGas: bigint; label: string },
  ): Promise<TxOutcome> {
    let nonce = await this.nextNonce();
    let fee = opts.maxFeePerGas;
    let resyncs = 0;
    /** Every hash broadcast at `nonce`; any of them may be the one that lands. */
    let sent: Hex[] = [];

    for (let attempt = 0; attempt <= this.maxReplacements; attempt++) {
      let receipt: MinedReceipt | null = null;
      try {
        const hash = await broadcast({ nonce, maxFeePerGas: fee });
        sent.push(hash);
        receipt = await this.waitWithTimeout(hash);
        if (!receipt) {
          // Timeout: bump fee and resubmit the same nonce.
          fee = this.bump(fee);
          this.logger.warn(
            { label: opts.label, nonce, attempt, maxFeePerGas: fee.toString() },
            "tx confirmation timed out; replacing by fee",
          );
          continue;
        }
      } catch (err) {
        if (isNonceDesyncError(err)) receipt = await this.landedReceipt(sent);
        // Not one of ours: a *third party* (e.g. a keeper sharing this wallet)
        // consumed the nonce. Fee-bumping or cancelling a spent nonce is pointless
        // and only burns gas, so re-read the live nonce and retry at the fresh value.
        if (!receipt && isNonceDesyncError(err)) {
          // Exhausted the resync budget: the nonce is being taken faster than we
          // can claim it. A spent nonce cannot be replaced or cancelled, so skip
          // the fee-bump/cancel escalation entirely and surface the failure now —
          // the next poll tick retries with a freshly re-read nonce.
          if (resyncs >= this.maxNonceResyncs) {
            this.resetNonce();
            this.logger.error(
              { err, label: opts.label, nonce, resyncs },
              "nonce repeatedly advanced by another party; giving up this cycle",
            );
            throw err instanceof Error ? err : new Error(String(err));
          }
          resyncs++;
          this.resetNonce();
          const fresh = await this.nextNonce();
          this.logger.warn(
            { label: opts.label, staleNonce: nonce, freshNonce: fresh, resyncs },
            "nonce advanced by another party; resyncing to chain",
          );
          nonce = fresh;
          sent = [];
          fee = opts.maxFeePerGas; // fresh nonce starts from the base fee again
          attempt = -1; // ...becomes 0 after the loop increment: full retry budget
          continue;
        }
        if (!receipt) {
          // A submission error (revert-on-send, RPC error). Fee-bump-and-retry a
          // couple of times; a persistent failure likely means the nonce is
          // wedged, so unstick it below. A warning only: the caller logs the error
          // if the send does not recover.
          this.logger.warn(
            { err, label: opts.label, nonce, attempt },
            "tx submission failed",
          );
          if (attempt >= this.maxReplacements) {
            await this.tryCancelTx(nonce, fee);
            this.next = nonce + 1;
            this.resetNonce(); // resync from chain next time in case of desync
            throw err instanceof Error ? err : new Error(String(err));
          }
          fee = this.bump(fee);
          if (isFeeCapTooLowError(err)) fee = await this.aboveBaseFee(fee);
          continue;
        }
      }

      this.next = nonce + 1;
      if (receipt.status === "reverted") {
        throw new Error(`tx "${opts.label}" reverted at nonce ${nonce}`);
      }
      return {
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
      };
    }

    // Exhausted replacements on repeated timeout: free the nonce and advance.
    await this.tryCancelTx(nonce, fee);
    this.next = nonce + 1;
    throw new Error(
      `tx "${opts.label}" stuck at nonce ${nonce} after ${this.maxReplacements} replacements`,
    );
  }

  private bump(fee: bigint): bigint {
    return (fee * BigInt(100 + this.bumpPct)) / 100n;
  }

  /** At least twice the latest base fee, which can outrun a fee bump within seconds. */
  private async aboveBaseFee(fee: bigint): Promise<bigint> {
    try {
      const { baseFeePerGas } = await this.publicClient.getBlock({ blockTag: "latest" });
      const floor = (baseFeePerGas ?? 0n) * 2n;
      return fee > floor ? fee : floor;
    } catch {
      return fee;
    }
  }

  private async waitWithTimeout(hash: Hex): Promise<MinedReceipt | null> {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), this.confirmationTimeoutMs),
    );
    const receipt = this.publicClient
      .waitForTransactionReceipt({ hash })
      .then(minedReceipt)
      .catch(() => null);
    return Promise.race([receipt, timeout]);
  }

  /** The receipt of whichever of `hashes` was mined, or null if none was. */
  private async landedReceipt(hashes: readonly Hex[]): Promise<MinedReceipt | null> {
    for (const hash of hashes) {
      try {
        return minedReceipt(await this.publicClient.getTransactionReceipt({ hash }));
      } catch {
        // Not mined (or not visible yet): try the next hash.
      }
    }
    return null;
  }

  /**
   * Replace a stuck tx with a 0-value self-send at the same nonce to free it.
   * Best-effort: logged and swallowed on failure (the caller advances anyway).
   */
  private async tryCancelTx(nonce: number, fee: bigint): Promise<void> {
    try {
      const aggressive = this.bump(fee);
      const hash = await this.walletClient.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: this.account.address,
        value: 0n,
        nonce,
        maxFeePerGas: aggressive,
        maxPriorityFeePerGas: aggressive,
      });
      await this.waitWithTimeout(hash);
      this.logger.warn({ nonce, hash }, "sent cancel-tx to unstick nonce");
    } catch (err) {
      this.logger.error({ err, nonce }, "cancel-tx failed; will resync nonce");
    }
  }
}

function minedReceipt(r: MinedReceipt): MinedReceipt {
  return { gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, status: r.status };
}

/**
 * Substrings that mean the nonce we used no longer matches the chain and we must
 * move to a *fresh* nonce (someone else advanced this wallet's nonce, or we left
 * a gap). Deliberately EXCLUDES same-nonce replacement signals like "replacement
 * transaction underpriced" and "already known": those mean we still own the nonce
 * and should keep it while bumping the fee, so they fall through to the RBF path.
 */
const NONCE_DESYNC_PATTERNS = [
  "nonce too low",
  "lower than the current nonce",
  "nonce too high",
  "nonce has already been used",
  "invalid nonce",
  "oldnonce",
  "noncetoolow",
  "noncetoohigh",
] as const;

/** viem's `FeeCapTooLowError` and the raw RPC rejection of a fee cap below the base fee. */
const FEE_CAP_TOO_LOW_PATTERNS = [
  "feecaptoolowerror",
  "cannot be lower than the block base fee",
  "max fee per gas less than block base fee",
] as const;

/**
 * True when `err` (or anything in its `cause` chain) means the nonce we used is
 * stale relative to the chain — i.e. the tx needs a *new* nonce, not a fee bump.
 * Matches viem's `NonceTooLowError`/`NonceTooHighError` and raw RPC messages.
 *
 * Returns false for replacement-underpriced / already-known errors: those keep
 * the same nonce and are handled by the fee-bump replacement path.
 */
export function isNonceDesyncError(err: unknown): boolean {
  return errorChainMatches(err, NONCE_DESYNC_PATTERNS);
}

export function isFeeCapTooLowError(err: unknown): boolean {
  return errorChainMatches(err, FEE_CAP_TOO_LOW_PATTERNS);
}

function errorChainMatches(err: unknown, patterns: readonly string[]): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as {
      name?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    const haystack = [e.name, e.message, e.shortMessage, e.details]
      .filter((v): v is string => typeof v === "string")
      .join(" | ")
      .toLowerCase();
    if (patterns.some((p) => haystack.includes(p))) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}
