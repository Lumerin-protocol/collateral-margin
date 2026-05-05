import type pino from "pino";
import type { CollateralTracker } from "./collateralTracker.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { BookTracker } from "./bookTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { RiskManager } from "./riskManager.ts";
import type { Quoter } from "./quoter.ts";
import type { OrderExecutor } from "./orderExecutor.ts";
import type { HealthCheck } from "./healthcheck.ts";
import type { InstrumentAdapter } from "./adapter.ts";
import { toErrorInfo } from "./errSerializer.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE_ERROR_DELAY_MS = 5_000;
const MAX_ERROR_DELAY_MS = 3 * 60_000;

export interface RunnerOpts {
  pollIntervalMs: number;
  instrument: InstrumentAdapter;
  oracle: OracleTracker;
  gas: GasTracker;
  book: BookTracker;
  inventory: InventoryManager;
  collateral: CollateralTracker;
  risk: RiskManager;
  quoter: Quoter;
  executor: OrderExecutor;
  health: HealthCheck;
  logger: pino.Logger;
}

/**
 * Boots the trackers (with retry/backoff) and then runs the per-tick loop:
 *
 *   1. update oracle / gas / book / inventory / collateral
 *   2. optionally auto-deposit wallet collateral into the vault
 *   3. risk.check() — if not ok, cancelAll and skip
 *   4. quoter.computeQuotes() → executor.reconcile(desired)
 *
 * `executor.reconcile` itself runs the engine pre-trade gate via
 * `risk.canPlaceOrders`, so the runner doesn't need to do it explicitly.
 *
 * Two backoff regimes:
 *   - Initialization: exponential backoff from BASE_ERROR_DELAY_MS up to MAX.
 *   - Steady state: same exponential backoff after each tick error, reset on
 *     successful tick.
 */
export async function runMakerLoop(opts: RunnerOpts): Promise<void> {
  const { pollIntervalMs, instrument, oracle, gas, book, inventory, collateral, risk, quoter, executor, health, logger } = opts;
  const mmAddress = instrument.venue.wallet.account.address;

  health.executorStats = executor.stats;
  health.walletAddress = mmAddress;

  health.onStop = async () => {
    logger.info("stop requested via API, cancelling orders");
    await executor.cancelAll();
    book.stop();
  };
  health.onStart = async () => {
    logger.info("start requested via API, re-initializing");
    await book.start();
    await oracle.update();
    await gas.update();
    await inventory.update();
    await collateral.update();
  };

  await health.start();

  for (let attempt = 1; ; attempt++) {
    try {
      await quoter.initialize();
      await gas.calibrate(() => instrument.estimateCreateGas(mmAddress));
      await book.start();
      await oracle.update();
      await gas.update();
      await inventory.update();
      await collateral.update();
      risk.initialize();
      health.status = "running";
      health.lastError = null;
      break;
    } catch (err) {
      health.status = "init-error";
      health.lastError = toErrorInfo(err);
      const delay = Math.min(BASE_ERROR_DELAY_MS * 2 ** (attempt - 1), MAX_ERROR_DELAY_MS);
      logger.warn({ err, attempt, retryInMs: delay }, "initialization failed, retrying");
      await sleep(delay);
    }
  }

  logger.info("initialization complete, entering main loop");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down…");
    try {
      await executor.cancelAll();
    } catch (err) {
      logger.error({ err }, "failed to cancel orders during shutdown");
    }
    book.stop();
    await health.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  let consecutiveErrors = 0;
  while (!shuttingDown) {
    if (health.paused) {
      await sleep(pollIntervalMs);
      continue;
    }

    try {
      await oracle.update();
      await gas.update();
      await book.refresh();
      await inventory.update();
      await collateral.update();

      try {
        await collateral.maybeTopUp();
      } catch (err) {
        health.status = "error";
        health.lastError = toErrorInfo(err);
        logger.error({ err }, "failed to top up collateral");
      }

      logger.info(
        {
          oracle: oracle.currentPrice.toString(),
          bid: book.bestBid.toString(),
          ask: book.bestAsk.toString(),
          pos: inventory.netQuantity.toString(),
          vaultBalance: collateral.vaultBalance.toString(),
          orders: book.ownOrders.size,
        },
        "tick",
      );

      const ok = risk.check();
      if (!ok) {
        health.status = "error";
        health.lastError = risk.haltReason;
        consecutiveErrors++;
        try {
          await executor.cancelAll();
        } catch (err) {
          health.lastError = toErrorInfo(err);
          logger.error({ err }, "failed to cancel orders after risk halt");
        }
      } else {
        const desired = quoter.computeQuotes();
        await executor.reconcile(desired);
        health.status = "running";
        health.lastError = null;
        consecutiveErrors = 0;
      }
    } catch (err) {
      consecutiveErrors++;
      health.status = "error";
      health.lastError = toErrorInfo(err);
      logger.error({ err }, "tick error");
    }

    health.tickCount++;
    health.lastTickAt = Date.now();
    const delay =
      consecutiveErrors > 0
        ? Math.min(BASE_ERROR_DELAY_MS * 2 ** consecutiveErrors, MAX_ERROR_DELAY_MS)
        : pollIntervalMs;
    await sleep(delay);
  }
}
