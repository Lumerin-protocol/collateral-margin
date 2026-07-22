import type pino from "pino";
import type {
  InstrumentAdapter,
  OrderIntent,
  OwnOrder,
  Side,
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
 * Exact set-diff (limit LOB): cancel resting orders whose (side, price) is not
 * in the desired grid, or that contribute excess size at a desired price;
 * create only size deficits at desired prices. The resting book is driven to
 * match the quote grid — no band-based “keep better leftovers” policy.
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
    this.logger = logger.child({
      component: "executor",
      instrument: instrument.id,
    });
  }

  /**
   * Compute the diff (stale cancels + missing creates) for `desired` without
   * submitting anything. Returns `null` when no requote should happen this
   * cycle (cooldown, no drift, or gas-spike deferral). The portfolio runner
   * feeds the returned intents to the shared `TxCoordinator`, which runs the
   * aggregate pre-trade gate — so `plan()` deliberately does NOT call
   * `canPlaceOrders` (that would under-count across markets).
   */
  plan(desired: OrderIntent[]): { cancels: OwnOrder[]; creates: OrderIntent[] } | null {
    if (!this.shouldRequote(desired)) return null;

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
        return null;
      }
      this.logger.warn({ drift }, "proceeding with requote despite gas spike");
    }

    const cancels = this.findStaleOrders(desired);
    const creates = this.findNewOrders(desired, cancels);
    if (cancels.length === 0 && creates.length === 0) {
      this.logger.debug("no order changes needed");
      return null;
    }
    return { cancels, creates };
  }

  /**
   * Update timing/stat bookkeeping after a submission (whether via this
   * executor's own `reconcile` or the shared coordinator). Idempotent within a
   * cycle; safe to call once per successful submit.
   */
  recordRequote(placed: number, cancelled: number): void {
    this.stats.ordersCancelled += cancelled;
    this.stats.ordersPlaced += placed;
    this.lastRequoteAt = Date.now();
    this.lastQuoteMidPrice = this.oracle.currentPrice;
    this.stats.reconcileCount++;
  }

  async reconcile(desired: OrderIntent[]): Promise<void> {
    const planned = this.plan(desired);
    if (!planned) return;
    const ordersToCancel = planned.cancels;
    const ordersToPlace = planned.creates;

    // Pre-trade engine gate: ask whether the new orders' total IM still fits
    // the wallet's portfolio IM budget. If not, only cancel; don't add risk.
    const placeAllowed = await this.risk.canPlaceOrders(
      ordersToPlace,
      this.instrument,
    );
    const places = placeAllowed ? ordersToPlace : [];
    if (!placeAllowed) {
      this.logger.warn(
        { wouldPlace: ordersToPlace.length },
        "engine.canPlaceOrder denied placements; cancelling stale only",
      );
    }

    if (ordersToCancel.length === 0 && places.length === 0) {
      return;
    }

    // Delegate full lifecycle to the adapter: encoding, batching, tx chunking,
    // nonce sequencing, gas optimisation. The executor no longer leaks multicall
    // details — it just says what to do and gets back what happened.
    const result = await this.instrument.executeOrders({
      cancels: ordersToCancel.map((o) => ({ orderId: o.orderId })),
      creates: places,
      maxFeePerGas: this.gas.cappedGasPrice(),
      dryRun: this.cfg.dryRun,
    });

    // Record gas cost from successful tx chunks.
    for (const receipt of result.receipts) {
      this.risk.recordGasCost(this.computeTxGasCost(receipt));
    }

    // Stats count intended orders; partial failure undercounts but metrics
    // remain directionally correct (next reconciliation retries the remainder).
    this.stats.ordersCancelled += ordersToCancel.length;
    this.stats.ordersPlaced += places.length;

    this.lastRequoteAt = Date.now();
    this.lastQuoteMidPrice = this.oracle.currentPrice;
    this.stats.reconcileCount++;
  }

  async cancelAll(): Promise<void> {
    const orders = [...this.book.ownOrders.values()];
    if (orders.length === 0) return;

    this.logger.warn({ count: orders.length }, "cancelling all orders");

    const result = await this.instrument.executeOrders({
      cancels: orders.map((o) => ({ orderId: o.orderId })),
      creates: [],
      maxFeePerGas: this.gas.cappedGasPrice(),
      dryRun: this.cfg.dryRun,
    });

    // Record gas cost from successful tx chunks.
    for (const receipt of result.receipts) {
      this.risk.recordGasCost(this.computeTxGasCost(receipt));
    }

    this.stats.ordersCancelled += orders.length;
  }

  /**
   * Decide whether to run a reconciliation (cancel stale + place missing).
   * Logs the reason at debug level so operators can diagnose stale orderbooks.
   */
  private shouldRequote(desired: OrderIntent[]): boolean {
    const elapsed = Date.now() - this.lastRequoteAt;
    const cooldownMs = this.effectiveCooldownMs();
    if (elapsed < cooldownMs) {
      this.logger.debug(
        { elapsedMs: elapsed, cooldownMs },
        "requote skipped: cooldown",
      );
      return false;
    }

    // One qty-bearing resting order per desired level (perps + futures LOB).
    const expectedCount = desired.length;
    const actualCount = this.book.ownOrders.size;
    if (actualCount < expectedCount) {
      this.logger.debug(
        { actualCount, expectedCount },
        "requote triggered: order count deficit",
      );
      return true;
    }

    if (this.hasQuantityDeficit(desired)) {
      this.logger.debug("requote triggered: quantity deficit");
      return true;
    }

    if (this.findStaleOrders(desired).length > 0) {
      this.logger.debug("requote triggered: stale orders at wrong prices");
      return true;
    }

    const drift = this.priceDriftTicks();
    const threshold = this.effectiveRequoteThreshold();
    if (drift >= threshold) {
      this.logger.debug({ drift, threshold }, "requote triggered: price drift");
      return true;
    }

    this.logger.debug(
      { drift, threshold, actualCount, expectedCount },
      "requote skipped: no deficit / no stale / no drift",
    );
    return false;
  }

  private priceDriftTicks(): number {
    if (this.lastQuoteMidPrice === 0n) return Number.POSITIVE_INFINITY;
    const tick = this.quoter.getTick();
    if (tick === 0n) return 0;
    const diff = bigAbs(this.oracle.currentPrice - this.lastQuoteMidPrice);
    return Number(diff / tick);
  }

  private effectiveCooldownMs(): number {
    return this.risk.throttled
      ? this.cfg.requoteCooldownMs * 3
      : this.cfg.requoteCooldownMs;
  }

  private effectiveRequoteThreshold(): number {
    return this.risk.throttled
      ? this.cfg.requoteThresholdTicks * 2
      : this.cfg.requoteThresholdTicks;
  }

  /**
   * Cancel targets for an exact set-diff against `desired`:
   *   - every resting order at a (side, price) not in the desired grid
   *   - at desired prices, enough whole orders that aggregated size exceeds
   *     desired (cancel until remaining ≤ desired; deficits are topped up
   *     by `findNewOrders`)
   */
  private findStaleOrders(desired: OrderIntent[]): OwnOrder[] {
    const desiredSize = new Map<string, bigint>();
    for (const i of desired) {
      const k = keyOf(i.side, i.price);
      desiredSize.set(k, (desiredSize.get(k) ?? 0n) + i.size);
    }

    const byKey = new Map<string, OwnOrder[]>();
    for (const order of this.book.ownOrders.values()) {
      const k = keyOf(order.side, order.price);
      const list = byKey.get(k);
      if (list) list.push(order);
      else byKey.set(k, [order]);
    }

    const stale: OwnOrder[] = [];
    for (const [k, orders] of byKey) {
      const want = desiredSize.get(k);
      if (want === undefined) {
        for (const o of orders) stale.push(o);
        continue;
      }
      let have = 0n;
      for (const o of orders) have += o.size;
      if (have <= want) continue;
      // Drop whole orders until remaining size fits; prefer cancelling the
      // trailing entries so FIFO priority of earlier quotes is preserved.
      let excess = have - want;
      for (let i = orders.length - 1; i >= 0 && excess > 0n; i--) {
        stale.push(orders[i]);
        excess -= orders[i].size;
      }
    }
    return stale;
  }

  /**
   * New orders = desired levels missing size at exactly the desired price,
   * after subtracting any orders already selected for cancel in this plan.
   */
  private findNewOrders(desired: OrderIntent[], cancels: OwnOrder[]): OrderIntent[] {
    const existing = this.aggregateOwnSizeByPriceSide(cancels);
    const out: OrderIntent[] = [];
    for (const i of desired) {
      const have = existing.get(keyOf(i.side, i.price)) ?? 0n;
      const deficit = i.size - have;
      if (deficit > 0n) {
        out.push({ side: i.side, price: i.price, size: deficit });
      }
    }
    return out;
  }

  private hasQuantityDeficit(desired: OrderIntent[]): boolean {
    const existing = this.aggregateOwnSizeByPriceSide();
    for (const i of desired) {
      const have = existing.get(keyOf(i.side, i.price));
      // Deficit means: no orders at this price at all, OR fewer than desired.
      // The `undefined` branch catches stale orders at wrong prices that the
      // other guards (count, price-drift) would also miss.
      if (have === undefined || i.size - have > 0n) return true;
    }
    return false;
  }

  private aggregateOwnSizeByPriceSide(cancels: OwnOrder[] = []): Map<string, bigint> {
    const cancelled = new Set(cancels.map((c) => c.orderId));
    const m = new Map<string, bigint>();
    for (const o of this.book.ownOrders.values()) {
      if (cancelled.has(o.orderId)) continue;
      const k = keyOf(o.side, o.price);
      m.set(k, (m.get(k) ?? 0n) + o.size);
    }
    return m;
  }

  /**
   * Compute USD-denominated gas cost from a receipt.
   */
  private computeTxGasCost(receipt: {
    gasUsed: bigint;
    effectiveGasPrice: bigint;
  }): bigint {
    if (this.gas.ethPriceUsd === 0n) return 0n;
    return (
      (receipt.gasUsed * receipt.effectiveGasPrice * this.gas.ethPriceUsd) /
      10n ** 18n
    );
  }
}

function keyOf(side: Side, price: bigint): string {
  return `${side}@${price.toString()}`;
}
