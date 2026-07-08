import type pino from "pino";
import type { GasTracker } from "./gasTracker.ts";
import type { CollateralTracker } from "./collateralTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type { MarketRuntime } from "./marketRuntime.ts";
import type { MarketIntents, TxCoordinator } from "./txCoordinator.ts";
import type { PortfolioHealthCheck } from "./portfolioHealth.ts";
import type { ErrorInfo } from "./errors.ts";
import { toErrorInfo } from "./errSerializer.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE_ERROR_DELAY_MS = 5_000;
const MAX_ERROR_DELAY_MS = 3 * 60_000;

/**
 * Reconciles the live market set with the venues' current selection. Called
 * periodically for the futures roll. Returns markets to add (already built,
 * not yet started) and ids to remove (matured / rolled off).
 */
export type RollFn = (
  current: MarketRuntime[],
) => Promise<{ add: MarketRuntime[]; removeIds: string[] }>;

export interface PortfolioRunnerOpts {
  pollIntervalMs: number;
  /** How often to re-check the venue market set for the roll. */
  rollCheckIntervalMs: number;
  cancelOrdersOnShutdown?: boolean;
  /**
   * Grace window: if shared inputs (gas/collateral) can't be refreshed for
   * longer than this, stop placing new orders (existing orders are left in
   * place). Default 30s.
   */
  sharedStalenessGraceMs?: number;
  dryRun: boolean;

  markets: MarketRuntime[];
  gas: GasTracker;
  collateral: CollateralTracker;
  risk: RiskManager;
  coordinator: TxCoordinator;
  health: PortfolioHealthCheck;
  logger: pino.Logger;

  onRoll?: RollFn;
}

/** Shared dependencies one tick reads/acts on. */
export interface PortfolioTickDeps {
  gas: GasTracker;
  collateral: CollateralTracker;
  risk: RiskManager;
  coordinator: TxCoordinator;
  health: PortfolioHealthCheck;
  logger: pino.Logger;
  dryRun: boolean;
  /** Shared-input staleness grace (ms) before pausing new placements. */
  graceMs: number;
  rollCheckIntervalMs: number;
  onRoll?: RollFn;
}

/** Loop-carried state threaded through successive ticks. */
export interface PortfolioTickState {
  markets: MarketRuntime[];
  lastSharedOkAt: number;
  pauseNew: boolean;
  lastRollAt: number;
}

export interface PortfolioTickResult {
  state: PortfolioTickState;
  /** True when a confirmed portfolio breach forced a full cancel this tick. */
  halted: boolean;
}

/**
 * One iteration of the portfolio loop, extracted so the resilience logic is
 * unit-testable without process signals or an infinite loop. Mutates the
 * shared trackers/health as needed and returns the next loop-carried state.
 *
 * Staging (each stage's failure is contained to its own blast radius):
 *   1. roll — reconcile the futures market set (add/drop expiries).
 *   2. shared inputs (gas/collateral) — on failure past `graceMs`, set
 *      `pauseNew` (stop placing; keep existing orders). Never throws.
 *   3. per-market update — each behind its own circuit breaker.
 *   4. risk gate — only on FRESH shared data; a confirmed breach cancels all
 *      and returns `halted`. Stale data only pauses new placements.
 *   5. plan + submit via the coordinator (aggregate gate + per-venue isolation).
 */
export async function runPortfolioTick(
  now: number,
  deps: PortfolioTickDeps,
  prev: PortfolioTickState,
): Promise<PortfolioTickResult> {
  const { gas, collateral, risk, coordinator, health, logger, dryRun, graceMs } = deps;
  const state: PortfolioTickState = { ...prev };
  // The single error surfaced by THIS tick (shared-input or submit). A tick
  // that ends with this null and fresh inputs is healthy and clears /health.
  let tickError: ErrorInfo | null = null;

  // Stage 1: roll.
  if (deps.onRoll && now - state.lastRollAt > deps.rollCheckIntervalMs) {
    state.lastRollAt = now;
    state.markets = await applyRoll(state.markets, deps.onRoll, logger);
  }

  // Stage 2: shared inputs (gas + collateral; oracles are per-market).
  let sharedOk = true;
  try {
    await gas.update();
    await collateral.update();
    state.lastSharedOkAt = now;
    state.pauseNew = false;
    try {
      await collateral.maybeTopUp();
    } catch (err) {
      logger.error({ err }, "collateral top-up failed");
    }
  } catch (err) {
    sharedOk = false;
    tickError = toErrorInfo(err);
    logger.error({ err }, "shared input update failed");
    if (now - state.lastSharedOkAt > graceMs && !state.pauseNew) {
      state.pauseNew = true;
      logger.warn(
        { staleMs: now - state.lastSharedOkAt },
        "shared inputs stale past grace; pausing new placements (existing orders kept)",
      );
    }
  }

  // Stage 3: per-market update (each isolated by its circuit breaker).
  for (const m of state.markets) await m.update(now);

  // Stage 4: portfolio risk gate — only act on fresh data. A confirmed breach
  // cancels everything; stale data only pauses new placements.
  if (sharedOk) {
    const ok = risk.check();
    if (!ok) {
      health.status = "error";
      health.lastError = risk.haltReason;
      await Promise.all(state.markets.map((m) => m.cancelAll())).catch((err) =>
        logger.error({ err }, "cancelAll after halt failed"),
      );
      return { state, halted: true };
    }
  }

  // Stage 5: plan per market, then submit via the coordinator.
  const intents: MarketIntents[] = [];
  for (const m of state.markets) {
    const p = m.plan(now);
    if (p) intents.push(state.pauseNew ? { ...p, creates: [] } : p);
  }
  const active = intents.filter((i) => i.cancels.length > 0 || i.creates.length > 0);

  if (active.length > 0) {
    const res = await coordinator.submit(active, {
      maxFeePerGas: gas.cappedGasPrice(),
      dryRun,
      canPlace: (im) => collateral.canPlace(im),
    });
    for (const receipt of res.receipts) {
      risk.recordGasCost(gasCostUsd(receipt, gas.ethPriceUsd));
    }
    // Per-market timing bookkeeping (best-effort; failed venues re-plan next
    // tick via the on-chain-diff resync).
    for (const i of active) {
      const m = state.markets.find((mk) => mk.instrument === i.instrument);
      m?.recordRequote(i.creates.length, i.cancels.length);
    }
    if (res.errors.length > 0) tickError = toErrorInfo(res.errors[0]);
  }

  health.status = "running";
  // A tick that saw an error (stale shared inputs or a submit revert) surfaces
  // it; a fully clean tick with fresh inputs clears any stale error so /health
  // recovers even during continuous active quoting.
  if (tickError) health.lastError = tickError;
  else if (sharedOk) health.lastError = null;
  return { state, halted: false };
}

/**
 * Single-process portfolio loop over N markets across venues.
 *
 * Staged so a fault's blast radius matches its domain:
 *   - shared-update stage (gas/collateral): failure → fail-safe pause of new
 *     placements past a grace window; existing orders untouched.
 *   - per-market stage: each market updates its own oracle/book/inventory and
 *     plans behind its own circuit breaker; one market's failure never stops
 *     the others.
 *   - submit stage: intents handed to the TxCoordinator, which isolates venues
 *     and runs the single aggregate pre-trade gate.
 * The loop itself never dies — errors log, back off, and retry.
 */
export async function runPortfolioLoop(opts: PortfolioRunnerOpts): Promise<void> {
  const {
    pollIntervalMs,
    rollCheckIntervalMs,
    dryRun,
    gas,
    collateral,
    risk,
    coordinator,
    health,
    logger,
    onRoll,
  } = opts;
  const cancelOrdersOnShutdown = opts.cancelOrdersOnShutdown ?? true;
  const graceMs = opts.sharedStalenessGraceMs ?? 30_000;
  let markets = [...opts.markets];

  health.markets = () => markets;
  health.onStop = async () => {
    logger.info("stop requested via API, cancelling orders");
    await Promise.all(markets.map((m) => m.cancelAll()));
    for (const m of markets) m.stop();
  };
  health.onStart = async () => {
    logger.info("start requested via API, re-initializing markets");
    await Promise.all(markets.map((m) => m.start()));
  };

  await health.start();

  // ── Bootstrap: shared trackers (retry) + each market (isolated) ──────────
  for (let attempt = 1; ; attempt++) {
    try {
      await gas.update();
      await collateral.update();
      risk.initialize();
      break;
    } catch (err) {
      health.status = "init-error";
      health.lastError = toErrorInfo(err);
      const delay = Math.min(BASE_ERROR_DELAY_MS * 2 ** (attempt - 1), MAX_ERROR_DELAY_MS);
      logger.warn({ err, attempt, retryInMs: delay }, "shared init failed, retrying");
      await sleep(delay);
    }
  }
  // Markets init independently — a bad expiry is quarantined, others proceed.
  await Promise.all(markets.map((m) => m.start()));
  health.status = "running";
  health.lastError = null;
  logger.info({ markets: markets.map((m) => m.id) }, "portfolio init complete");

  // ── Shutdown ─────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ cancelOrdersOnShutdown }, "shutting down…");
    if (cancelOrdersOnShutdown) {
      await Promise.all(markets.map((m) => m.cancelAll())).catch((err) =>
        logger.error({ err }, "failed to cancel orders during shutdown"),
      );
    }
    for (const m of markets) m.stop();
    await health.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // ── Main loop ──────────────────────────────────────────────────────────
  const tickDeps: PortfolioTickDeps = {
    gas,
    collateral,
    risk,
    coordinator,
    health,
    logger,
    dryRun,
    graceMs,
    rollCheckIntervalMs,
    onRoll,
  };
  let consecutiveErrors = 0;
  let state: PortfolioTickState = {
    markets,
    lastSharedOkAt: Date.now(),
    pauseNew: false,
    lastRollAt: 0,
  };

  while (!shuttingDown) {
    if (health.paused) {
      await sleep(pollIntervalMs);
      continue;
    }

    try {
      const result = await runPortfolioTick(Date.now(), tickDeps, state);
      state = result.state;
      markets = state.markets; // keep health.markets() closure in sync
      consecutiveErrors = result.halted ? consecutiveErrors + 1 : 0;
    } catch (err) {
      consecutiveErrors++;
      health.status = "error";
      health.lastError = toErrorInfo(err);
      logger.error({ err }, "tick error");
    }

    await afterTick(health, consecutiveErrors, pollIntervalMs);
  }
}

async function afterTick(
  health: PortfolioHealthCheck,
  consecutiveErrors: number,
  pollIntervalMs = 0,
): Promise<void> {
  health.tickCount++;
  health.lastTickAt = Date.now();
  const delay =
    consecutiveErrors > 0
      ? Math.min(BASE_ERROR_DELAY_MS * 2 ** consecutiveErrors, MAX_ERROR_DELAY_MS)
      : pollIntervalMs;
  if (delay > 0) await sleep(delay);
}

/** Apply a roll: start added markets, cancel+stop removed ones, splice the set. */
export async function applyRoll(
  current: MarketRuntime[],
  onRoll: RollFn,
  logger: pino.Logger,
): Promise<MarketRuntime[]> {
  let next = current;
  try {
    const { add, removeIds } = await onRoll(current);
    if (add.length === 0 && removeIds.length === 0) return current;

    const removeSet = new Set(removeIds);
    const removed = current.filter((m) => removeSet.has(m.id));
    await Promise.all(
      removed.map(async (m) => {
        await m.cancelAll();
        m.stop();
      }),
    );
    await Promise.all(add.map((m) => m.start()));

    next = current.filter((m) => !removeSet.has(m.id)).concat(add);
    logger.info(
      { added: add.map((m) => m.id), removed: [...removeSet] },
      "market set rolled",
    );
  } catch (err) {
    logger.error({ err }, "roll failed; keeping current market set");
  }
  return next;
}

export function gasCostUsd(
  receipt: { gasUsed: bigint; effectiveGasPrice: bigint },
  ethPriceUsd: bigint,
): bigint {
  if (ethPriceUsd === 0n) return 0n;
  return (receipt.gasUsed * receipt.effectiveGasPrice * ethPriceUsd) / 10n ** 18n;
}
