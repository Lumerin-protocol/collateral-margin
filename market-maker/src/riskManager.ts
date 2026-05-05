import type pino from "pino";
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

/**
 * Risk halts (stop quoting and cancel) and throttles (slow down quoting).
 *
 * Halts are recoverable on the next tick once the underlying condition clears.
 * Daily PnL counters reset at midnight UTC.
 */
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
  private readonly inventory: InventoryManager;
  private readonly gas: GasTracker;
  private readonly oracle: OracleTracker;
  private readonly logger: pino.Logger;

  constructor(
    cfg: RiskManagerConfig,
    inventory: InventoryManager,
    gas: GasTracker,
    oracle: OracleTracker,
    logger: pino.Logger,
  ) {
    this.cfg = cfg;
    this.inventory = inventory;
    this.gas = gas;
    this.oracle = oracle;
    this.logger = logger.child({ component: "risk" });
    this.gasHourlyBudget = new RollingBudget(60 * 60 * 1000);
    this.gasDailyBudget = new RollingBudget(24 * 60 * 60 * 1000);
  }

  /** Snapshot starting collateral; call once after first inventory update. */
  initialize(): void {
    this.startOfDayBalance = this.inventory.collateralBalance;
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

    if (this.inventory.collateralBalance < this.cfg.minCollateralBalance) {
      this.halted = true;
      this.haltReason = {
        message: "collateral below minimum",
        balance: this.inventory.collateralBalance.toString(),
        min: this.cfg.minCollateralBalance.toString(),
      };
      this.logger.error(this.haltReason, "HALT: collateral below minimum");
      return false;
    }

    const truePnl = this.truePnl();
    if (truePnl < 0n && bigAbs(truePnl) > this.cfg.maxDailyLossUsd) {
      this.halted = true;
      this.haltReason = {
        message: "daily loss limit breached",
        pnl: truePnl.toString(),
        max: this.cfg.maxDailyLossUsd.toString(),
      };
      this.logger.error(this.haltReason, "HALT: daily loss limit breached");
      return false;
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
   * Sides allowed to quote. Respects position cap and stops quoting at high utilization
   * (only the side that reduces exposure is allowed).
   */
  allowedSides(): { quoteBid: boolean; quoteAsk: boolean } {
    const maxPos = this.cfg.maxPositionSize;
    const net = this.inventory.netQuantity;

    if (this.inventory.utilizationPct > this.cfg.maxUtilizationPct) {
      if (net > 0n) return { quoteBid: false, quoteAsk: true };
      if (net < 0n) return { quoteBid: true, quoteAsk: false };
      return { quoteBid: false, quoteAsk: false };
    }

    return {
      quoteBid: net < maxPos,
      quoteAsk: net > -maxPos,
    };
  }

  /** Net PnL today including gas. Negative = loss. */
  private truePnl(): bigint {
    const balanceDelta = this.inventory.collateralBalance - this.startOfDayBalance;
    return balanceDelta - this.cumulativeGasCostUsd;
  }

  private checkDayRollover(): void {
    const now = Date.now();
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const midnightMs = todayMidnight.getTime();

    if (this.startOfDayTimestamp < midnightMs && now >= midnightMs) {
      this.startOfDayBalance = this.inventory.collateralBalance;
      this.startOfDayTimestamp = now;
      this.cumulativeGasCostUsd = 0n;
      this.logger.info("day rollover: PnL counters reset");
    }
  }
}
