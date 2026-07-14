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
 * Stale-order detection is matching-mode-aware:
 *   - "exact" (futures): a resting order is stale iff its price is not in the
 *     desired set (each level only matches at exactly its price).
 *   - "limit" (perps):   a resting buy is stale iff its price < worst desired
 *     bid; a resting sell is stale iff its price > worst desired ask. Orders
 *     better-than-the-grid are kept (better priority + better price).
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
    const creates = this.findNewOrders(desired);
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

    // `ownOrders.size` counts individual resting orders. On exact-matching
    // venues (futures) a single createOrder(qty=N) rests as N distinct orders,
    // so the comparable "expected" is the qty-expanded total, not the level
    // count — otherwise this fast-path is dead (actual is always ≫ levels) and
    // the log is misleading. Limit venues (perps) rest one order per level.
    const expectedCount =
      this.instrument.book.matchingMode === "exact"
        ? desired.reduce((sum, i) => sum + Number(i.size), 0)
        : desired.length;
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

    if (this.hasStaleOrders(desired)) {
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

  /** True when any own order sits at a price not in the desired set. */
  private hasStaleOrders(desired: OrderIntent[]): boolean {
    const desiredPrices = new Map<string, Set<bigint>>();
    for (const i of desired) {
      let set = desiredPrices.get(i.side);
      if (!set) {
        set = new Set<bigint>();
        desiredPrices.set(i.side, set);
      }
      set.add(i.price);
    }
    for (const order of this.book.ownOrders.values()) {
      const set = desiredPrices.get(order.side);
      if (!set || !set.has(order.price)) return true;
    }
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
   * Stale = should be cancelled. See class header for matching-mode rules.
   */
  private findStaleOrders(desired: OrderIntent[]): OwnOrder[] {
    const mode = this.instrument.book.matchingMode;
    if (mode === "exact") return this.findStaleOrdersExact(desired);
    return this.findStaleOrdersLimit(desired);
  }

  private findStaleOrdersExact(desired: OrderIntent[]): OwnOrder[] {
    const desiredBidPrices = new Set<bigint>();
    const desiredAskPrices = new Set<bigint>();
    for (const i of desired) {
      (i.side === "buy" ? desiredBidPrices : desiredAskPrices).add(i.price);
    }
    const stale: OwnOrder[] = [];
    for (const order of this.book.ownOrders.values()) {
      const set = order.side === "buy" ? desiredBidPrices : desiredAskPrices;
      if (!set.has(order.price)) stale.push(order);
    }
    return stale;
  }

  private findStaleOrdersLimit(desired: OrderIntent[]): OwnOrder[] {
    // For limit-mode, keep any resting order that is at-least-as-aggressive as
    // the worst desired price for that side. "Aggressive" means a higher price
    // for buys and a lower price for sells.
    let worstDesiredBid: bigint | undefined;
    let worstDesiredAsk: bigint | undefined;
    for (const i of desired) {
      if (i.side === "buy") {
        if (worstDesiredBid === undefined || i.price < worstDesiredBid)
          worstDesiredBid = i.price;
      } else {
        if (worstDesiredAsk === undefined || i.price > worstDesiredAsk)
          worstDesiredAsk = i.price;
      }
    }
    const stale: OwnOrder[] = [];
    for (const order of this.book.ownOrders.values()) {
      if (order.side === "buy") {
        if (worstDesiredBid === undefined || order.price < worstDesiredBid) {
          stale.push(order);
        }
      } else {
        if (worstDesiredAsk === undefined || order.price > worstDesiredAsk) {
          stale.push(order);
        }
      }
    }
    return stale;
  }

  /**
   * New orders = desired levels that are missing from the resting book at
   * exactly the desired price (regardless of matching mode). Limit mode's
   * "we have an even better resting order" case is covered by the deficit
   * check returning 0 for that level, so we don't double-place.
   */
  private findNewOrders(desired: OrderIntent[]): OrderIntent[] {
    const existing = this.aggregateOwnSizeByPriceSide();
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

  private aggregateOwnSizeByPriceSide(): Map<string, bigint> {
    const m = new Map<string, bigint>();
    for (const o of this.book.ownOrders.values()) {
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
