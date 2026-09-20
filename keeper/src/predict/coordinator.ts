import type { Address } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { CoordinatorQueue } from "../coordinator/queue.ts";
import type { CoordinatorExecutor } from "../coordinator/executor.ts";
import type { ParticipantSource } from "../discovery/types.ts";
import type { PriceFeed, PriceUpdate } from "../oracle/priceFeed.ts";
import type { Notifier } from "../alert/notifier.ts";
import { readAccountHealthBatch } from "../pme/health.ts";
import { readAccountSnapshot, readMMParams } from "./snapshot.ts";
import {
  type MMParams,
  solveAlertThresholds,
  solveLiquidationThresholds,
} from "@hashpower/portfolio-margin";
import { PredictiveIndex } from "./predictiveIndex.ts";

/**
 * Wires the predictive layer into the existing keeper:
 *
 *   ParticipantTracker  ──onChanged──▶  invalidate + rebuild snapshot
 *   PriceFeed           ──onUpdate ──▶  detect crossings → enqueue users
 *
 * When a price tick crosses a user's predicted liquidation threshold:
 *   1. Read fresh on-chain `AccountHealth` for that user (multicall — same
 *      cost as one position in the periodic sweep).
 *   2. `queue.upsert(health)` — the queue gates on `mmSurplus < 0`, so a
 *      false-positive prediction (model drift) costs at most one cheap
 *      health read.
 *   3. `executor.kick()` to wake any idle workers immediately.
 *
 * The on-chain `mmRequired` remains the source of truth — the predictor
 * only decides *who* and *when* to look. Model drift therefore can only
 * cause a spurious queue insert (planner sees healthy, bails), never a
 * spurious liquidation transaction.
 *
 * Lifecycle:
 *   - `start()`: load shared `MMParams`, hook tracker.onChanged, hook
 *     priceFeed.onUpdate. Returns immediately.
 *   - `stop()`: detach hooks. In-flight `rebuild` calls finish; nothing
 *     gracefully cancellable in the snapshot reader.
 *   - `rebuild(user)`: read fresh snapshot + solve + index.upsert. Public
 *     for the runtime to seed the index after `tracker.backfill()`.
 */
export class PredictiveCoordinator {
  /** Liquidation crossings — drive the coordinator queue. */
  private readonly liqIndex = new PredictiveIndex();
  /** IM warn crossings — fire warn alerts on the notifier. */
  private readonly warnIndex = new PredictiveIndex();
  /** IM critical crossings — fire critical alerts on the notifier. */
  private readonly critIndex = new PredictiveIndex();
  private params: MMParams | undefined;
  /** Disposers unsubscribe from subscribtions */
  private disposers: Array<() => void> = [];
  /** In-flight rebuilds, keyed by user — coalesces rapid event bursts. */
  private inflightRebuilds = new Map<Address, Promise<void>>();

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly tracker: ParticipantSource;
  private readonly queue: CoordinatorQueue;
  private readonly executor: CoordinatorExecutor;
  private readonly priceFeed: PriceFeed;
  private readonly notifier: Notifier | undefined;
  private readonly logger: pino.Logger;

  constructor(
    chain: Chain,
    config: Config,
    tracker: ParticipantSource,
    queue: CoordinatorQueue,
    executor: CoordinatorExecutor,
    priceFeed: PriceFeed,
    logger: pino.Logger,
    notifier?: Notifier,
  ) {
    this.chain = chain;
    this.config = config;
    this.tracker = tracker;
    this.queue = queue;
    this.executor = executor;
    this.priceFeed = priceFeed;
    this.notifier = notifier;
    this.logger = logger.child({ component: "predictiveCoordinator" });
  }

  async start(): Promise<void> {
    this.params = await readMMParams(this.chain, this.config);
    this.logger.info(
      {
        imSpotShock: this.params.imSpotShock,
        mmSpotShock: this.params.mmSpotShock,
        tokenDecimals: this.params.tokenDecimals,
      },
      "PredictiveCoordinator: MM params loaded",
    );

    // New users → build their first snapshot. Existing users with state
    // changes are also funnelled through here, so we avoid two listeners.
    this.disposers.push(this.tracker.onAdded((user) => void this.rebuild(user)));
    this.disposers.push(this.tracker.onChanged((user) => void this.rebuild(user)));
    this.disposers.push(this.priceFeed.onUpdate((user) => this.handlePriceUpdate(user)));
  }

  stop(): void {
    for (const dispose of this.disposers) {
      try {
        dispose();
      } catch (err) {
        this.logger.warn({ err }, "PredictiveCoordinator.stop: disposer threw");
      }
    }
    this.disposers = [];
  }

  /**
   * Read a fresh snapshot for `user`, solve its thresholds, and update the
   * index. Coalesces concurrent rebuilds for the same user (the second
   * caller awaits the first) — bursts of events for the same address don't
   * fan out into duplicated RPC traffic.
   */
  rebuild(user: Address): Promise<void> {
    const inflight = this.inflightRebuilds.get(user);
    if (inflight !== undefined) return inflight;
    const promise = this.doRebuild(user).finally(() => {
      this.inflightRebuilds.delete(user);
    });
    this.inflightRebuilds.set(user, promise);
    return promise;
  }

  /** Total users currently indexed (i.e. predicted to be liquidatable somewhere). */
  size(): number {
    return this.liqIndex.size();
  }

  /** Total users with active warn-level predictive thresholds. */
  warnSize(): number {
    return this.warnIndex.size();
  }

  /** Total users with active critical-level predictive thresholds. */
  critSize(): number {
    return this.critIndex.size();
  }

  /** In-flight rebuild count — useful for healthcheck and shutdown ordering. */
  inflight(): number {
    return this.inflightRebuilds.size;
  }

  /** Addresses with an in-flight snapshot rebuild right now. */
  inflightUsers(): Address[] {
    return Array.from(this.inflightRebuilds.keys());
  }

  /**
   * One entry per user the predictor is watching. Combines the three
   * indices (liquidation / warn-alert / critical-alert) into a single
   * per-user record so consumers see "for user X, here are all the price
   * levels that trigger something" instead of three separate rosters.
   *
   * `down` = price falling to/through the threshold trips the action;
   * `up`   = price rising to/through it trips the action;
   * `null` = the solver returned no threshold on that side (the user is
   *          structurally safe in that direction at any plausible price,
   *          OR is already past the threshold — see `solve.ts` for the
   *          "already past" short-circuit).
   *
   * Bigint thresholds are stringified — JSON has no native bigint and the
   * ops dashboards downstream need string-comparable values anyway.
   */
  thresholds(): PredictedThresholds[] {
    const users = new Set<Address>([
      ...this.liqIndex.users(),
      ...this.warnIndex.users(),
      ...this.critIndex.users(),
    ]);
    const out: PredictedThresholds[] = [];
    for (const user of users) {
      const liq = this.liqIndex.get(user);
      const warn = this.warnIndex.get(user);
      const crit = this.critIndex.get(user);
      out.push({
        user,
        liq: priceSides(liq?.liqDown, liq?.liqUp),
        warn: priceSides(warn?.liqDown, warn?.liqUp),
        crit: priceSides(crit?.liqDown, crit?.liqUp),
      });
    }
    return out;
  }

  /**
   * Await all currently in-flight rebuilds. Used at startup so we can
   * declare "ready" only after the startup backfill has populated
   * the index. New rebuilds queued *after* this snapshot of inflight
   * promises will not block the returned promise — that's intentional;
   * callers should re-call if they want to drain a steady-state stream.
   */
  async awaitIdle(): Promise<void> {
    const pending = Array.from(this.inflightRebuilds.values());
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  private async doRebuild(user: Address): Promise<void> {
    if (this.params === undefined) return;
    const current = this.priceFeed.current();
    if (current === undefined) {
      this.logger.debug({ user }, "rebuild deferred — priceFeed has no value yet");
      return;
    }
    try {
      const snap = await readAccountSnapshot(this.chain, this.config, user);
      const liq = solveLiquidationThresholds(snap, this.params, current);
      const liqTracked = this.liqIndex.upsert(liq);

      // Alert thresholds only matter when we have a notifier wired AND the
      // user has collateral. ppm scaling matches `computeUtilization` in
      // `pme/health.ts`, which truncates to 6 decimal digits.
      let warnTracked = false;
      let critTracked = false;
      if (this.notifier !== undefined && snap.balance > 0n) {
        const warnPpm = BigInt(Math.round(this.config.alerts.imWarnUtilization * 1_000_000));
        const critPpm = BigInt(Math.round(this.config.alerts.imCriticalUtilization * 1_000_000));
        const alerts = solveAlertThresholds(snap, this.params, current, warnPpm, critPpm);
        warnTracked = this.warnIndex.upsert({
          user: alerts.user,
          liqDown: alerts.warnDown,
          liqUp: alerts.warnUp,
        });
        critTracked = this.critIndex.upsert({
          user: alerts.user,
          liqDown: alerts.critDown,
          liqUp: alerts.critUp,
        });
      } else {
        // Make sure stale entries are dropped if the notifier is unwired
        // mid-flight or balance went to zero.
        this.warnIndex.invalidate(user);
        this.critIndex.invalidate(user);
      }

      this.logger.debug(
        {
          user,
          liqDown: liq.liqDown,
          liqUp: liq.liqUp,
          liqTracked,
          warnTracked,
          critTracked,
        },
        "predictive snapshot rebuilt",
      );
    } catch (err) {
      this.logger.error({ err, user }, "rebuild failed — leaving prior thresholds in place");
    }
  }

  private handlePriceUpdate(update: PriceUpdate): void {
    const { prev, next } = update;
    if (prev === undefined) return;

    if (this.config.oracle.priceMoveTriggerBps > 0) {
      const moveBps = absDelta(prev, next);
      if (moveBps < this.config.oracle.priceMoveTriggerBps) {
        this.logger.debug({ prev, next, moveBps }, "price move below trigger threshold — skipping");
        return;
      }
    }

    const liqCrossings = this.liqIndex.crossings(prev, next);
    const warnCrossings = this.warnIndex.crossings(prev, next);
    const critCrossings = this.critIndex.crossings(prev, next);

    if (liqCrossings.length + warnCrossings.length + critCrossings.length === 0) return;

    this.logger.info(
      {
        prev,
        next,
        liq: liqCrossings.length,
        warn: warnCrossings.length,
        crit: critCrossings.length,
      },
      "price crossed predictive thresholds",
    );

    // All three paths need the same fresh AccountHealth read, so we
    // dedupe the union and read once. Crit users dominate — they get
    // both alerts AND queue treatment. Warn users skip the queue path.
    const allUsers = Array.from(
      new Set([
        ...liqCrossings.map((c) => c.user),
        ...warnCrossings.map((c) => c.user),
        ...critCrossings.map((c) => c.user),
      ]),
    );
    const liqUsers = new Set(liqCrossings.map((c) => c.user));
    const warnUsers = new Set(warnCrossings.map((c) => c.user));
    const critUsers = new Set(critCrossings.map((c) => c.user));

    void this.handleCrossings(allUsers, liqUsers, warnUsers, critUsers);
  }

  /**
   * Handle a batch of crossings: read each user's current on-chain health
   * (one multicall), then route:
   *   - liq crossings → queue.upsert + executor.kick
   *   - warn crossings → notifier.enqueue("warn") if not already at crit
   *   - crit crossings → notifier.enqueue("critical")
   *
   * Always rebuild after evaluation so stale thresholds get refreshed
   * against the new spot.
   */
  private async handleCrossings(
    allUsers: Address[],
    liqUsers: Set<Address>,
    warnUsers: Set<Address>,
    critUsers: Set<Address>,
  ): Promise<void> {
    try {
      const healths = await readAccountHealthBatch(this.chain, this.config, allUsers);
      let enqueued = 0;
      let alertsFired = 0;
      for (const h of healths) {
        if (liqUsers.has(h.user)) {
          if (this.queue.upsert(h)) enqueued++;
        }
        if (this.notifier !== undefined) {
          // Critical wins over warn for the same user — fire the higher
          // severity only. The notifier dedupes per (severity, user).
          if (
            critUsers.has(h.user) &&
            h.imUtilization >= this.config.alerts.imCriticalUtilization
          ) {
            this.notifier.enqueue({
              severity: "critical",
              user: h.user,
              health: h,
              reason: `predictive: IM utilization ${(h.imUtilization * 100).toFixed(1)}% ≥ critical ${(this.config.alerts.imCriticalUtilization * 100).toFixed(1)}%`,
            });
            alertsFired++;
          } else if (
            warnUsers.has(h.user) &&
            h.imUtilization >= this.config.alerts.imWarnUtilization
          ) {
            this.notifier.enqueue({
              severity: "warn",
              user: h.user,
              health: h,
              reason: `predictive: IM utilization ${(h.imUtilization * 100).toFixed(1)}% ≥ warn ${(this.config.alerts.imWarnUtilization * 100).toFixed(1)}%`,
            });
            alertsFired++;
          }
        }
      }
      if (enqueued > 0) {
        this.logger.info({ enqueued, evaluated: healths.length }, "predictive enqueue");
        this.executor.kick();
      }
      if (alertsFired > 0) {
        this.logger.info({ alertsFired, evaluated: healths.length }, "predictive alerts queued");
        // Drain immediately — the sweep could be 60s away. Fire-and-forget;
        // any failures re-buffer themselves at the head.
        if (this.notifier !== undefined) void this.notifier.drain();
      }
      for (const user of allUsers) void this.rebuild(user);
    } catch (err) {
      this.logger.error({ err, users: allUsers.length }, "handleCrossings failed");
    }
  }
}

/**
 * One row of `thresholds()`. Three triggers per user (liquidation /
 * warn-alert / critical-alert), each with a `down` and `up` price (or
 * `null` if not crossable on that side).
 */
export interface PredictedThresholds {
  user: Address;
  liq: ThresholdSides;
  warn: ThresholdSides;
  crit: ThresholdSides;
}

/** `down`/`up` price levels for one trigger, JSON-friendly strings. */
export interface ThresholdSides {
  down: string | null;
  up: string | null;
}

function priceSides(down: bigint | undefined, up: bigint | undefined): ThresholdSides {
  return {
    down: down === undefined ? null : down.toString(),
    up: up === undefined ? null : up.toString(),
  };
}

/**
 * Absolute price-move magnitude in basis points (1bp = 0.01%). Computed
 * relative to `prev` — "how much did the price move as a fraction of where
 * it was". Returns 0 when `prev === 0n`.
 */
function absDelta(prev: bigint, next: bigint): number {
  if (prev === 0n) return 0;
  const diff = next > prev ? next - prev : prev - next;
  return Number((diff * 10_000n) / prev);
}
