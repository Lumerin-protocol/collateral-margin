import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { CoordinatorQueue } from "../coordinator/queue.ts";
import type { CoordinatorExecutor } from "../coordinator/executor.ts";
import type { Notifier } from "../alert/notifier.ts";
import type { ParticipantTracker } from "../discovery/tracker.ts";
import { readAccountHealthBatch } from "../pme/health.ts";

/**
 * Periodic sweep: rebuilds the coordinator queue from the tracker's known
 * users by reading their portfolio health in batches via the PME multicall
 * (see `pme/health.ts`).
 *
 * Acts as a safety net on top of the event-driven path — handles dropped
 * events, missed webhooks, and price moves that don't trigger any direct
 * contract event (the most common gap in our coverage).
 *
 * Participant discovery is handled separately: live by
 * `ParticipantTracker.start()`'s event subscriptions, and at boot by a
 * one-shot `tracker.backfill(fromBlock)` from `index.ts`. The scheduler
 * no longer owns a periodic tracker refresh — it only re-evaluates the
 * users the tracker has already accepted.
 *
 * The single timer is pure additive — it never blocks the event-driven
 * hot path.
 */
export class Scheduler {
  private sweepTimer: NodeJS.Timeout | undefined;
  private inflightSweep = false;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly tracker: ParticipantTracker;
  private readonly queue: CoordinatorQueue;
  private readonly executor: CoordinatorExecutor;
  private readonly notifier: Notifier;
  private readonly logger: pino.Logger;

  constructor(
    chain: Chain,
    config: Config,
    tracker: ParticipantTracker,
    queue: CoordinatorQueue,
    executor: CoordinatorExecutor,
    notifier: Notifier,
    logger: pino.Logger,
  ) {
    this.chain = chain;
    this.config = config;
    this.tracker = tracker;
    this.queue = queue;
    this.executor = executor;
    this.notifier = notifier;
    this.logger = logger.child({ component: "scheduler" });
  }

  start(): void {
    this.sweepTimer = setInterval(() => {
      void this.runSweep();
    }, this.config.runtime.sweepIntervalMs);
    this.logger.info(
      { sweepMs: this.config.runtime.sweepIntervalMs },
      "scheduler started",
    );
  }

  stop(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Public for tests — runs a single sweep cycle to completion. Idempotent
   * even if a previous tick is still in flight (we just skip).
   */
  async runSweep(): Promise<void> {
    if (this.inflightSweep) {
      this.logger.debug("sweep skipped — previous sweep still running");
      return;
    }
    this.inflightSweep = true;
    try {
      const users = this.tracker.list();
      if (users.length === 0) return;

      const healths = await readAccountHealthBatch(this.chain, this.config, users);
      let underwater = 0;
      let warned = 0;
      let critical = 0;
      for (const h of healths) {
        // The queue gates on `mmSurplus < 0` internally — healthy snapshots
        // remove the user from the queue, underwater snapshots re-rank it.
        this.queue.upsert(h);
        if (h.mmSurplus < 0n) underwater++;

        // Alert ladder: critical first (always), then warn unless promoted.
        if (h.imUtilization >= this.config.alerts.imCriticalUtilization) {
          critical++;
          this.notifier.enqueue({
            severity: "critical",
            user: h.user,
            health: h,
            reason: `IM utilization ${(h.imUtilization * 100).toFixed(1)}% ≥ critical ${(this.config.alerts.imCriticalUtilization * 100).toFixed(1)}%`,
          });
        } else if (h.imUtilization >= this.config.alerts.imWarnUtilization) {
          warned++;
          this.notifier.enqueue({
            severity: "warn",
            user: h.user,
            health: h,
            reason: `IM utilization ${(h.imUtilization * 100).toFixed(1)}% ≥ warn ${(this.config.alerts.imWarnUtilization * 100).toFixed(1)}%`,
          });
        }
      }

      this.logger.debug(
        { tracked: users.length, underwater, warned, critical },
        "sweep complete",
      );

      if (underwater > 0) this.executor.kick();
      await this.notifier.drain();
    } catch (err) {
      this.logger.error({ err }, "sweep failed");
    } finally {
      this.inflightSweep = false;
    }
  }
}
