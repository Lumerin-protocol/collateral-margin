import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { withUnstickRetry } from "../tx/unstick.ts";
import type pino from "pino";
import { HashPowerFuturesAbi } from "../abi/HashPowerFutures.ts";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
import { formatGasCost } from "../tx/gasCost.ts";

/**
 * Optional keeper module that calls `Futures.settlePosition(user, expirationAt)`
 * on every active futures aggregate the moment its `expirationAt` (maturity) is
 * reached. Settlement pins the expiry price (lazily on first settle) and
 * cash-settles that user's unilateral PnL through the insurance fund.
 *
 * Authorization: `settlePosition` is permissionless.
 *
 * Hot path is event-driven:
 *
 *   OrderMatched     ─▶  re-index maker + taker active expiries
 *   PositionSettled  ─▶  drop that (user, expirationAt) from the index
 *   timer fires      ─▶  settle matured tracked aggregates
 *
 * Cold-start safety net:
 *
 *   bootstrapFromUsers(addrs) ─▶ getActiveExpirationDates + getUserPosition
 *   backfill(fromBlock)       ─▶ replay OrderMatched / PositionSettled
 *   sweep()                   ─▶ periodic settle of past-due tracked rows
 */
export class DeliveryCoordinator {
  /** Active aggregates: trackKey → metadata. */
  private readonly tracked = new Map<string, TrackedPosition>();
  /** One-shot timers keyed by trackKey. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** In-flight settles — coalesces duplicate triggers. */
  private readonly inflight = new Set<string>();
  private txChain: Promise<void> = Promise.resolve();
  private unwatchers: Array<() => void> = [];
  private sweepTimer: NodeJS.Timeout | undefined;
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
    this.ethUsdFeed = ethUsdFeed;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.logger.info(
      { signer: this.chain.account.address },
      "delivery coordinator starting (permissionless settlePosition)",
    );

    this.unwatchers.push(
      this.chain.publicClient.watchContractEvent({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        eventName: "OrderMatched",
        onLogs: (logs) => this.onOrderMatched(logs),
      }),
      this.chain.publicClient.watchContractEvent({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        eventName: "PositionSettled",
        onLogs: (logs) => this.onPositionSettled(logs),
      }),
    );

    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.config.delivery.sweepIntervalMs);
  }

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
        this.logger.warn(
          { err },
          "delivery: unwatcher threw — continuing shutdown",
        );
      }
    }
    this.unwatchers = [];
  }

  /**
   * Replay `OrderMatched` / `PositionSettled` in `[fromBlock, head]`.
   * Matched events re-index users; settled events drop track keys.
   */
  async backfill(fromBlock: bigint, chunkSize: bigint): Promise<void> {
    if (chunkSize <= 0n) {
      throw new Error(
        `delivery backfill chunkSize must be positive, got ${chunkSize}`,
      );
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

    let chunkErrors = 0;
    for (let start = fromBlock; start <= head; start += chunkSize) {
      const end = start + chunkSize - 1n > head ? head : start + chunkSize - 1n;
      try {
        const [matched, settled] = await Promise.all([
          this.chain.publicClient.getContractEvents({
            address: this.config.futures.address,
            abi: HashPowerFuturesAbi,
            eventName: "OrderMatched",
            fromBlock: start,
            toBlock: end,
          }),
          this.chain.publicClient.getContractEvents({
            address: this.config.futures.address,
            abi: HashPowerFuturesAbi,
            eventName: "PositionSettled",
            fromBlock: start,
            toBlock: end,
          }),
        ]);
        this.onOrderMatched(matched as unknown as readonly Log[]);
        this.onPositionSettled(settled as unknown as readonly Log[]);
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
   * View-based discovery: read every still-alive futures aggregate belonging
   * to `users` and index them.
   */
  async bootstrapFromUsers(users: readonly Address[]): Promise<void> {
    if (users.length === 0) {
      this.logger.info(
        { users: 0, total: this.tracked.size },
        "delivery bootstrap: no users to scan (tracker found none and no DELIVERY_BOOTSTRAP_USERS provided)",
      );
      return;
    }

    let indexed = 0;
    for (const user of users) {
      indexed += await this.indexUserPositionsInternal(user);
    }

    const pastDue = this.countPastDuePositions();
    const nextDueAt = this.findEarliestExpirationAt();
    this.logger.info(
      {
        users: users.length,
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

  private countPastDuePositions(): number {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    let n = 0;
    for (const pos of this.tracked.values()) {
      if (nowSec >= pos.expirationAt) n++;
    }
    return n;
  }

  private findEarliestExpirationAt(): bigint | undefined {
    let earliest: bigint | undefined;
    for (const pos of this.tracked.values()) {
      if (earliest === undefined || pos.expirationAt < earliest)
        earliest = pos.expirationAt;
    }
    return earliest;
  }

  /** Single-user index — wired from `tracker.onAdded`. Never throws. */
  async indexUserPositions(user: Address): Promise<void> {
    try {
      const indexed = await this.indexUserPositionsInternal(user);
      if (indexed > 0) {
        this.logger.info(
          { user, indexed, total: this.tracked.size },
          "delivery: indexed user's futures positions",
        );
      }
    } catch (err) {
      this.logger.error({ err, user }, "delivery: indexUserPositions failed");
    }
  }

  private async indexUserPositionsInternal(user: Address): Promise<number> {
    let expirationAts: readonly bigint[];
    try {
      expirationAts = (await this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getActiveExpirationDates",
        args: [user],
      })) as readonly bigint[];
    } catch (err) {
      this.logger.error({ err, user }, "delivery: getActiveExpirationDates failed");
      return 0;
    }
    if (expirationAts.length === 0) return 0;

    const positions = (await this.chain.publicClient.multicall({
      contracts: expirationAts.map((expirationAt) => ({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getUserPosition" as const,
        args: [user, expirationAt] as const,
      })),
      allowFailure: false,
    })) as readonly { netQuantity: bigint; netEntryValue: bigint }[];

    let added = 0;
    for (let i = 0; i < expirationAts.length; i++) {
      const expirationAt = expirationAts[i]!;
      const pos = positions[i];
      if (pos === undefined || pos.netQuantity === 0n) continue;
      if (this.upsertTracked(user, expirationAt)) added++;
    }
    return added;
  }

  /** Insert or refresh a tracked aggregate. Returns true if newly added. */
  private upsertTracked(user: Address, expirationAt: bigint): boolean {
    const key = trackKey(user, expirationAt);
    if (this.tracked.has(key)) return false;
    const tracked: TrackedPosition = {
      user: getAddress(user),
      expirationAt,
    };
    this.tracked.set(key, tracked);
    this.scheduleTimer(tracked);
    return true;
  }

  private dropTracked(user: Address, expirationAt: bigint): void {
    const key = trackKey(user, expirationAt);
    this.tracked.delete(key);
    const t = this.timers.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  async sweep(): Promise<void> {
    const latestBlock = await this.chain.publicClient.getBlock();
    const nowSec = latestBlock.timestamp;
    const candidates: TrackedPosition[] = [];

    for (const pos of this.tracked.values()) {
      if (this.inflight.has(trackKey(pos.user, pos.expirationAt))) continue;
      if (nowSec < pos.expirationAt) continue;
      candidates.push(pos);
    }

    if (candidates.length === 0) {
      this.logger.debug(
        { tracked: this.tracked.size, pendingFuture: this.tracked.size },
        "delivery sweep: nothing past-due",
      );
      return;
    }
    this.logger.info(
      { candidates: candidates.length, tracked: this.tracked.size },
      "delivery sweep: settling",
    );

    const max = Math.max(1, this.config.delivery.maxBatchSize);
    for (let i = 0; i < candidates.length; i += max) {
      const slice = candidates.slice(i, i + max);
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

  size(): number {
    return this.tracked.size;
  }

  /** Public for tests. */
  has(user: Address, expirationAt: bigint): boolean {
    return this.tracked.has(trackKey(user, expirationAt));
  }

  async settle(user: Address, expirationAt: bigint): Promise<void> {
    await this.settleBatch([{ user: getAddress(user), expirationAt }]);
  }

  async settleBatch(positions: readonly TrackedPosition[]): Promise<void> {
    const fresh: TrackedPosition[] = [];
    for (const pos of positions) {
      const key = trackKey(pos.user, pos.expirationAt);
      if (this.inflight.has(key)) continue;
      fresh.push({ user: getAddress(pos.user), expirationAt: pos.expirationAt });
      this.inflight.add(key);
    }
    if (fresh.length === 0) return;
    const next = this.txChain.then(() => this.attemptBatch(fresh));
    this.txChain = next.catch(() => undefined);
    try {
      await next;
    } finally {
      for (const pos of fresh) {
        this.inflight.delete(trackKey(pos.user, pos.expirationAt));
      }
    }
  }

  private async attemptBatch(positions: readonly TrackedPosition[]): Promise<void> {
    type SimParams = Parameters<
      typeof this.chain.publicClient.simulateContract
    >[0];
    const simResults = await Promise.allSettled(
      positions.map((pos) =>
        this.chain.publicClient.simulateContract({
          address: this.config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "settlePosition",
          args: [pos.user, pos.expirationAt],
          account: this.chain.account,
        } as unknown as SimParams),
      ),
    );

    const settleable: TrackedPosition[] = [];
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]!;
      const r = simResults[i] as PromiseSettledResult<unknown>;
      if (r.status === "fulfilled") {
        settleable.push(pos);
        continue;
      }
      const decoded = decodeRecoverableRevert(r.reason);
      if (decoded !== undefined) {
        this.logRecoverableRevert(decoded, pos);
        if (decoded === "PositionNotExists") {
          this.dropTracked(pos.user, pos.expirationAt);
        }
        continue;
      }
      this.logger.error(
        { err: r.reason, user: pos.user, expirationAt: pos.expirationAt.toString() },
        "delivery: simulate failed with non-recoverable error — skipping from batch",
      );
    }

    if (settleable.length === 0) {
      this.logger.debug(
        { batchSize: positions.length },
        "delivery batch: nothing to broadcast after simulate filter",
      );
      return;
    }

    if (this.config.keeper.dryRun) {
      this.logger.info(
        { batchSize: settleable.length },
        "[dryRun] would call Futures.settlePositions",
      );
      for (const pos of settleable) this.dropTracked(pos.user, pos.expirationAt);
      return;
    }

    const users = settleable.map((pos) => pos.user);
    const expirationAts = settleable.map((pos) => pos.expirationAt);

    type WriteParams = Parameters<
      typeof this.chain.walletClient.writeContract
    >[0];
    let hash: Hex;
    try {
      hash = await withUnstickRetry(this.chain, this.logger, () =>
        this.chain.walletClient.writeContract({
          address: this.config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "settlePositions",
          args: [users, expirationAts],
          account: this.chain.account,
          chain: this.chain.walletClient.chain ?? null,
        } as unknown as WriteParams),
      );
    } catch (err) {
      if (isTransientTxError(err)) {
        this.logger.warn(
          { err, batchSize: settleable.length },
          "delivery batch: tx submission failed transiently — sweep will retry",
        );
        return;
      }
      this.logger.warn(
        { err, batchSize: settleable.length },
        "delivery batch: write reverted — falling back to per-position retries",
      );
      for (const pos of settleable) {
        try {
          await this.attemptSettle(pos);
        } catch (innerErr) {
          this.logger.error(
            { err: innerErr, user: pos.user, expirationAt: pos.expirationAt.toString() },
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
        batchSize: settleable.length,
        ...formatGasCost(receipt, this.ethUsdFeed),
      },
      "delivery batch: settlePositions confirmed",
    );

    for (const pos of settleable) {
      this.dropTracked(pos.user, pos.expirationAt);
    }
  }

  private async attemptSettle(pos: TrackedPosition): Promise<void> {
    const args = [pos.user, pos.expirationAt] as const;

    type SimParams = Parameters<
      typeof this.chain.publicClient.simulateContract
    >[0];
    type SimReturn = Awaited<
      ReturnType<typeof this.chain.publicClient.simulateContract>
    >;
    let request: SimReturn["request"];
    try {
      const sim = (await this.chain.publicClient.simulateContract({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "settlePosition",
        args,
        account: this.chain.account,
      } as unknown as SimParams)) as SimReturn;
      request = sim.request;
    } catch (err) {
      const decoded = decodeRecoverableRevert(err);
      if (decoded !== undefined) {
        this.logRecoverableRevert(decoded, pos);
        if (decoded === "PositionNotExists") {
          this.dropTracked(pos.user, pos.expirationAt);
        }
        return;
      }
      throw err;
    }

    if (this.config.keeper.dryRun) {
      this.logger.info(
        { user: pos.user, expirationAt: pos.expirationAt.toString() },
        "[dryRun] would call settlePosition",
      );
      this.dropTracked(pos.user, pos.expirationAt);
      return;
    }

    type WriteParams = Parameters<
      typeof this.chain.walletClient.writeContract
    >[0];
    const hash = await this.chain.walletClient.writeContract(
      request as unknown as WriteParams,
    );
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: this.config.coordinator.confirmationBlocks,
    });
    this.logger.info(
      {
        user: pos.user,
        expirationAt: pos.expirationAt.toString(),
        hash,
        blockNumber: receipt.blockNumber.toString(),
        ...formatGasCost(receipt, this.ethUsdFeed),
      },
      "delivery: settlePosition confirmed",
    );
    this.dropTracked(pos.user, pos.expirationAt);
  }

  private onOrderMatched(logs: readonly Log[]): void {
    type Args = {
      maker?: Address;
      taker?: Address;
      expirationAt?: bigint;
      makerNetQtyAfter?: bigint;
      takerNetQtyAfter?: bigint;
    };
    const users = new Set<Address>();
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args === undefined) continue;
      // Fast path: if post-match qty is available, upsert/drop without RPC.
      if (args.expirationAt !== undefined) {
        if (args.maker !== undefined && args.makerNetQtyAfter !== undefined) {
          if (args.makerNetQtyAfter === 0n) this.dropTracked(args.maker, args.expirationAt);
          else this.upsertTracked(args.maker, args.expirationAt);
        } else if (args.maker !== undefined) {
          users.add(args.maker);
        }
        if (args.taker !== undefined && args.takerNetQtyAfter !== undefined) {
          if (args.takerNetQtyAfter === 0n) this.dropTracked(args.taker, args.expirationAt);
          else this.upsertTracked(args.taker, args.expirationAt);
        } else if (args.taker !== undefined) {
          users.add(args.taker);
        }
      } else {
        if (args.maker !== undefined) users.add(args.maker);
        if (args.taker !== undefined) users.add(args.taker);
      }
    }
    for (const user of users) {
      void this.indexUserPositions(user);
    }
  }

  private onPositionSettled(logs: readonly Log[]): void {
    type Args = { user?: Address; expirationAt?: bigint };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.user === undefined || args.expirationAt === undefined) continue;
      this.dropTracked(args.user, args.expirationAt);
    }
  }

  private logRecoverableRevert(revert: RecoverableRevert, pos: TrackedPosition): void {
    if (revert === "PositionNotExists") {
      this.logger.info(
        { user: pos.user, expirationAt: pos.expirationAt.toString(), revert },
        "delivery: position already settled by someone else — dropping from index",
      );
      return;
    }
    this.logger.debug(
      { user: pos.user, expirationAt: pos.expirationAt.toString(), revert },
      "delivery: settlePosition skipped (transient revert, will retry)",
    );
  }

  private scheduleTimer(pos: TrackedPosition): void {
    const key = trackKey(pos.user, pos.expirationAt);
    const existing = this.timers.get(key);
    if (existing !== undefined) clearTimeout(existing);

    const targetMs =
      Number(pos.expirationAt) * 1000 + this.config.delivery.settleDelayMs;
    const delayMs = Math.max(0, targetMs - Date.now());
    if (delayMs > MAX_TIMEOUT_MS) {
      return;
    }
    const timer = setTimeout(() => {
      void this.sweep().catch((err) => {
        this.logger.error(
          { err, user: pos.user, expirationAt: pos.expirationAt.toString() },
          "delivery: timer-fired sweep threw",
        );
      });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(key, timer);
  }
}

export function trackKey(user: Address, expirationAt: bigint): string {
  return `${getAddress(user).toLowerCase()}:${expirationAt.toString()}`;
}

interface TrackedPosition {
  user: Address;
  expirationAt: bigint;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

type RecoverableRevert =
  | "PositionNotExists"
  | "PositionExpirationNotStartedYet"
  | "OracleStale"
  | "InvalidOracle";

const RECOVERABLE_REVERTS = new Set<RecoverableRevert>([
  "PositionNotExists",
  "PositionExpirationNotStartedYet",
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

function isTransientTxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const haystack =
    `${err.message ?? ""} ${(err as { details?: string }).details ?? ""} ${
      (err as { shortMessage?: string }).shortMessage ?? ""
    }`.toLowerCase();
  return (
    haystack.includes("replacement transaction underpriced") ||
    haystack.includes("transaction underpriced") ||
    haystack.includes("nonce too low") ||
    haystack.includes("already known") ||
    haystack.includes("known transaction") ||
    haystack.includes("could not coalesce") ||
    haystack.includes("timeout") ||
    haystack.includes("econnreset") ||
    haystack.includes("etimedout") ||
    haystack.includes("socket hang up")
  );
}

export const __testing = { decodeRecoverableRevert, isTransientTxError, trackKey };
