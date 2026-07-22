import type pino from "pino";
import type {
  InstrumentAdapter,
  OrderIntent,
  OwnOrder,
  ReduceIntent,
  Side,
} from "./adapter.ts";
import type { Quoter } from "./quoter.ts";
import type { BookTracker } from "./bookTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import { bigAbs, notionalToSize } from "./math.ts";

export interface OrderExecutorConfig {
  /** Skip a requote if elapsed since last < cooldown (ms). */
  requoteCooldownMs: number;
  /** During a gas spike, proceed only if mid drift (ticks) is at least this. */
  urgentRequoteThresholdTicks: number;
  /**
   * Price-unit allowance outside the worst desired bid/ask that still counts as
   * in-band (kept). Same decimals as book/oracle prices (typically 6dp USD).
   * `0n` = strict worst-desired edge.
   */
  staleBandAllowance: bigint;
  /**
   * On-grid size allowance in USD notional (both reduce and top-up). Converted
   * to venue-native size at the level price via {@link notionalToSize}
   * (rounded nearest) and compared to `|have − want|`. Deltas at or below that
   * qty are ignored. `0n` = exact size match required.
   */
  staleSizeAllowance: bigint;
  /**
   * Divisor in `notional = price × size / quantityScale`.
   * Perps: `QUANTITY_SCALE` (1e6). Futures: `1n` (whole contracts).
   */
  quantityScale: bigint;
  dryRun: boolean;
}

/**
 * Diff desired quotes vs the resting book; cancel + place via venue multicall.
 *
 * Stale-order detection (limit LOB + USD allowance): a resting buy is stale
 * iff its price is below `worstDesiredBid − staleBandAllowance`; a resting
 * sell is stale iff above `worstDesiredAsk + staleBandAllowance`. Orders
 * inside that keep zone (including better-than-grid leftovers) are kept.
 * On-grid size is reconciled (reduce / top-up) only when the size delta
 * exceeds the USD size allowance converted to native qty (nearest unit).
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
   * Compute the diff (cancels / in-place reduces / creates) for `desired`
   * without submitting. Returns `null` when no requote should happen this
   * cycle. Size increases create only the delta; size decreases prefer
   * reduce-only amend (FIFO kept) over cancel+recreate.
   */
  plan(desired: OrderIntent[]): {
    cancels: OwnOrder[];
    reduces: ReduceIntent[];
    creates: OrderIntent[];
  } | null {
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

    const { cancels, reduces } = this.findStaleOrders(desired);
    const creates = this.findNewOrders(desired, cancels, reduces);
    if (cancels.length === 0 && reduces.length === 0 && creates.length === 0) {
      this.logger.debug("no order changes needed");
      return null;
    }
    return { cancels, reduces, creates };
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

    if (ordersToCancel.length === 0 && planned.reduces.length === 0 && places.length === 0) {
      return;
    }

    const result = await this.instrument.executeOrders({
      cancels: ordersToCancel.map((o) => ({ orderId: o.orderId })),
      reduces: planned.reduces,
      creates: places,
      maxFeePerGas: this.gas.cappedGasPrice(),
      dryRun: this.cfg.dryRun,
    });

    for (const receipt of result.receipts) {
      this.risk.recordGasCost(this.computeTxGasCost(receipt));
    }

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

    const stale = this.findStaleOrders(desired);
    if (stale.cancels.length > 0 || stale.reduces.length > 0) {
      this.logger.debug("requote triggered: stale / excess size at level");
      return true;
    }

    this.logger.debug(
      { actualCount, expectedCount },
      "requote skipped: no deficit / no stale",
    );
    return false;
  }

  /** Oracle mid drift in ticks since the last successful requote (gas-spike gate). */
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

  /**
   * Cancel / reduce targets against `desired`:
   *   - outside the keep zone (worst desired ± staleBandAllowance) → cancel
   *   - at desired prices with excess notional above threshold: reduce the
   *     trailing order in place when possible (FIFO kept); cancel whole
   *     trailing orders otherwise
   *   - better leftovers / within-allowance off-grid → keep
   */
  private findStaleOrders(desired: OrderIntent[]): {
    cancels: OwnOrder[];
    reduces: ReduceIntent[];
  } {
    let worstDesiredBid: bigint | undefined;
    let worstDesiredAsk: bigint | undefined;
    const desiredSize = new Map<string, bigint>();
    for (const i of desired) {
      const k = keyOf(i.side, i.price);
      desiredSize.set(k, (desiredSize.get(k) ?? 0n) + i.size);
      if (i.side === "buy") {
        if (worstDesiredBid === undefined || i.price < worstDesiredBid) {
          worstDesiredBid = i.price;
        }
      } else if (worstDesiredAsk === undefined || i.price > worstDesiredAsk) {
        worstDesiredAsk = i.price;
      }
    }

    const allowance = this.cfg.staleBandAllowance;
    const cancels: OwnOrder[] = [];
    const reduces: ReduceIntent[] = [];
    const byKey = new Map<string, OwnOrder[]>();

    for (const order of this.book.ownOrders.values()) {
      if (order.side === "buy") {
        // price + allowance < worst avoids bigint underflow when allowance > price.
        if (
          worstDesiredBid === undefined ||
          order.price + allowance < worstDesiredBid
        ) {
          cancels.push(order);
          continue;
        }
      } else if (
        worstDesiredAsk === undefined ||
        order.price > worstDesiredAsk + allowance
      ) {
        cancels.push(order);
        continue;
      }

      const k = keyOf(order.side, order.price);
      const list = byKey.get(k);
      if (list) list.push(order);
      else byKey.set(k, [order]);
    }

    for (const [k, orders] of byKey) {
      const want = desiredSize.get(k);
      // Off-grid but inside keep zone (better leftover / within-allowance) → keep.
      if (want === undefined) continue;

      let have = 0n;
      for (const o of orders) have += o.size;
      if (have <= want) continue;
      let excess = have - want;
      // Same USD size allowance as top-ups — leave dust oversizing alone.
      if (!this.sizeDeltaAboveThreshold(orders[0].price, excess)) continue;
      // Trim from the trailing order so earlier FIFO priority is preserved.
      for (let i = orders.length - 1; i >= 0 && excess > 0n; i--) {
        const o = orders[i];
        if (o.size <= excess) {
          cancels.push(o);
          excess -= o.size;
        } else {
          reduces.push({
            orderId: o.orderId,
            newSize: o.size - excess,
            side: o.side,
          });
          excess = 0n;
        }
      }
    }
    return { cancels, reduces };
  }

  /**
   * New orders = desired levels missing size at exactly the desired price,
   * after applying cancels/reduces from this plan. Size increases only create
   * the delta — resting orders at that level are never cancelled for a top-up.
   * Dust deficits (within staleSizeAllowance) are ignored.
   */
  private findNewOrders(
    desired: OrderIntent[],
    cancels: OwnOrder[],
    reduces: ReduceIntent[],
  ): OrderIntent[] {
    const existing = this.aggregateOwnSizeByPriceSide(cancels, reduces);
    const out: OrderIntent[] = [];
    for (const i of desired) {
      const have = existing.get(keyOf(i.side, i.price)) ?? 0n;
      const deficit = i.size - have;
      if (deficit > 0n && this.sizeDeltaAboveThreshold(i.price, deficit)) {
        out.push({ side: i.side, price: i.price, size: deficit });
      }
    }
    return out;
  }

  private hasQuantityDeficit(desired: OrderIntent[]): boolean {
    const existing = this.aggregateOwnSizeByPriceSide();
    for (const i of desired) {
      const have = existing.get(keyOf(i.side, i.price)) ?? 0n;
      const deficit = i.size - have;
      if (deficit > 0n && this.sizeDeltaAboveThreshold(i.price, deficit)) {
        return true;
      }
    }
    return false;
  }

  /**
   * True when `delta` exceeds the USD size allowance converted to venue-native
   * qty at `price` (nearest unit). Futures (`quantityScale = 1`) rounds to
   * whole contracts; perps uses 1e6 scale.
   */
  private sizeDeltaAboveThreshold(price: bigint, delta: bigint): boolean {
    const allowanceQty = notionalToSize(
      price,
      this.cfg.staleSizeAllowance,
      this.cfg.quantityScale,
    );
    return delta > allowanceQty;
  }

  private aggregateOwnSizeByPriceSide(
    cancels: OwnOrder[] = [],
    reduces: ReduceIntent[] = [],
  ): Map<string, bigint> {
    const cancelled = new Set(cancels.map((c) => c.orderId));
    const reduced = new Map(reduces.map((r) => [r.orderId, r.newSize]));
    const m = new Map<string, bigint>();
    for (const o of this.book.ownOrders.values()) {
      if (cancelled.has(o.orderId)) continue;
      const size = reduced.get(o.orderId) ?? o.size;
      const k = keyOf(o.side, o.price);
      m.set(k, (m.get(k) ?? 0n) + size);
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
