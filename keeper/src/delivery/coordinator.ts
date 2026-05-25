import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { withUnstickRetry } from "../tx/unstick.ts";
import type pino from "pino";
import { FuturesAbi } from "futures-marketplace/Futures.ts";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
import { formatGasCost } from "../tx/gasCost.ts";

/**
 * Optional keeper module that calls `Futures.closeDelivery(positionId, blameSeller)`
 * on every active futures position the moment its `deliveryAt` is reached.
 * Settlement happens at the *current* market price for the full delivery
 * window (positionElapsedTime = 0 → the entire position cash-settles at
 * `getMarketPrice()`), avoiding the need for any physical hashrate delivery.
 *
 * Authorization: `closeDelivery` is gated by either
 *   1. `_msgSender() == validatorAddress`  (this module's path), or
 *   2. `_msgSender() == position.{buyer,seller}`
 *
 * The keeper's signer must therefore equal the Futures contract's
 * `validatorAddress` for this module to do anything. If it doesn't, every
 * settlement attempt simulates as `OnlyValidatorOrPositionParticipant` and
 * the module logs the skip without crashing — useful in dev / dry-run setups.
 *
 * Hot path is event-driven:
 *
 *   PositionCreated  ─▶  schedule one-shot timer at deliveryAt + settleDelay
 *   PositionClosed   ─▶  cancel the timer + drop from index
 *   timer fires      ─▶  settle(positionId)
 *
 * Cold-start safety net (two redundant paths — either alone is sufficient):
 *
 *   bootstrapFromUsers(addrs) ─▶ for each address, read `getPositionIds(user)`
 *                                and `getPositionById(id)` via multicall, then
 *                                index whatever positions are still alive
 *                                on-chain. View-only — works on any RPC,
 *                                including providers that rate-limit
 *                                `eth_getLogs` (Alchemy free tier caps at
 *                                10 blocks, which makes log backfill
 *                                impractical for any non-trivial range).
 *                                This is the recommended primary path and
 *                                is wired automatically in `index.ts` from
 *                                `tracker.onAdded` and once at boot from
 *                                `tracker.list()`.
 *   backfill(fromBlock)       ─▶ replay PositionCreated/PositionClosed in
 *                                chunks. Discovers positions even for
 *                                participants the tracker doesn't know
 *                                about, but breaks on rate-limited
 *                                providers — keep `BACKFILL_FROM_BLOCK`
 *                                small or unset on Alchemy free.
 *   sweep()                   ─▶ every `sweepIntervalMs`, scan tracked
 *                                positions for any in
 *                                `[deliveryAt, deliveryAt + duration]` that
 *                                haven't been settled — covers dropped
 *                                events, timer drift, post-restart recovery,
 *                                and oracle-staleness retries.
 *
 * Single source of truth for "is this position alive": the contract emits
 * `PositionClosed` at the end of every `_removePosition`, including the
 * cash-settlement path inside `closeDelivery` itself. The module never has
 * to track its own settled-set across restarts — once settled, the contract
 * removes the position and `getPositionById(id).seller == 0` permanently.
 */
export class DeliveryCoordinator {
  /** Active positions known to the module: positionId → metadata. */
  private readonly tracked = new Map<Hex, TrackedPosition>();
  /** One-shot timers keyed by positionId. Cleared on settle / close / stop. */
  private readonly timers = new Map<Hex, NodeJS.Timeout>();
  /** Set of positions with an in-flight `settle()` — coalesces duplicate triggers. */
  private readonly inflight = new Set<Hex>();
  /**
   * Per-revert "we've already warned about this once" set so persistent
   * operational misconfigs (wrong validator key, missed delivery window)
   * surface loudly on first hit but don't flood the log on every sweep.
   * Keyed by `<revert>:<positionId>` so each position warns once per type
   * per process — clears nothing across restarts, which is what we want.
   */
  private readonly warned = new Set<string>();
  /**
   * Serialized broadcast chain: every `attemptSettle` awaits the previous
   * one before sending its own tx. The keeper has a single signer, so two
   * concurrent `writeContract` calls would race on the same nonce and one
   * would revert. Sweeps fire many candidates in parallel (e.g. multiple
   * positions sharing one `deliveryAt`); without this, the second-onward
   * txs would be rejected by the node.
   */
  private txChain: Promise<void> = Promise.resolve();
  /** Disposers returned by `watchContractEvent`. */
  private unwatchers: Array<() => void> = [];
  private sweepTimer: NodeJS.Timeout | undefined;
  /** Cached `deliveryDurationDays` (read once at start). */
  private deliveryDurationSeconds: bigint | undefined;
  private running = false;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly ethUsdFeed: EthUsdFeed | undefined;

  constructor(
    chain: Chain,
    config: Config,
    logger: pino.Logger,
    ethUsdFeed?: EthUsdFeed,
  ) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ component: "deliveryCoordinator" });
    // Optional — see FuturesVenue for the rationale. Used only to enrich
    // the two confirmed-tx logs (batched `multicall` and single
    // `closeDelivery`) with a `gasCostUsd` field.
    this.ethUsdFeed = ethUsdFeed;
  }

  /**
   * Subscribes to `PositionCreated` / `PositionClosed`, primes the duration
   * cache, and starts the periodic safety-net sweep. Idempotent.
   *
   * Backfill is the caller's responsibility (via `backfill(fromBlock)`) so
   * the runtime can sequence it after live subscriptions are wired — same
   * pattern as `ParticipantTracker`.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const days = (await this.chain.publicClient.readContract({
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "deliveryDurationDays",
    })) as number;
    this.deliveryDurationSeconds = BigInt(days) * 86_400n;
    this.logger.info(
      { deliveryDurationDays: days, blameSeller: this.config.delivery.blameSeller },
      "delivery coordinator starting",
    );

    // Pre-flight: verify the keeper signer is actually authorised to call
    // `closeDelivery`. If not, every settle attempt will silently revert
    // `OnlyValidatorOrPositionParticipant` inside simulate, and the only
    // operator-visible signal is "no settlements happen" — easy to miss
    // until a user reports a stuck position. We fail fast instead: throw,
    // bubble up to `main().catch` → `process.exit(1)`. The orchestrator
    // (k8s, systemd, docker restart-policy) sees the crash, cycles the
    // pod, and standard infra alerting (CrashLoopBackOff, healthcheck
    // 503, sentry on-error) pages on-call without any keeper-specific
    // notification plumbing. A code restart is not required to recover —
    // just rotate `LIQUIDATOR_PRIVATE_KEY` to match
    // `Futures.validatorAddress()` (or unset `DELIVERY_KEEPER_ENABLED`)
    // and the next pod will start cleanly.
    await this.assertValidatorAuthorised();

    this.unwatchers.push(
      this.chain.publicClient.watchContractEvent({
        address: this.config.futures.address,
        abi: FuturesAbi,
        eventName: "PositionCreated",
        onLogs: (logs) => this.onPositionCreated(logs),
      }),
      this.chain.publicClient.watchContractEvent({
        address: this.config.futures.address,
        abi: FuturesAbi,
        eventName: "PositionClosed",
        onLogs: (logs) => this.onPositionClosed(logs),
      }),
    );

    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.config.delivery.sweepIntervalMs);
  }

  /** Tears down all subscriptions, timers, and the sweep loop. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();

    for (const u of this.unwatchers) {
      try {
        u();
      } catch (err) {
        this.logger.warn({ err }, "delivery: unwatcher threw — continuing shutdown");
      }
    }
    this.unwatchers = [];
  }

  /**
   * Reads `Futures.validatorAddress()` and compares it to the keeper's
   * signer. Throws when they don't match — caller (`start()`) propagates
   * the throw up to `main().catch` so the process exits non-zero.
   *
   * The check is mandatory because the alternative (silent skip on every
   * `closeDelivery` revert) is invisible to operators at the default
   * `info` log level. A crash makes the misconfiguration impossible to
   * miss: the orchestrator restart loop and healthcheck 503 are the
   * existing operator-alert path; we don't need a parallel notification
   * channel just for delivery.
   */
  private async assertValidatorAuthorised(): Promise<void> {
    const validator = (await this.chain.publicClient.readContract({
      address: this.config.futures.address,
      abi: FuturesAbi,
      functionName: "validatorAddress",
    })) as Address;
    const signer = this.chain.account.address;
    if (validator.toLowerCase() === signer.toLowerCase()) {
      this.logger.info(
        { signer, validator, futures: this.config.futures.address },
        "delivery: validator alignment OK",
      );
      return;
    }
    const message =
      "DELIVERY_KEEPER_ENABLED=true but the keeper signer is not the futures validator. " +
      `Futures.validatorAddress()=${validator} but LIQUIDATOR_PRIVATE_KEY → ${signer}. ` +
      "Either rotate LIQUIDATOR_PRIVATE_KEY to match the validator, or unset " +
      "DELIVERY_KEEPER_ENABLED. Refusing to start so this is impossible to miss.";
    this.logger.error(
      { signer, validator, futures: this.config.futures.address },
      message,
    );
    throw new Error(message);
  }

  /**
   * Replay `PositionCreated` and `PositionClosed` in `[fromBlock, head]` so
   * the in-memory index reflects every position the contract still considers
   * active. Closed positions cancel their `created` entry as the same scan
   * runs in chronological order — no second pass needed.
   *
   * After backfill, kicks one immediate sweep so any positions whose
   * `deliveryAt` has already passed get settled without waiting for the
   * sweep timer's first tick.
   */
  async backfill(fromBlock: bigint, chunkSize: bigint): Promise<void> {
    if (chunkSize <= 0n) {
      throw new Error(`delivery backfill chunkSize must be positive, got ${chunkSize}`);
    }
    const head = await this.chain.publicClient.getBlockNumber();
    if (fromBlock > head) {
      this.logger.warn(
        { fromBlock: fromBlock.toString(), head: head.toString() },
        "delivery backfill fromBlock > head — nothing to do",
      );
      return;
    }

    this.logger.info(
      {
        fromBlock: fromBlock.toString(),
        head: head.toString(),
        chunkSize: chunkSize.toString(),
      },
      "delivery backfill: starting",
    );

    // Single scan over both events per chunk so creates and closes interleave
    // in block order — a position created and then closed in the same chunk
    // never lingers in `tracked` after the chunk drains.
    let chunkErrors = 0;
    for (let start = fromBlock; start <= head; start += chunkSize) {
      const end = start + chunkSize - 1n > head ? head : start + chunkSize - 1n;
      try {
        const [created, closed] = await Promise.all([
          this.chain.publicClient.getContractEvents({
            address: this.config.futures.address,
            abi: FuturesAbi,
            eventName: "PositionCreated",
            fromBlock: start,
            toBlock: end,
          }),
          this.chain.publicClient.getContractEvents({
            address: this.config.futures.address,
            abi: FuturesAbi,
            eventName: "PositionClosed",
            fromBlock: start,
            toBlock: end,
          }),
        ]);
        this.onPositionCreated(created as unknown as readonly Log[]);
        this.onPositionClosed(closed as unknown as readonly Log[]);
      } catch (err) {
        chunkErrors++;
        this.logger.error(
          { err, from: start.toString(), to: end.toString() },
          "delivery backfill chunk failed",
        );
      }
    }

    this.logger.info(
      { tracked: this.tracked.size, head: head.toString(), chunkErrors },
      "delivery backfill: complete",
    );

    await this.sweep();
  }

  /**
   * View-based discovery: read every still-alive futures position belonging
   * to `users` and index them. Trailing `sweep()` settles anything past
   * `deliveryAt`. Robust against `eth_getLogs` rate-limit caps because it
   * never scans logs.
   *
   * Wired in `index.ts` from
   *   - `tracker.onAdded` (per-user, on every newly-discovered participant)
   *   - the boot sequence's `tracker.list()` (one batched pass after
   *     `tracker.backfill` finishes)
   * so any participant the tracker eventually discovers — by webhook, live
   * event, or backfill — also has their futures positions indexed.
   *
   * Two-stage multicall to keep the contract surface narrow: stage 1 reads
   * `getPositionIds(user)` for every user, stage 2 hydrates each id via
   * `getPositionById`. Closed positions (returned with `seller == address(0)`
   * by the `delete positions[id]` in `_removePosition`) are filtered out.
   */
  async bootstrapFromUsers(users: readonly Address[]): Promise<void> {
    if (users.length === 0) {
      this.logger.info(
        { users: 0, total: this.tracked.size },
        "delivery bootstrap: no users to scan (tracker found none and no DELIVERY_BOOTSTRAP_USERS provided)",
      );
      return;
    }

    const positionIdLists = (await this.chain.publicClient.multicall({
      contracts: users.map((u) => ({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getPositionIds" as const,
        args: [u] as const,
      })),
      allowFailure: false,
    })) as readonly (readonly Hex[])[];

    // `getPositionIds(user)` returns positions where the user is EITHER
    // buyer OR seller, so a single position with both participants
    // tracked (typical) shows up twice across the per-user calls. Dedup
    // so the operator-facing counter reflects distinct positions, not
    // raw entries — operators kept asking "why does positionsOnChain not
    // match tracked.size?" because they never see the same id twice on
    // a block explorer.
    const uniqueOnChain = new Set<Hex>();
    const allIds: Hex[] = [];
    for (const ids of positionIdLists) {
      for (const id of ids) {
        uniqueOnChain.add(id);
        if (this.tracked.has(id)) continue;
        allIds.push(id);
      }
    }

    let indexed = 0;
    if (allIds.length > 0) {
      indexed = await this.indexPositions(allIds);
    }

    // Operator-readable summary regardless of whether anything new was
    // indexed. The "total" / "pastDue" / "nextDueAt" tuple is the answer
    // to "is the delivery keeper actually doing anything?":
    //   - total=0          → wallet has nothing to settle (healthy idle)
    //   - pastDue>0        → next sweep tick attempts a multicall
    //   - pastDue=0 + ETA  → keeper is correctly waiting for the timer
    //                        at `nextDueAt` (no bug — settlement isn't
    //                        valid before deliveryAt on-chain)
    const pastDue = this.countPastDuePositions();
    const nextDueAt = this.findEarliestDeliveryAt();
    this.logger.info(
      {
        users: users.length,
        uniquePositionsOnChain: uniqueOnChain.size,
        indexed,
        total: this.tracked.size,
        pastDue,
        nextDueAt:
          nextDueAt !== undefined
            ? new Date(Number(nextDueAt) * 1000).toISOString()
            : null,
      },
      "delivery bootstrap: complete",
    );

    await this.sweep();
  }

  /** Count tracked positions whose deliveryAt is at or before chain head. */
  private countPastDuePositions(): number {
    // Approximate using wall-clock — within a block of chain time on
    // any production network, accurate enough for an operator-facing
    // summary. The actual sweep uses `block.timestamp` for correctness.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    let n = 0;
    for (const pos of this.tracked.values()) {
      if (nowSec >= pos.deliveryAt) n++;
    }
    return n;
  }

  /**
   * Earliest `deliveryAt` across all tracked positions. Returned to the
   * boot summary as "the next time the keeper expects to do work" so an
   * operator can sanity-check "all 5 positions are due in 3 days, that's
   * why nothing's happening" without having to hop to a block explorer.
   * `undefined` when there are no tracked positions.
   */
  private findEarliestDeliveryAt(): bigint | undefined {
    let earliest: bigint | undefined;
    for (const pos of this.tracked.values()) {
      if (earliest === undefined || pos.deliveryAt < earliest) earliest = pos.deliveryAt;
    }
    return earliest;
  }

  /**
   * Single-user variant of `bootstrapFromUsers` — exposed separately so
   * `tracker.onAdded` can wire it without paying the multicall overhead
   * for one user. Errors are caught and logged: the listener path must
   * never throw into the tracker.
   */
  async indexUserPositions(user: Address): Promise<void> {
    let ids: readonly Hex[];
    try {
      ids = (await this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getPositionIds",
        args: [user],
      })) as readonly Hex[];
    } catch (err) {
      this.logger.error({ err, user }, "delivery: getPositionIds failed");
      return;
    }
    const fresh = ids.filter((id) => !this.tracked.has(id));
    if (fresh.length === 0) return;
    try {
      const indexed = await this.indexPositions(fresh);
      // INFO (not debug): operator-visible signal that the keeper
      // discovered a user's futures and is now responsible for settling
      // them. If you ever wonder "did the keeper see my new account?"
      // this is the line you grep for.
      if (indexed > 0) {
        this.logger.info(
          { user, indexed, total: this.tracked.size },
          "delivery: indexed user's futures positions",
        );
      }
    } catch (err) {
      this.logger.error({ err, user }, "delivery: indexPositions failed");
    }
  }

  /**
   * Internal: hydrate `ids` via multicalled `getPositionById` and upsert
   * the live ones (`seller != 0`) into the tracked map plus a per-position
   * timer. Returns the number of newly-indexed positions.
   */
  private async indexPositions(ids: readonly Hex[]): Promise<number> {
    const positions = (await this.chain.publicClient.multicall({
      contracts: ids.map((id) => ({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "getPositionById" as const,
        args: [id] as const,
      })),
      allowFailure: false,
    })) as readonly {
      seller: Address;
      buyer: Address;
      deliveryAt: bigint;
    }[];

    let added = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as Hex;
      const pos = positions[i] as { seller: Address; buyer: Address; deliveryAt: bigint };
      // `_removePosition` deletes the slot — `seller == 0` means already
      // closed/settled. Skip without touching state.
      if (pos.seller === zeroAddress) continue;
      if (this.tracked.has(id)) continue;
      const tracked: TrackedPosition = {
        positionId: id,
        deliveryAt: pos.deliveryAt,
        seller: pos.seller,
        buyer: pos.buyer,
      };
      this.tracked.set(id, tracked);
      this.scheduleTimer(tracked);
      added++;
    }
    return added;
  }

  /**
   * Scan all tracked positions; settle any whose `deliveryAt` is past and
   * whose settlement window has not yet expired. Skips positions with an
   * in-flight settle to avoid duplicate sends. Public for tests.
   *
   * Uses the chain's latest `block.timestamp` rather than `Date.now()` so
   * the sweep agrees with the contract's `_msgSender == validator` window
   * checks (`block.timestamp >= deliveryAt`, `block.timestamp <= deliveryAt
   * + duration`). On hardhat with `evm_setNextBlockTimestamp`, chain time
   * and wall-clock can diverge by years; in production they're within
   * one block of each other so this read is essentially free.
   */
  async sweep(): Promise<void> {
    const latestBlock = await this.chain.publicClient.getBlock();
    const nowSec = latestBlock.timestamp;
    const candidates: TrackedPosition[] = [];
    const window = this.deliveryDurationSeconds ?? 0n;

    for (const pos of this.tracked.values()) {
      if (this.inflight.has(pos.positionId)) continue;
      if (nowSec < pos.deliveryAt) continue;
      // After `deliveryAt + duration` the contract reverts `PositionDeliveryExpired`.
      // Skip — there's no entry point that can settle the position any more.
      if (window > 0n && nowSec > pos.deliveryAt + window) {
        this.logger.warn(
          {
            positionId: pos.positionId,
            deliveryAt: pos.deliveryAt.toString(),
            now: nowSec.toString(),
          },
          "delivery: settlement window expired — position abandoned",
        );
        this.tracked.delete(pos.positionId);
        const t = this.timers.get(pos.positionId);
        if (t !== undefined) {
          clearTimeout(t);
          this.timers.delete(pos.positionId);
        }
        continue;
      }
      candidates.push(pos);
    }

    if (candidates.length === 0) {
      // Visibility for "the sweep ran but found nothing" — at debug so
      // a healthy idle keeper isn't noisy in tails. Tracked-but-not-yet-
      // due counts in the message let an operator confirm the index is
      // populated even when no work is pending.
      this.logger.debug(
        { tracked: this.tracked.size, pendingFuture: this.tracked.size },
        "delivery sweep: nothing past-due",
      );
      return;
    }
    // INFO so an active sweep is visible in default-config tails. Sweeps
    // are bursty (most ticks find nothing, occasional ticks settle a
    // batch) so this won't flood logs.
    this.logger.info(
      { candidates: candidates.length, tracked: this.tracked.size },
      "delivery sweep: settling",
    );
    // Batch via `Futures.multicall(bytes[])` (OZ MulticallUpgradeable) so
    // every settlement in this sweep tick rides one transaction → one
    // nonce → no `replacement transaction underpriced` race against
    // concurrent manual sends or stale pending txs from a previous run.
    // We cap batch size to keep gas usage bounded; large sweeps spread
    // across multiple batches, each its own serial txChain entry.
    const ids = candidates.map((c) => c.positionId);
    const max = Math.max(1, this.config.delivery.maxBatchSize);
    for (let i = 0; i < ids.length; i += max) {
      const slice = ids.slice(i, i + max);
      try {
        await this.settleBatch(slice);
      } catch (err) {
        this.logger.error(
          { err, batchSize: slice.length },
          "delivery sweep: batch threw — continuing with next batch",
        );
      }
    }
  }

  /** Public for tests. Number of positions currently scheduled for settlement. */
  size(): number {
    return this.tracked.size;
  }

  /** Public for tests. Whether `positionId` is currently scheduled. */
  has(positionId: Hex): boolean {
    return this.tracked.has(positionId);
  }

  /**
   * Public for tests. Settles a single position via the batch path
   * (`settleBatch([id])`). Kept for tests and as a stable single-id entry
   * point — the actual broadcast still goes through `Futures.multicall`
   * with one entry, so the nonce / serialization model is identical to
   * multi-id sweeps.
   */
  async settle(positionId: Hex): Promise<void> {
    await this.settleBatch([positionId]);
  }

  /**
   * Bundles up to `maxBatchSize` `closeDelivery` calls into a single
   * `Futures.multicall(bytes[])` transaction. OZ `MulticallUpgradeable`
   * uses `delegatecall` per entry, so `msg.sender` is preserved and the
   * contract's `_msgSender == validator || _msgSender == participant`
   * auth check is satisfied identically to a direct call.
   *
   * Two-phase to keep one bad apple from spoiling the batch:
   *   1. Per-id `simulateContract` in parallel — drops candidates that
   *      would revert (already-settled, expired window, oracle stale, etc).
   *      Each revert is reported through the same severity taxonomy as
   *      individual settles, so an operator-actionable revert
   *      (`OnlyValidatorOrPositionParticipant`) still surfaces at error
   *      level even when discovered as part of a batch.
   *   2. One `multicall` write tx for the survivors. If the *write*
   *      reverts (rare — simulate-then-write race), we fall back to
   *      per-id `attemptSettle` so a single newly-poisoned id can't
   *      block the whole sweep tick.
   *
   * Serialized through `txChain` so two batches (e.g. two slices of a
   * sweep larger than `maxBatchSize`) ride sequential nonces. Per-id
   * `inflight` set still applies so a slow batch can't be re-queued
   * concurrently from a timer fire mid-sweep.
   */
  async settleBatch(positionIds: readonly Hex[]): Promise<void> {
    const fresh: Hex[] = [];
    for (const id of positionIds) {
      if (this.inflight.has(id)) continue;
      fresh.push(id);
      this.inflight.add(id);
    }
    if (fresh.length === 0) return;
    const next = this.txChain.then(() => this.attemptBatch(fresh));
    this.txChain = next.catch(() => undefined);
    try {
      await next;
    } finally {
      for (const id of fresh) this.inflight.delete(id);
    }
  }

  /**
   * Phase 1: simulate every candidate, classify outcomes, build the
   * settleable subset. Phase 2: one batched write or fall through to
   * per-id retries if the batch tx itself fails.
   */
  private async attemptBatch(positionIds: readonly Hex[]): Promise<void> {
    const blameSeller = this.config.delivery.blameSeller;

    type SimParams = Parameters<typeof this.chain.publicClient.simulateContract>[0];
    const simResults = await Promise.allSettled(
      positionIds.map((id) =>
        this.chain.publicClient.simulateContract({
          address: this.config.futures.address,
          abi: FuturesAbi,
          functionName: "closeDelivery",
          args: [id, blameSeller],
          account: this.chain.account,
        } as unknown as SimParams),
      ),
    );

    const settleable: Hex[] = [];
    for (let i = 0; i < positionIds.length; i++) {
      const id = positionIds[i] as Hex;
      const r = simResults[i] as PromiseSettledResult<unknown>;
      if (r.status === "fulfilled") {
        settleable.push(id);
        continue;
      }
      const decoded = decodeRecoverableRevert(r.reason);
      if (decoded !== undefined) {
        this.logRecoverableRevert(decoded, id, blameSeller);
        if (decoded === "PositionNotExists" || decoded === "PositionDeliveryExpired") {
          this.tracked.delete(id);
          const t = this.timers.get(id);
          if (t !== undefined) {
            clearTimeout(t);
            this.timers.delete(id);
          }
        }
        continue;
      }
      // Unknown revert — log error but don't kill the rest of the batch.
      this.logger.error(
        { err: r.reason, positionId: id },
        "delivery: simulate failed with non-recoverable error — skipping from batch",
      );
    }

    if (settleable.length === 0) {
      this.logger.debug(
        { batchSize: positionIds.length },
        "delivery batch: nothing to broadcast after simulate filter",
      );
      return;
    }

    if (this.config.keeper.dryRun) {
      this.logger.info(
        { batchSize: settleable.length },
        "[dryRun] would call Futures.multicall(closeDelivery × N)",
      );
      for (const id of settleable) this.tracked.delete(id);
      return;
    }

    // Encode each closeDelivery into bytes for OZ multicall(bytes[]).
    // Encoding can only fail on a malformed positionId (e.g. wrong
    // bytes32 width from a corrupted RPC read). We isolate that
    // per-position rather than letting one bad id swallow the whole
    // batch — same "one bad apple" guarantee we extend through simulate.
    const calldatas: Hex[] = [];
    const encodableIds: Hex[] = [];
    for (const id of settleable) {
      try {
        const data = encodeFunctionData({
          abi: FuturesAbi,
          functionName: "closeDelivery",
          args: [id, blameSeller],
        });
        calldatas.push(data);
        encodableIds.push(id);
      } catch (err) {
        this.logger.error(
          { err, positionId: id },
          "delivery: encodeFunctionData threw — dropping malformed id from batch",
        );
      }
    }
    if (calldatas.length === 0) return;

    type WriteParams = Parameters<typeof this.chain.walletClient.writeContract>[0];
    let hash: Hex;
    try {
      // `withUnstickRetry` is the auto-recovery for the most common
      // tx-submission failure on this signer: a stuck pending tx from
      // a previous keeper run (or a previous attempt that timed out
      // mid-broadcast). On `replacement transaction underpriced` it
      // walks the wallet's pending nonces, evicts each with a 0-value
      // self-transfer at 3× current gas, then retries our multicall
      // exactly once. Anything still wrong on retry surfaces normally.
      hash = await withUnstickRetry(this.chain, this.logger, () =>
        this.chain.walletClient.writeContract({
          address: this.config.futures.address,
          abi: FuturesAbi,
          functionName: "multicall",
          args: [calldatas],
          account: this.chain.account,
          chain: this.chain.walletClient.chain ?? null,
        } as unknown as WriteParams),
      );
    } catch (err) {
      // Tx-submission failures (nonce races, replacement underpriced,
      // mempool-full, transient RPC errors) are recoverable: the next
      // sweep will retry. We do NOT want to crash the keeper here —
      // unhandled rejection on a setTimeout-fired batch took the whole
      // process down in production.
      if (isTransientTxError(err)) {
        this.logger.warn(
          { err, batchSize: settleable.length },
          "delivery batch: tx submission failed transiently — sweep will retry",
        );
        return;
      }
      // Non-transient revert — could be one position turned bad between
      // simulate and write (state moved). Fall back to per-id attempts
      // so the others still settle on this sweep.
      this.logger.warn(
        { err, batchSize: encodableIds.length },
        "delivery batch: write reverted — falling back to per-position retries",
      );
      for (const id of encodableIds) {
        try {
          await this.attemptSettle(id);
        } catch (innerErr) {
          this.logger.error(
            { err: innerErr, positionId: id },
            "delivery: per-position fallback failed — leaving for next sweep",
          );
        }
      }
      return;
    }

    const receipt = await this.chain.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: this.config.coordinator.confirmationBlocks,
    });
    this.logger.info(
      {
        hash,
        blockNumber: receipt.blockNumber.toString(),
        batchSize: encodableIds.length,
        ...formatGasCost(receipt, this.ethUsdFeed),
      },
      "delivery batch: multicall confirmed",
    );

    for (const id of encodableIds) {
      this.tracked.delete(id);
      const t = this.timers.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        this.timers.delete(id);
      }
    }
  }

  private async attemptSettle(positionId: Hex): Promise<void> {
    const blameSeller = this.config.delivery.blameSeller;
    const args = [positionId, blameSeller] as const;

    type SimParams = Parameters<typeof this.chain.publicClient.simulateContract>[0];
    type SimReturn = Awaited<ReturnType<typeof this.chain.publicClient.simulateContract>>;
    let request: SimReturn["request"];
    try {
      const sim = (await this.chain.publicClient.simulateContract({
        address: this.config.futures.address,
        abi: FuturesAbi,
        functionName: "closeDelivery",
        args,
        account: this.chain.account,
      } as unknown as SimParams)) as SimReturn;
      request = sim.request;
    } catch (err) {
      const decoded = decodeRecoverableRevert(err);
      if (decoded !== undefined) {
        this.logRecoverableRevert(decoded, positionId, blameSeller);
        // PositionNotExists / PositionDeliveryExpired → contract no longer
        // accepts settlement. Drop from the index so we don't keep retrying.
        if (decoded === "PositionNotExists" || decoded === "PositionDeliveryExpired") {
          this.tracked.delete(positionId);
          const t = this.timers.get(positionId);
          if (t !== undefined) {
            clearTimeout(t);
            this.timers.delete(positionId);
          }
        }
        return;
      }
      throw err;
    }

    if (this.config.keeper.dryRun) {
      this.logger.info({ positionId, blameSeller }, "[dryRun] would call closeDelivery");
      this.tracked.delete(positionId);
      return;
    }

    type WriteParams = Parameters<typeof this.chain.walletClient.writeContract>[0];
    const hash = await this.chain.walletClient.writeContract(request as unknown as WriteParams);
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: this.config.coordinator.confirmationBlocks,
    });
    this.logger.info(
      {
        positionId,
        blameSeller,
        hash,
        blockNumber: receipt.blockNumber.toString(),
        ...formatGasCost(receipt, this.ethUsdFeed),
      },
      "delivery: closeDelivery confirmed",
    );
    this.tracked.delete(positionId);
    const t = this.timers.get(positionId);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(positionId);
    }
  }

  // ── log handlers ─────────────────────────────────────────────────────────
  // Mirror the live-and-backfill duality used by ParticipantTracker — the
  // same handler is fed both `watchContractEvent` callbacks and historical
  // `getContractEvents` results, so a future ABI rename surfaces here once.

  private onPositionCreated(logs: readonly Log[]): void {
    type Args = {
      positionId?: Hex;
      seller?: Address;
      buyer?: Address;
      deliveryAt?: bigint;
    };
    let added = 0;
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (
        args === undefined ||
        args.positionId === undefined ||
        args.deliveryAt === undefined ||
        args.seller === undefined ||
        args.buyer === undefined
      ) {
        continue;
      }
      const positionId = args.positionId;
      // Backfill can replay an event we already indexed (live watcher
      // overlap). De-dupe on positionId so we don't double-schedule.
      if (this.tracked.has(positionId)) continue;
      const tracked: TrackedPosition = {
        positionId,
        deliveryAt: args.deliveryAt,
        seller: args.seller,
        buyer: args.buyer,
      };
      this.tracked.set(positionId, tracked);
      this.scheduleTimer(tracked);
      added++;
      // INFO per *new* position so the operator sees live activity in
      // real time. We log inside the loop (not after) so each id and
      // its `deliveryAt` is searchable in tails — useful when chasing
      // a specific position's lifecycle. Backfill replays go through
      // the dedupe `continue` above and stay silent.
      this.logger.info(
        {
          positionId,
          seller: args.seller,
          buyer: args.buyer,
          deliveryAt: args.deliveryAt.toString(),
          total: this.tracked.size,
        },
        "delivery: new position indexed from live event",
      );
    }
    if (added === 0) return;
  }

  private onPositionClosed(logs: readonly Log[]): void {
    type Args = { positionId?: Hex };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.positionId === undefined) continue;
      const positionId = args.positionId;
      this.tracked.delete(positionId);
      const t = this.timers.get(positionId);
      if (t !== undefined) {
        clearTimeout(t);
        this.timers.delete(positionId);
      }
    }
  }

  /**
   * Differentiated logging for the recoverable-revert taxonomy. Three buckets:
   *
   *   debug — transient, will retry on the next sweep with no operator
   *           action needed (pre-window, oracle stale, oracle invalid).
   *   info  — terminal but benign: the contract no longer accepts settlement
   *           because someone else already did it. We drop and move on.
   *   error — operational red flag that should page. Deduped per
   *           `(revert, positionId)` so a stuck signer doesn't flood every
   *           sweep tick — the first hit per position is the loud one,
   *           subsequent ones drop to debug. Restart of the keeper resets
   *           the dedupe set, so a fix-and-restart re-enables the error
   *           for any new occurrences. We use `error` rather than `warn`
   *           because both are unrecoverable without operator action: the
   *           position will *never* be cash-settled by this keeper unless
   *           the cause is fixed:
   *             - signer != validator → keeper has no way to authorize
   *               `closeDelivery`; rotate LIQUIDATOR_PRIVATE_KEY to match
   *               `Futures.validatorAddress()` or have the position
   *               participant call `closeDelivery` themselves.
   *             - past `deliveryAt + duration` → the contract has hard-
   *               coded the window closed; the position is permanently
   *               stuck open from a settlement standpoint.
   */
  private logRecoverableRevert(
    revert: RecoverableRevert,
    positionId: Hex,
    blameSeller: boolean,
  ): void {
    if (revert === "PositionNotExists") {
      this.logger.info(
        { positionId, revert },
        "delivery: position already closed by someone else — dropping from index",
      );
      return;
    }
    if (revert === "OnlyValidatorOrPositionParticipant" || revert === "PositionDeliveryExpired") {
      const key = `${revert}:${positionId}`;
      if (this.warned.has(key)) {
        this.logger.debug(
          { positionId, blameSeller, revert },
          "delivery: closeDelivery skipped (already-reported recoverable revert)",
        );
        return;
      }
      this.warned.add(key);
      const message =
        revert === "OnlyValidatorOrPositionParticipant"
          ? "delivery: closeDelivery rejected — keeper signer is not Futures.validatorAddress(); position will not be settled until LIQUIDATOR_PRIVATE_KEY is rotated or the position participant calls closeDelivery"
          : "delivery: closeDelivery rejected — settlement window already expired; position is permanently stuck open and can no longer be cash-settled by the contract";
      this.logger.error(
        { positionId, blameSeller, revert, signer: this.chain.account.address },
        message,
      );
      return;
    }
    // PositionDeliveryNotStartedYet, OracleStale, InvalidOracle — sweep retries.
    this.logger.debug(
      { positionId, blameSeller, revert },
      "delivery: closeDelivery skipped (transient revert, will retry)",
    );
  }

  /**
   * Fire-and-forget timer at `deliveryAt + settleDelay`. If the time has
   * already passed we still schedule a 0ms timer rather than calling
   * `settle()` synchronously — keeps the log-handler hot path non-blocking
   * and lets the periodic sweep idempotently retry on failure.
   *
   * `setTimeout` is bounded at ~24.8 days (int32 ms). Positions further out
   * than that fall through to the periodic sweep — a daily-ish settlement
   * cadence is far below that ceiling, so this only matters for synthetic
   * test fixtures and far-future markets.
   */
  private scheduleTimer(pos: TrackedPosition): void {
    const existing = this.timers.get(pos.positionId);
    if (existing !== undefined) clearTimeout(existing);

    const targetMs = Number(pos.deliveryAt) * 1000 + this.config.delivery.settleDelayMs;
    const delayMs = Math.max(0, targetMs - Date.now());
    if (delayMs > MAX_TIMEOUT_MS) {
      // Out of `setTimeout`'s safe range — let the sweep handle it.
      return;
    }
    // Kick a sweep rather than calling `settle` directly. When many
    // positions share the same `deliveryAt` (typical for a single-trader
    // book), all their timers fire on the same tick — routing through
    // sweep coalesces them into one batched `Futures.multicall` tx
    // instead of N serial single-id txs racing for the next nonce.
    const timer = setTimeout(() => {
      void this.sweep().catch((err) => {
        this.logger.error({ err, positionId: pos.positionId }, "delivery: timer-fired sweep threw");
      });
    }, delayMs);
    // Don't keep the event loop alive solely for delivery timers — the
    // process should exit cleanly when other components shut down.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(pos.positionId, timer);
  }
}

interface TrackedPosition {
  positionId: Hex;
  deliveryAt: bigint;
  seller: Address;
  buyer: Address;
}

/** `setTimeout`'s int32 ms ceiling — values above are clamped silently to 1ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Reverts the module treats as "skip this attempt" rather than fatal. */
type RecoverableRevert =
  | "PositionNotExists"
  | "PositionDeliveryNotStartedYet"
  | "PositionDeliveryExpired"
  | "OnlyValidatorOrPositionParticipant"
  // Hashprice oracle hasn't ticked within `MAX_ORACLE_STALENESS` (1h). The
  // periodic sweep keeps the position queued; the next attempt succeeds as
  // soon as the oracle posts a fresh round.
  | "OracleStale"
  // Oracle returned a non-positive answer — same retry semantics.
  | "InvalidOracle";

const RECOVERABLE_REVERTS = new Set<RecoverableRevert>([
  "PositionNotExists",
  "PositionDeliveryNotStartedYet",
  "PositionDeliveryExpired",
  "OnlyValidatorOrPositionParticipant",
  "OracleStale",
  "InvalidOracle",
]);

function decodeRecoverableRevert(err: unknown): RecoverableRevert | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  const name = revert.data?.errorName;
  if (typeof name !== "string") return undefined;
  return RECOVERABLE_REVERTS.has(name as RecoverableRevert)
    ? (name as RecoverableRevert)
    : undefined;
}

/**
 * Tx-submission errors that mean "the broadcast didn't take, try again
 * next sweep" rather than "the call would revert". We treat these as
 * recoverable so a transient mempool / nonce / RPC issue doesn't crash
 * the keeper via unhandled rejection on a setTimeout-fired path.
 *
 * Patterns we've actually seen in production logs (all `code: -32000`
 * from Alchemy / Geth-flavoured nodes):
 *   - "replacement transaction underpriced" — same nonce already in
 *     mempool (e.g. concurrent manual `cast send`, or stale tx from a
 *     previous keeper run)
 *   - "nonce too low" — node just reflected the previous tx, our cached
 *     nonce is stale
 *   - "already known" — same tx hash already pending
 *   - "transaction underpriced" — new tx below current minGasPrice
 *   - generic timeout / 5xx / network errors
 *
 * Match by message substring because viem flattens RPC errors into
 * `BaseError.shortMessage` / `details` and there's no stable code we can
 * key off of across providers.
 */
function isTransientTxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const haystack = `${err.message ?? ""} ${(err as { details?: string }).details ?? ""} ${
    (err as { shortMessage?: string }).shortMessage ?? ""
  }`.toLowerCase();
  return (
    haystack.includes("replacement transaction underpriced") ||
    haystack.includes("transaction underpriced") ||
    haystack.includes("nonce too low") ||
    haystack.includes("already known") ||
    haystack.includes("known transaction") ||
    haystack.includes("could not coalesce") || // node-side mempool flap
    haystack.includes("timeout") ||
    haystack.includes("econnreset") ||
    haystack.includes("etimedout") ||
    haystack.includes("socket hang up")
  );
}

export const __testing = { decodeRecoverableRevert, isTransientTxError };
