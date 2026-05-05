import type pino from "pino";
import type {
  DesiredQuotes,
  InstrumentAdapter,
  OwnOrder,
  QuoteLevel,
} from "./adapter.ts";
import type { Quoter } from "./quoter.ts";
import type { BookTracker } from "./bookTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import { bigAbs } from "./math.ts";

export interface OrderExecutorConfig {
  /** Skip a requote if elapsed since last < cooldown (ms). */
  requoteCooldownMs: number;
  /** Skip if price drifted < N ticks from last quote mid. */
  requoteThresholdTicks: number;
  /** Override threshold (in ticks) when gas is spiking — quote anyway if drift >= this. */
  urgentRequoteThresholdTicks: number;
  dryRun: boolean;
}

/**
 * Diff desired quotes vs the resting book; cancel + place via venue multicall.
 *
 * Cooldown, threshold, gas-spike deferral, partial-fill top-up are all here.
 * Tx gas cost is reported back to RiskManager for budget enforcement.
 */
export class OrderExecutor {
  readonly stats = { ordersPlaced: 0, ordersCancelled: 0, reconcileCount: 0 };

  private lastRequoteAt = 0;
  private lastQuoteMidPrice = 0n;

  private readonly instrument: InstrumentAdapter;
  private readonly cfg: OrderExecutorConfig;
  private readonly quoter: Quoter;
  private readonly book: BookTracker;
  private readonly gas: GasTracker;
  private readonly risk: RiskManager;
  private readonly oracle: OracleTracker;
  private readonly logger: pino.Logger;

  constructor(
    instrument: InstrumentAdapter,
    cfg: OrderExecutorConfig,
    quoter: Quoter,
    book: BookTracker,
    gas: GasTracker,
    risk: RiskManager,
    oracle: OracleTracker,
    logger: pino.Logger,
  ) {
    this.instrument = instrument;
    this.cfg = cfg;
    this.quoter = quoter;
    this.book = book;
    this.gas = gas;
    this.risk = risk;
    this.oracle = oracle;
    this.logger = logger.child({ component: "executor", instrument: instrument.id });
  }

  async reconcile(desired: DesiredQuotes): Promise<void> {
    if (!this.shouldRequote(desired)) {
      this.logger.debug("requote skipped (within threshold or cooldown)");
      return;
    }

    if (this.gas.isGasSpiking) {
      const drift = this.priceDriftTicks();
      if (drift < this.cfg.urgentRequoteThresholdTicks) {
        this.logger.info(
          {
            drift,
            threshold: this.cfg.urgentRequoteThresholdTicks,
            gasSpike: this.gas.gasSpikePct.toString(),
          },
          "requote skipped: gas spike, drift below urgent threshold",
        );
        return;
      }
      this.logger.warn({ drift }, "proceeding with requote despite gas spike");
    }

    const ordersToCancel = this.findStaleOrders(desired);
    const ordersToPlace = this.findNewOrders(desired);

    if (ordersToCancel.length === 0 && ordersToPlace.length === 0) {
      this.logger.debug("no order changes needed");
      return;
    }

    const calls: `0x${string}`[] = [];
    for (const order of ordersToCancel) {
      calls.push(this.instrument.buildCancelCalldata(order.orderId));
    }
    for (const level of ordersToPlace) {
      calls.push(this.instrument.buildCreateCalldata(level.price, level.quantity));
    }

    if (this.cfg.dryRun) {
      this.logger.info(
        { cancels: ordersToCancel.length, places: ordersToPlace.length },
        "DRY RUN: would send multicall batch",
      );
      return;
    }

    const maxFeePerGas = this.gas.cappedGasPrice();
    try {
      const hash = await this.instrument.venue.multicall(calls, { maxFeePerGas });
      const receipt = await this.instrument.venue.publicClient.waitForTransactionReceipt({ hash });
      const gasCost = this.computeTxGasCost(receipt);
      this.risk.recordGasCost(gasCost);

      this.stats.ordersCancelled += ordersToCancel.length;
      this.stats.ordersPlaced += ordersToPlace.length;

      this.logger.info(
        {
          cancels: ordersToCancel.length,
          places: ordersToPlace.length,
          gas: receipt.gasUsed.toString(),
        },
        "multicall batch executed",
      );
    } catch (err) {
      this.logger.error(
        { cancels: ordersToCancel.length, places: ordersToPlace.length, err },
        "multicall batch failed",
      );
      throw err;
    }

    this.lastRequoteAt = Date.now();
    this.lastQuoteMidPrice = this.oracle.currentPrice;
    this.stats.reconcileCount++;
  }

  async cancelAll(): Promise<void> {
    const orders = [...this.book.ownOrders.values()];
    if (orders.length === 0) return;

    this.logger.warn({ count: orders.length }, "cancelling all orders");
    const calls = orders.map((o) => this.instrument.buildCancelCalldata(o.orderId));

    if (this.cfg.dryRun) {
      this.logger.info({ count: orders.length }, "DRY RUN: would cancel all orders");
      return;
    }

    const maxFeePerGas = this.gas.cappedGasPrice();
    try {
      const hash = await this.instrument.venue.multicall(calls, { maxFeePerGas });
      const receipt = await this.instrument.venue.publicClient.waitForTransactionReceipt({ hash });
      const gasCost = this.computeTxGasCost(receipt);
      this.risk.recordGasCost(gasCost);
      this.stats.ordersCancelled += orders.length;
      this.logger.info(
        { count: orders.length, gas: receipt.gasUsed.toString() },
        "all orders cancelled",
      );
    } catch (err) {
      this.logger.error({ count: orders.length, err }, "cancel-all multicall failed");
      throw err;
    }
  }

  private shouldRequote(desired: DesiredQuotes): boolean {
    if (Date.now() - this.lastRequoteAt < this.effectiveCooldownMs()) return false;

    const expectedCount = desired.bids.length + desired.asks.length;
    if (this.book.ownOrders.size < expectedCount) return true;
    if (this.hasQuantityDeficit(desired)) return true;

    return this.priceDriftTicks() >= this.effectiveRequoteThreshold();
  }

  private priceDriftTicks(): number {
    if (this.lastQuoteMidPrice === 0n) return Number.POSITIVE_INFINITY;
    const tick = this.quoter.getTick();
    if (tick === 0n) return 0;
    const diff = bigAbs(this.oracle.currentPrice - this.lastQuoteMidPrice);
    return Number(diff / tick);
  }

  private effectiveCooldownMs(): number {
    return this.risk.throttled ? this.cfg.requoteCooldownMs * 3 : this.cfg.requoteCooldownMs;
  }

  private effectiveRequoteThreshold(): number {
    return this.risk.throttled ? this.cfg.requoteThresholdTicks * 2 : this.cfg.requoteThresholdTicks;
  }

  private findStaleOrders(desired: DesiredQuotes): OwnOrder[] {
    const desiredPrices = new Set<bigint>();
    for (const b of desired.bids) desiredPrices.add(b.price);
    for (const a of desired.asks) desiredPrices.add(a.price);
    const stale: OwnOrder[] = [];
    for (const order of this.book.ownOrders.values()) {
      if (!desiredPrices.has(order.price)) stale.push(order);
    }
    return stale;
  }

  private findNewOrders(desired: DesiredQuotes): QuoteLevel[] {
    const existing = this.aggregateOwnQuantityByPrice();
    const out: QuoteLevel[] = [];
    for (const b of desired.bids) {
      const have = existing.get(b.price) ?? 0n;
      const deficit = b.quantity - have;
      if (deficit > 0n) out.push({ price: b.price, quantity: deficit });
    }
    for (const a of desired.asks) {
      const have = existing.get(a.price) ?? 0n;
      const deficit = a.quantity - have;
      if (deficit < 0n) out.push({ price: a.price, quantity: deficit });
    }
    return out;
  }

  private hasQuantityDeficit(desired: DesiredQuotes): boolean {
    const existing = this.aggregateOwnQuantityByPrice();
    for (const b of desired.bids) {
      const have = existing.get(b.price);
      if (have !== undefined && b.quantity - have > 0n) return true;
    }
    for (const a of desired.asks) {
      const have = existing.get(a.price);
      if (have !== undefined && a.quantity - have < 0n) return true;
    }
    return false;
  }

  private aggregateOwnQuantityByPrice(): Map<bigint, bigint> {
    const m = new Map<bigint, bigint>();
    for (const o of this.book.ownOrders.values()) {
      m.set(o.price, (m.get(o.price) ?? 0n) + o.quantity);
    }
    return m;
  }

  private computeTxGasCost(receipt: { gasUsed: bigint; effectiveGasPrice: bigint }): bigint {
    if (this.gas.ethPriceUsd === 0n) return 0n;
    return (receipt.gasUsed * receipt.effectiveGasPrice * this.gas.ethPriceUsd) / 10n ** 18n;
  }
}
