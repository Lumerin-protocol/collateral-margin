import type pino from "pino";
import Fraction from "fraction.js";
import type { CollateralAccount, CollateralSnapshot } from "./adapter.ts";

export interface CollateralTrackerConfig {
  /**
   * Auto-deposit any wallet-held collateral into the vault on every update.
   * Set true in production configs where wallet sweeps belong on chain;
   * false in dev/test where you want to inspect un-deposited balance.
   */
  autoDeposit: boolean;
  /** Skip the deposit if `walletTokenBalance < threshold`. */
  autoDepositMinAmount: bigint;
}

/**
 * Wraps a venue's `CollateralAccount` and exposes the latest snapshot fields
 * as reactive properties for the rest of core (RiskManager, HealthCheck, etc).
 *
 * Performs an optional automatic deposit when the wallet has un-deposited
 * collateral and `autoDeposit` is enabled — replaces the legacy
 * `if (... && nodeEnv === "production")` hardcoding in main.ts.
 */
export class CollateralTracker {
  vaultBalance = 0n;
  portfolioIM = 0n;
  portfolioMM = 0n;
  venueOrderMargin = 0n;
  venueUnrealizedPnl = 0n;
  walletTokenBalance = 0n;
  nativeBalance = 0n;
  collateralToken: `0x${string}` | null = null;

  /** portfolioMM / vaultBalance as a Fraction in [0, ∞). */
  utilization: Fraction = new Fraction(0n);

  private readonly account: CollateralAccount;
  private readonly cfg: CollateralTrackerConfig;
  private readonly logger: pino.Logger;

  constructor(account: CollateralAccount, cfg: CollateralTrackerConfig, logger: pino.Logger) {
    this.account = account;
    this.cfg = cfg;
    this.logger = logger.child({ component: "collateral" });
  }

  async update(): Promise<void> {
    const snap = await this.account.snapshot();
    this.applySnapshot(snap);
    this.logger.debug(
      {
        balance: this.vaultBalance.toString(),
        portfolioIM: this.portfolioIM.toString(),
        portfolioMM: this.portfolioMM.toString(),
        utilizationPct: this.utilizationPct,
      },
      "collateral tick",
    );
  }

  async maybeTopUp(): Promise<void> {
    if (!this.cfg.autoDeposit) return;
    if (this.walletTokenBalance < this.cfg.autoDepositMinAmount) return;
    const amount = this.walletTokenBalance;
    this.logger.info({ amount: amount.toString() }, "depositing wallet balance into vault");
    await this.account.deposit(amount);
    await this.update();
  }

  /** Pre-trade gate: ask the engine whether `additionalIM` would still fit. */
  canPlace(additionalIM: bigint): Promise<boolean> {
    return this.account.canPlace(additionalIM);
  }

  /** Free margin = vaultBalance − portfolioIM (clamped at 0). */
  get freeMargin(): bigint {
    return this.vaultBalance > this.portfolioIM ? this.vaultBalance - this.portfolioIM : 0n;
  }

  /** Maintenance ratio = portfolioMM / vaultBalance. >1 means underwater. */
  get maintenanceRatio(): Fraction {
    return this.utilization;
  }

  /** Utilization as integer percent. Saturates at INT32 range for safety. */
  get utilizationPct(): number {
    const f = this.utilization.mul(new Fraction(100n));
    const v = (Number(f.n) / Number(f.d)) * Number(f.s);
    if (!Number.isFinite(v)) return 0;
    return Math.min(2_147_483_647, Math.max(-2_147_483_647, Math.round(v)));
  }

  private applySnapshot(s: CollateralSnapshot): void {
    this.vaultBalance = s.vaultBalance;
    this.portfolioIM = s.portfolioIM;
    this.portfolioMM = s.portfolioMM;
    this.venueOrderMargin = s.venueOrderMargin;
    this.venueUnrealizedPnl = s.venueUnrealizedPnl;
    this.walletTokenBalance = s.walletTokenBalance;
    this.nativeBalance = s.nativeBalance;
    this.collateralToken = s.collateralToken;

    this.utilization =
      this.vaultBalance > 0n
        ? new Fraction(this.portfolioMM, this.vaultBalance)
        : new Fraction(0n);
  }
}
