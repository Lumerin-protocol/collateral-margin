/**
 * # RiskManager
 *
 * MM-side risk gating. Three responsibilities:
 *
 *   1. Halt — stop quoting and cancel all orders. Conditions: portfolio MM
 *      breach, daily loss limit, minimum collateral floor.
 *   2. Throttle — slow down quoting (longer cooldown, wider requote threshold).
 *      Conditions: hourly/daily gas budget exceeded.
 *   3. Side gating — refuse to add to a side already at max position.
 *
 * # Relationship to on-chain margin
 *
 * The canonical margin computation is `PortfolioMarginEngine.computePortfolioIM/MM`
 * on chain. We DO NOT replicate the 4-scenario stress test here; we read the
 * outputs through `CollateralTracker` and use them as inputs.
 *
 * Pre-trade gate uses the engine view directly:
 *
 *   canPlaceOrders(intents) :=  engine.canPlaceOrder(wallet, Σ estimateOrderMargin(i))
 *
 * `estimateOrderMargin` mirrors the on-chain per-product order-margin formula
 * for the venue (see InstrumentAdapter.estimateOrderMargin docstring). If the
 * estimate is wrong on the high side we waste a few bps of quoting capacity
 * by being too conservative. If wrong on the low side, the tx may revert on
 * place — acceptable, the chain is the final authority.
 *
 * # Safety margin policy
 *
 *   - Halt at portfolioMM breach (vaultBalance < portfolioMM). Strict — once
 *     this fires, we are technically liquidatable on chain.
 *   - Halt at minCollateralBalance (config floor). Operational guardrail.
 *   - Halt at maxDailyLossUsd: net of vaultBalance change since midnight + gas.
 *   - Throttle at hourly/daily gas budget (recoverable; resumes when window
 *     rolls over).
 *
 * Counters reset at UTC midnight via `checkDayRollover`.
 */

import type pino from "pino";
import type { InstrumentAdapter, OrderIntent } from "./adapter.ts";
import type { CollateralTracker } from "./collateralTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import { RollingBudget, bigAbs } from "./math.ts";
import type { ErrorInfo } from "./errors.ts";

export type ThrottleReason = "gas_hourly" | "gas_daily" | "none";

export interface RiskManagerConfig {
  maxPositionSize: bigint;
  /** Stop quoting both sides when utilization exceeds this percentage. */
  maxUtilizationPct: number;
  minCollateralBalance: bigint;
  maxDailyLossUsd: bigint;
  maxGasBudgetPerHourUsd: bigint;
  maxGasBudgetPerDayUsd: bigint;
}

export class RiskManager {
  halted = false;
  haltReason: ErrorInfo | null = null;
  throttled = false;
  throttleReason: ThrottleReason = "none";

  cumulativeGasCostUsd = 0n;

  private readonly gasHourlyBudget: RollingBudget;
  private readonly gasDailyBudget: RollingBudget;

  private startOfDayBalance = 0n;
  private startOfDayTimestamp = 0;

  private readonly cfg: RiskManagerConfig;
  /**
   * Default inventory for single-market callers. Null in the portfolio process,
   * where `allowedSides` is always called with the per-market inventory since
   * position units differ across venues (perps hashrate vs futures contracts).
   */
  private readonly inventory: InventoryManager | null;
  private readonly collateral: CollateralTracker;
  private readonly gas: GasTracker;
  private readonly oracle: OracleTracker;
  private readonly logger: pino.Logger;

  constructor(
    cfg: RiskManagerConfig,
    inventory: InventoryManager | null,
    collateral: CollateralTracker,
    gas: GasTracker,
    oracle: OracleTracker,
    logger: pino.Logger,
  ) {
    this.cfg = cfg;
    this.inventory = inventory;
    this.collateral = collateral;
    this.gas = gas;
    this.oracle = oracle;
    this.logger = logger.child({ component: "risk" });
    this.gasHourlyBudget = new RollingBudget(60 * 60 * 1000);
    this.gasDailyBudget = new RollingBudget(24 * 60 * 60 * 1000);
  }

  /** Snapshot starting collateral; call once after first collateral update. */
  initialize(): void {
    this.startOfDayBalance = this.collateral.vaultBalance;
    this.startOfDayTimestamp = Date.now();
  }

  recordGasCost(costUsd: bigint): void {
    this.gasHourlyBudget.add(costUsd);
    this.gasDailyBudget.add(costUsd);
    this.cumulativeGasCostUsd += costUsd;
  }

  /** Returns true if the bot should continue quoting. */
  check(): boolean {
    this.checkDayRollover();

    if (this.collateral.vaultBalance < this.cfg.minCollateralBalance) {
      return this.halt({
        message: "collateral below minimum",
        balance: this.collateral.vaultBalance.toString(),
        min: this.cfg.minCollateralBalance.toString(),
      });
    }

    // Portfolio MM is the on-chain liquidation threshold. If we're below it,
    // we're already at risk and should stop adding orders immediately.
    if (
      this.collateral.portfolioMM > 0n &&
      this.collateral.vaultBalance < this.collateral.portfolioMM
    ) {
      return this.halt({
        message: "portfolio MM breached",
        balance: this.collateral.vaultBalance.toString(),
        portfolioMM: this.collateral.portfolioMM.toString(),
      });
    }

    const truePnl = this.truePnl();
    if (truePnl < 0n && bigAbs(truePnl) > this.cfg.maxDailyLossUsd) {
      return this.halt({
        message: "daily loss limit breached",
        pnl: truePnl.toString(),
        max: this.cfg.maxDailyLossUsd.toString(),
      });
    }

    this.halted = false;
    this.haltReason = null;

    const hourlyGas = this.gasHourlyBudget.total();
    if (hourlyGas > this.cfg.maxGasBudgetPerHourUsd) {
      this.throttled = true;
      this.throttleReason = "gas_hourly";
      this.logger.warn(
        { hourlyGas: hourlyGas.toString(), max: this.cfg.maxGasBudgetPerHourUsd.toString() },
        "throttled: hourly gas budget exceeded",
      );
    } else {
      const dailyGas = this.gasDailyBudget.total();
      if (dailyGas > this.cfg.maxGasBudgetPerDayUsd) {
        this.throttled = true;
        this.throttleReason = "gas_daily";
        this.logger.warn({ dailyGas: dailyGas.toString() }, "throttled: daily gas budget exceeded");
      } else {
        this.throttled = false;
        this.throttleReason = "none";
      }
    }

    return true;
  }

  /**
   * Pre-trade engine gate. Sums per-order IM estimates and asks the engine
   * whether the wallet can place all of them in one batch.
   *
   * Returns true on empty input.
   */
  async canPlaceOrders(intents: OrderIntent[], instrument: InstrumentAdapter): Promise<boolean> {
    if (intents.length === 0) return true;
    let total = 0n;
    for (const i of intents) {
      total += instrument.estimateOrderMargin(i);
    }
    if (total === 0n) return true;
    return this.collateral.canPlace(total);
  }

  /**
   * Sides allowed to quote for a market. Utilization is portfolio-wide (shared
   * collateral), while the direction and the position cap are per-market:
   * pass the market's inventory + cap. Single-market callers may omit both to
   * fall back to the injected defaults.
   */
  allowedSides(
    inventory?: InventoryManager,
    maxPositionSize?: bigint,
  ): { quoteBid: boolean; quoteAsk: boolean } {
    const inv = inventory ?? this.inventory;
    if (!inv) return { quoteBid: false, quoteAsk: false };
    const maxPos = maxPositionSize ?? this.cfg.maxPositionSize;
    const net = inv.netQuantity;

    if (this.collateral.utilizationPct > this.cfg.maxUtilizationPct) {
      if (net > 0n) return { quoteBid: false, quoteAsk: true };
      if (net < 0n) return { quoteBid: true, quoteAsk: false };
      return { quoteBid: false, quoteAsk: false };
    }

    return {
      quoteBid: net < maxPos,
      quoteAsk: net > -maxPos,
    };
  }

  private halt(reason: ErrorInfo): false {
    this.halted = true;
    this.haltReason = reason;
    this.logger.error(reason, `HALT: ${reason.message}`);
    return false;
  }

  /** Net PnL today including gas. Negative = loss. */
  private truePnl(): bigint {
    const balanceDelta = this.collateral.vaultBalance - this.startOfDayBalance;
    return balanceDelta - this.cumulativeGasCostUsd;
  }

  private checkDayRollover(): void {
    const now = Date.now();
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const midnightMs = todayMidnight.getTime();

    if (this.startOfDayTimestamp < midnightMs && now >= midnightMs) {
      this.startOfDayBalance = this.collateral.vaultBalance;
      this.startOfDayTimestamp = now;
      this.cumulativeGasCostUsd = 0n;
      this.logger.info("day rollover: PnL counters reset");
    }
  }
}
