import type pino from "pino";
import type Fraction from "fraction.js";
import type { InstrumentAdapter } from "./adapter.ts";
import type { BookTracker } from "./bookTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type { Quoter } from "./quoter.ts";
import type { OrderExecutor } from "./orderExecutor.ts";
import type { MarketIntents } from "./txCoordinator.ts";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuitBreaker.ts";
import { toErrorInfo } from "./errSerializer.ts";
import type { ErrorInfo } from "./errors.ts";

export interface MarketRuntimeDeps {
  instrument: InstrumentAdapter;
  oracle: OracleTracker;
  book: BookTracker;
  inventory: InventoryManager;
  quoter: Quoter;
  executor: OrderExecutor;
  breaker?: CircuitBreakerConfig;
  logger: pino.Logger;
}

/**
 * One quoting unit (perps, or a single futures expiry) bundling its book,
 * inventory, quoter, and executor behind a circuit breaker. Every on-chain
 * touch is guarded so a fault in this market is recorded and skipped without
 * disturbing sibling markets. Planning is decoupled from submission: `plan()`
 * yields `MarketIntents` for the shared `TxCoordinator`.
 */
export class MarketRuntime {
  readonly instrument: InstrumentAdapter;
  readonly oracle: OracleTracker;
  readonly book: BookTracker;
  readonly inventory: InventoryManager;
  readonly quoter: Quoter;
  readonly executor: OrderExecutor;
  readonly breaker: CircuitBreaker;

  private readonly logger: pino.Logger;
  private initialized = false;

  constructor(deps: MarketRuntimeDeps) {
    this.instrument = deps.instrument;
    this.oracle = deps.oracle;
    this.book = deps.book;
    this.inventory = deps.inventory;
    this.quoter = deps.quoter;
    this.executor = deps.executor;
    this.breaker = new CircuitBreaker(deps.breaker);
    this.logger = deps.logger.child({ component: "market", instrument: deps.instrument.id });
  }

  get id(): string {
    return this.instrument.id;
  }

  /**
   * Initialize this market (own-order bootstrap, book start, quoter init).
   * On failure the market is quarantined but the error is swallowed so the
   * process can still start with healthy markets. Returns whether init
   * succeeded.
   */
  async start(): Promise<boolean> {
    try {
      await this.oracle.initialize();
      await this.instrument.ownOrders.bootstrap();
      await this.book.start();
      await this.quoter.initialize();
      this.breaker.recordSuccess();
      this.initialized = true;
      this.logger.info("market initialized");
      return true;
    } catch (err) {
      this.breaker.recordError(err);
      this.logger.error({ err }, "market init failed; quarantined");
      return false;
    }
  }

  /** Refresh book + inventory. Guarded by the circuit breaker. */
  async update(now: number = Date.now()): Promise<void> {
    if (!this.breaker.canAttempt(now)) return;
    try {
      // Late init for markets that were quarantined at startup.
      if (!this.initialized) {
        await this.oracle.initialize();
        await this.instrument.ownOrders.bootstrap();
        await this.book.start();
        await this.quoter.initialize();
        this.initialized = true;
      }
      await this.oracle.update();
      await this.book.refresh();
      await this.inventory.update();
      this.breaker.recordSuccess();
    } catch (err) {
      this.breaker.recordError(err, now);
      this.logger.error(
        { err, state: this.breaker.state, consecutive: this.breaker.consecutiveErrors },
        "market update failed",
      );
    }
  }

  /**
   * Compute this market's desired quotes and diff them against resting orders.
   * Returns `null` when the market is quarantined, uninitialized, or no
   * requote is warranted this cycle. Never throws.
   */
  plan(now: number = Date.now()): MarketIntents | null {
    if (!this.initialized || !this.breaker.canAttempt(now)) return null;
    try {
      const desired = this.quoter.computeQuotes();
      const planned = this.executor.plan(desired);
      if (!planned) return null;
      return {
        instrument: this.instrument,
        cancels: planned.cancels.map((o) => ({ orderId: o.orderId })),
        creates: planned.creates,
      };
    } catch (err) {
      this.breaker.recordError(err, now);
      this.logger.error({ err }, "market plan failed");
      return null;
    }
  }

  /** Bookkeeping after a successful submission for this market. */
  recordRequote(placed: number, cancelled: number): void {
    this.executor.recordRequote(placed, cancelled);
  }

  /** Cancel every resting order for this market (shutdown / quarantine). */
  async cancelAll(): Promise<void> {
    try {
      await this.executor.cancelAll();
    } catch (err) {
      this.logger.error({ err }, "cancelAll failed");
    }
  }

  stop(): void {
    this.book.stop();
  }

  /** Snapshot for /health. */
  healthState(): {
    id: string;
    breaker: string;
    consecutiveErrors: number;
    lastError: ErrorInfo | null;
    oraclePrice: string;
    volatilityPerSecond: number;
    netPosition: string;
    bestBid: string;
    bestAsk: string;
    ownOrders: number;
  } {
    return {
      id: this.id,
      breaker: this.breaker.state,
      consecutiveErrors: this.breaker.consecutiveErrors,
      lastError: this.breaker.lastError ? toErrorInfo(this.breaker.lastError) : null,
      oraclePrice: this.oracle.currentPrice.toString(),
      volatilityPerSecond: fractionToNumber(this.oracle.volatilityPerSecond),
      netPosition: this.inventory.netQuantity.toString(),
      bestBid: this.book.bestBid.toString(),
      bestAsk: this.book.bestAsk.toString(),
      ownOrders: this.book.ownOrders.size,
    };
  }
}

function fractionToNumber(value: Fraction): number {
  const v = value.simplify(1e-12);
  return (Number(v.s) * Number(v.n)) / Number(v.d);
}
