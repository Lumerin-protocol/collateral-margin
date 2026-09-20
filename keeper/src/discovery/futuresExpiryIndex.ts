import {
  getAddress,
  type Address,
  type Log,
} from "viem";
import type pino from "pino";
import { HashPowerFuturesAbi } from "../abi/HashPowerFutures.ts";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type {
  ParticipantListener,
  ParticipantSource,
} from "./types.ts";

export interface ExpiryPosition {
  user: Address;
  expirationAt: bigint;
}

export type PositionListener = (
  user: Address,
  expirationAt: bigint,
  active: boolean,
) => void;

interface ExpiryBucket {
  expirationAt: bigint;
  participants: Set<Address>;
  positions: Set<Address>;
}

/**
 * Bounded Futures discovery index. Each order book gets an independent cache,
 * rebuilt from only that market's lifetime rather than contract deployment.
 */
export class FuturesExpiryIndex implements ParticipantSource {
  private readonly buckets = new Map<bigint, ExpiryBucket>();
  private readonly addedListeners = new Set<ParticipantListener>();
  private readonly changedListeners = new Set<ParticipantListener>();
  private readonly positionListeners = new Set<PositionListener>();
  private unwatchers: Array<() => void> = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private previousExpiry: bigint | undefined;
  private replayFromBlock: bigint | undefined;
  private replayHeadBlock: bigint | undefined;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;

  constructor(
    chain: Chain,
    config: Config,
    logger: pino.Logger,
  ) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ component: "futuresExpiryIndex" });
  }

  async start(): Promise<void> {
    this.unwatchers.push(
      this.watch("OrderCreated", (logs) => this.onOrderCreated(logs)),
      this.watch("OrderMatched", (logs) => this.onOrderMatched(logs)),
      this.watch("PositionLiquidated", (logs) => this.onPositionLiquidated(logs)),
      this.watch("PositionSettled", (logs) => this.onPositionSettled(logs)),
    );

    await this.bootstrap();
    const seeds = [
      this.chain.account.address,
      ...this.config.delivery.bootstrapUsers,
    ];
    await this.seedUsers(seeds);

    this.refreshTimer = setInterval(() => {
      void this.refreshWindow().catch((err) => {
        this.logger.error({ err }, "futures expiry window refresh failed");
      });
    }, this.config.delivery.sweepIntervalMs);
    if (typeof this.refreshTimer.unref === "function") this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const unwatch of this.unwatchers) {
      try {
        unwatch();
      } catch (err) {
        this.logger.warn({ err }, "futures expiry unwatcher threw");
      }
    }
    this.unwatchers = [];
  }

  /** Refresh the rolling expiry window immediately. Public for operations/tests. */
  async refresh(): Promise<void> {
    await this.refreshWindow();
  }

  list(): Address[] {
    const users = new Map<string, Address>();
    for (const bucket of this.buckets.values()) {
      for (const user of bucket.participants) {
        users.set(user.toLowerCase(), user);
      }
    }
    return Array.from(users.values());
  }

  size(): number {
    return this.list().length;
  }

  has(user: Address): boolean {
    const key = getAddress(user);
    for (const bucket of this.buckets.values()) {
      if (bucket.participants.has(key)) return true;
    }
    return false;
  }

  onAdded(listener: ParticipantListener): () => void {
    this.addedListeners.add(listener);
    return () => this.addedListeners.delete(listener);
  }

  onChanged(listener: ParticipantListener): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  onPositionChanged(listener: PositionListener): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  positionEntries(): ExpiryPosition[] {
    const out: ExpiryPosition[] = [];
    for (const bucket of this.buckets.values()) {
      for (const user of bucket.positions) {
        out.push({ user, expirationAt: bucket.expirationAt });
      }
    }
    return out;
  }

  stats(): FuturesExpiryStats {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const positions = this.positionEntries();
    const unresolved = positions
      .filter((position) => position.expirationAt <= now)
      .map((position) => position.expirationAt);
    return {
      caches: this.buckets.size,
      users: this.size(),
      positions: positions.length,
      pastDue: unresolved.length,
      oldestUnresolved:
        unresolved.length === 0
          ? undefined
          : unresolved.reduce((a, b) => (a < b ? a : b)),
      replayFromBlock: this.replayFromBlock,
      replayHeadBlock: this.replayHeadBlock,
    };
  }

  /** Emergency/bootstrap path; normal discovery comes from expiry-scoped logs. */
  async seedUsers(users: readonly Address[]): Promise<void> {
    const unique = new Map<string, Address>();
    for (const user of users) {
      const checksummed = getAddress(user);
      unique.set(checksummed.toLowerCase(), checksummed);
    }
    for (const user of unique.values()) {
      let expiries: readonly bigint[];
      try {
        expiries = (await this.chain.publicClient.readContract({
          address: this.config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "getActiveExpirationDates",
          args: [user],
        })) as readonly bigint[];
      } catch (err) {
        this.logger.error({ err, user }, "futures expiry seed read failed");
        continue;
      }
      for (const expirationAt of expiries) {
        this.touchParticipant(expirationAt, user);
        await this.reconcilePosition(user, expirationAt);
      }
    }
  }

  private watch(
    eventName:
      | "OrderCreated"
      | "OrderMatched"
      | "PositionLiquidated"
      | "PositionSettled",
    onLogs: (logs: readonly Log[]) => void,
  ): () => void {
    return this.chain.publicClient.watchContractEvent({
      address: this.config.futures.address,
      abi: HashPowerFuturesAbi,
      eventName,
      onLogs: (logs: readonly unknown[]) =>
        onLogs(logs as unknown as readonly Log[]),
    } as never);
  }

  private async bootstrap(): Promise<void> {
    const window = await this.refreshWindow();
    if (window.targets.length === 0) return;

    const intervalSec = window.intervalDays * 86_400n;
    const earliestExpiry = window.targets.reduce((a, b) => (a < b ? a : b));
    const lifetimeSec = intervalSec * BigInt(Math.max(1, window.expiryCount));
    const fromTimestamp =
      earliestExpiry > lifetimeSec ? earliestExpiry - lifetimeSec : 0n;
    const head = await this.chain.publicClient.getBlockNumber();
    const fromBlock = await this.findBlockAtOrAfter(fromTimestamp, head);
    this.replayFromBlock = fromBlock;
    this.replayHeadBlock = head;

    await this.replay(fromBlock, head);
    await this.reconcileAllPositions();
    this.logger.info(
      {
        expiries: window.targets.map(String),
        fromBlock: fromBlock.toString(),
        head: head.toString(),
        users: this.size(),
        positions: this.positionEntries().length,
      },
      "futures expiry index bootstrap complete",
    );
  }

  private async refreshWindow(): Promise<ExpiryWindow> {
    const [rawExpiries, intervalDays, expiryCount] = await Promise.all([
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getExpirationDates",
      }) as Promise<readonly bigint[]>,
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "expirationIntervalDays",
      }) as Promise<number>,
      this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "futureExpirationDatesCount",
      }) as Promise<number>,
    ]);
    const active = [...rawExpiries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const intervalSec = BigInt(intervalDays) * 86_400n;
    const firstActive = active[0];
    const previous =
      firstActive !== undefined && firstActive >= intervalSec
        ? firstActive - intervalSec
        : undefined;
    const targets = previous === undefined ? active : [previous, ...active];

    this.previousExpiry = previous;
    for (const expirationAt of targets) this.bucket(expirationAt);
    this.pruneDrainedBuckets();
    return { targets, intervalDays: BigInt(intervalDays), expiryCount };
  }

  private pruneDrainedBuckets(): void {
    if (this.previousExpiry === undefined) return;
    for (const [expirationAt, bucket] of this.buckets) {
      if (
        expirationAt < this.previousExpiry &&
        bucket.positions.size === 0
      ) {
        this.buckets.delete(expirationAt);
      }
    }
  }

  private async replay(fromBlock: bigint, head: bigint): Promise<void> {
    const chunkSize = this.config.chain.backfillChunkSize;
    if (chunkSize <= 0n) throw new Error("BACKFILL_CHUNK_SIZE must be positive");
    const eventNames = [
      "OrderCreated",
      "OrderMatched",
      "PositionLiquidated",
      "PositionSettled",
    ] as const;

    for (let start = fromBlock; start <= head; start += chunkSize) {
      const toBlock =
        start + chunkSize - 1n > head ? head : start + chunkSize - 1n;
      try {
        const pages = await Promise.all(
          eventNames.map(async (eventName) => {
            const logs = await this.chain.publicClient.getContractEvents({
              address: this.config.futures.address,
              abi: HashPowerFuturesAbi,
              eventName,
              fromBlock: start,
              toBlock,
            } as never);
            return (logs as unknown as Log[]).map((log) => ({
              eventName,
              log,
            }));
          }),
        );
        const ordered = pages.flat().sort(compareLogs);
        for (const entry of ordered) this.dispatch(entry.eventName, [entry.log]);
      } catch (err) {
        this.logger.error(
          { err, fromBlock: start.toString(), toBlock: toBlock.toString() },
          "futures expiry replay chunk failed",
        );
      }
    }
  }

  private dispatch(
    eventName:
      | "OrderCreated"
      | "OrderMatched"
      | "PositionLiquidated"
      | "PositionSettled",
    logs: readonly Log[],
  ): void {
    if (eventName === "OrderCreated") this.onOrderCreated(logs);
    else if (eventName === "OrderMatched") this.onOrderMatched(logs);
    else if (eventName === "PositionLiquidated") this.onPositionLiquidated(logs);
    else this.onPositionSettled(logs);
  }

  private onOrderCreated(logs: readonly Log[]): void {
    type Args = { participant?: Address; expirationAt?: bigint };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.participant === undefined || args.expirationAt === undefined)
        continue;
      this.touchParticipant(args.expirationAt, args.participant);
    }
  }

  private onOrderMatched(logs: readonly Log[]): void {
    type Args = {
      maker?: Address;
      taker?: Address;
      expirationAt?: bigint;
      makerNetQtyAfter?: bigint;
      takerNetQtyAfter?: bigint;
    };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.expirationAt === undefined) continue;
      if (args.maker !== undefined) {
        this.touchParticipant(args.expirationAt, args.maker);
        if (args.makerNetQtyAfter !== undefined) {
          this.setPosition(
            args.expirationAt,
            args.maker,
            args.makerNetQtyAfter !== 0n,
          );
        }
      }
      if (args.taker !== undefined) {
        this.touchParticipant(args.expirationAt, args.taker);
        if (args.takerNetQtyAfter !== undefined) {
          this.setPosition(
            args.expirationAt,
            args.taker,
            args.takerNetQtyAfter !== 0n,
          );
        }
      }
    }
  }

  private onPositionLiquidated(logs: readonly Log[]): void {
    type Args = { user?: Address; expirationAt?: bigint };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.user === undefined || args.expirationAt === undefined) continue;
      this.touchParticipant(args.expirationAt, args.user);
      void this.reconcilePosition(args.user, args.expirationAt);
    }
  }

  private onPositionSettled(logs: readonly Log[]): void {
    type Args = { user?: Address; expirationAt?: bigint };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.user === undefined || args.expirationAt === undefined) continue;
      this.touchParticipant(args.expirationAt, args.user);
      this.setPosition(args.expirationAt, args.user, false);
    }
    this.pruneDrainedBuckets();
  }

  private touchParticipant(expirationAt: bigint, rawUser: Address): void {
    const user = getAddress(rawUser);
    const existedGlobally = this.has(user);
    const bucket = this.bucket(expirationAt);
    bucket.participants.add(user);
    if (!existedGlobally) this.emit(this.addedListeners, user);
    this.emit(this.changedListeners, user);
  }

  private setPosition(
    expirationAt: bigint,
    rawUser: Address,
    active: boolean,
  ): void {
    const user = getAddress(rawUser);
    const bucket = this.bucket(expirationAt);
    const changed = active
      ? !bucket.positions.has(user)
      : bucket.positions.has(user);
    if (active) bucket.positions.add(user);
    else bucket.positions.delete(user);
    if (changed) {
      for (const listener of this.positionListeners) {
        try {
          listener(user, expirationAt, active);
        } catch (err) {
          this.logger.error({ err, user }, "position listener threw");
        }
      }
    }
  }

  private bucket(expirationAt: bigint): ExpiryBucket {
    let bucket = this.buckets.get(expirationAt);
    if (bucket === undefined) {
      bucket = {
        expirationAt,
        participants: new Set<Address>(),
        positions: new Set<Address>(),
      };
      this.buckets.set(expirationAt, bucket);
    }
    return bucket;
  }

  private emit(listeners: Set<ParticipantListener>, user: Address): void {
    for (const listener of listeners) {
      try {
        listener(user);
      } catch (err) {
        this.logger.error({ err, user }, "participant listener threw");
      }
    }
  }

  private async reconcileAllPositions(): Promise<void> {
    const entries = this.positionEntries();
    for (let i = 0; i < entries.length; i += 64) {
      const chunk = entries.slice(i, i + 64);
      const positions = (await this.chain.publicClient.multicall({
        contracts: chunk.map((entry) => ({
          address: this.config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "getUserPosition" as const,
          args: [entry.user, entry.expirationAt] as const,
        })),
        allowFailure: false,
      })) as readonly { netQuantity: bigint }[];
      for (let j = 0; j < chunk.length; j++) {
        const entry = chunk[j];
        if (entry === undefined) continue;
        this.setPosition(
          entry.expirationAt,
          entry.user,
          positions[j]?.netQuantity !== 0n,
        );
      }
    }
  }

  private async reconcilePosition(
    user: Address,
    expirationAt: bigint,
  ): Promise<void> {
    try {
      const position = (await this.chain.publicClient.readContract({
        address: this.config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getUserPosition",
        args: [user, expirationAt],
      })) as { netQuantity: bigint };
      this.setPosition(expirationAt, user, position.netQuantity !== 0n);
    } catch (err) {
      this.logger.error(
        { err, user, expirationAt: expirationAt.toString() },
        "futures position reconciliation failed",
      );
    }
  }

  private async findBlockAtOrAfter(
    timestamp: bigint,
    head: bigint,
  ): Promise<bigint> {
    let low = 0n;
    let high = head;
    while (low < high) {
      const mid = (low + high) / 2n;
      const block = await this.chain.publicClient.getBlock({ blockNumber: mid });
      if (block.timestamp < timestamp) low = mid + 1n;
      else high = mid;
    }
    return low;
  }
}

function compareLogs(
  a: { log: Log },
  b: { log: Log },
): number {
  const aBlock = a.log.blockNumber ?? 0n;
  const bBlock = b.log.blockNumber ?? 0n;
  if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
  const aIndex = a.log.logIndex ?? 0;
  const bIndex = b.log.logIndex ?? 0;
  return aIndex - bIndex;
}

interface ExpiryWindow {
  targets: bigint[];
  intervalDays: bigint;
  expiryCount: number;
}

export interface FuturesExpiryStats {
  caches: number;
  users: number;
  positions: number;
  pastDue: number;
  oldestUnresolved?: bigint;
  replayFromBlock?: bigint;
  replayHeadBlock?: bigint;
}
