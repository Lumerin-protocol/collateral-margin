import type pino from "pino";
import type { Config } from "../config.ts";
import type { CoordinatorQueue } from "./queue.ts";
import type { Planner, PlanOutcome } from "./planner.ts";

/**
 * Drives the planner. Pulls accounts from the queue (most-underwater first)
 * and runs the per-account plan.
 *
 * Concurrency is configurable via `coordinator.maxConcurrentAccounts`. The
 * default of 1 is the safe choice today: shared PME means concurrent plans
 * for the same user are unsafe, and concurrent plans for different users
 * could compete for the same vault state when one user's liquidation drains
 * the insurance fund. Bumping `maxConcurrentAccounts` later requires a
 * per-user lock; the executor enforces "one plan per user at a time" by
 * tracking in-flight users in `inflight`, which holds even at concurrency 1.
 *
 * Lifecycle:
 *   - `start()` spawns the worker loop(s) and returns immediately.
 *   - The loop polls `queue.pop()`. When the queue drains it sleeps on the
 *     next `kick()` — events / sweeps wake it up.
 *   - `stop()` flips `running=false`. Outstanding plans finish; no new ones
 *     are picked up.
 */
export class CoordinatorExecutor {
  private running = false;
  private readonly inflight = new Set<string>();
  private wakeUp: (() => void) | undefined;
  private workers: Promise<void>[] = [];

  // Explicit fields — Node's TypeScript strip-only mode does not support
  // parameter properties (the `private readonly config: Config` shortcut).
  private readonly config: Config;
  private readonly queue: CoordinatorQueue;
  private readonly planner: Planner;
  private readonly logger: pino.Logger;

  constructor(
    config: Config,
    queue: CoordinatorQueue,
    planner: Planner,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.queue = queue;
    this.planner = planner;
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn("CoordinatorExecutor.start: already running");
      return;
    }
    this.running = true;
    const concurrency = Math.max(1, this.config.coordinator.maxConcurrentAccounts);
    this.logger.info({ maxConcurrent: concurrency }, "CoordinatorExecutor.start");
    this.workers = Array.from({ length: concurrency }, (_, i) => this.workerLoop(i));
    await Promise.resolve();
  }

  /**
   * Wake all idle workers. Called by the discovery layer after upserting an
   * account into the queue, by the periodic sweep, and by the planner itself
   * when it needs to re-queue a stalled account.
   */
  kick(): void {
    if (this.wakeUp !== undefined) {
      this.wakeUp();
      this.wakeUp = undefined;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.kick();
    await Promise.allSettled(this.workers);
    this.workers = [];
    this.logger.info("CoordinatorExecutor.stop: drained");
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Visible for tests — count of in-flight users. */
  inflightCount(): number {
    return this.inflight.size;
  }

  private async workerLoop(workerId: number): Promise<void> {
    const log = this.logger.child({ workerId });
    log.debug("worker loop started");
    while (this.running) {
      const next = this.popNonInflight();
      if (next === undefined) {
        // Queue empty (or every entry is already being worked) — wait for kick.
        await this.waitForKick();
        continue;
      }
      this.inflight.add(next.user);
      try {
        const outcome = await this.planner.run(next.user);
        this.handleOutcome(next.user, outcome, log);
      } catch (err) {
        // Hard failure (RPC down, unrecoverable revert). Log and re-queue
        // with the stale snapshot so the next sweep refreshes health.
        log.error({ user: next.user, err }, "Planner.run threw — re-queueing");
        this.queue.upsert(next);
      } finally {
        this.inflight.delete(next.user);
      }
    }
    log.debug("worker loop exited");
  }

  /**
   * Pops the head of the queue, but skips entries already in flight on
   * another worker. We re-queue any skipped entries so they aren't lost.
   *
   * Returns the head entry, or undefined when nothing is workable.
   */
  private popNonInflight(): ReturnType<CoordinatorQueue["pop"]> {
    const skipped: NonNullable<ReturnType<CoordinatorQueue["pop"]>>[] = [];
    let next: ReturnType<CoordinatorQueue["pop"]> = this.queue.pop();
    while (next !== undefined && this.inflight.has(next.user)) {
      skipped.push(next);
      next = this.queue.pop();
    }
    for (const s of skipped) this.queue.upsert(s);
    return next;
  }

  /** Resolves on the next `kick()` or on `stop()`. */
  private waitForKick(): Promise<void> {
    return new Promise<void>((resolve) => {
      const prev = this.wakeUp;
      this.wakeUp = () => {
        if (prev !== undefined) prev();
        resolve();
      };
    });
  }

  private handleOutcome(user: string, outcome: PlanOutcome, log: pino.Logger): void {
    switch (outcome.kind) {
      case "healthy":
      case "liquidated":
        log.info({ user, outcome }, "Plan complete");
        return;
      case "stalled":
        // Re-queue with the latest mmSurplus so the next sweep / event
        // promotes it back into priority order.
        log.warn({ user, outcome }, "Plan stalled — re-queueing");
        // Caller (discovery layer) will refresh the health snapshot before
        // re-upserting; if we re-upsert here we'd carry a stale snapshot.
        // Just log and rely on the periodic sweep.
        return;
      case "badDebt":
        // Critical alert path is owned by the notifier — we surface the
        // outcome via logs and let the alert layer subscribe to those.
        log.error({ user, outcome }, "BadDebt: insurance fund must absorb residual");
        return;
    }
  }
}
