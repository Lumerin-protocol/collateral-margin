import type pino from "pino";
import Fraction from "fraction.js";
import type { InstrumentAdapter } from "./adapter.ts";
import { bigAbs } from "./math.ts";

export interface InventoryManagerConfig {
  /** Max absolute net position; used for skew normalisation. */
  maxPositionSize: bigint;
}

/**
 * Tracks the MM's position on a single instrument plus the venue's collateral snapshot.
 *
 * One inventory manager per instrument. Collateral is shared across all instruments on
 * the same venue, so multi-instrument deployments would aggregate margin separately.
 */
export class InventoryManager {
  netQuantity = 0n;
  entryPrice = 0n;

  collateralBalance = 0n;
  maintenanceMargin = 0n;
  walletTokenBalance = 0n;
  nativeBalance = 0n;
  collateralTokenAddress: `0x${string}` | null = null;

  /** Margin available to back new exposure (collateralBalance − maintenanceMargin). */
  availableMargin = 0n;
  /** Maintenance margin / collateral as a Fraction in [0, 1]. */
  utilization: Fraction = new Fraction(0n);
  /** netQuantity / maxPositionSize as a Fraction in [-1, 1]. */
  inventorySkew: Fraction = new Fraction(0n);

  private readonly instrument: InstrumentAdapter;
  private readonly cfg: InventoryManagerConfig;
  private readonly logger: pino.Logger;

  constructor(instrument: InstrumentAdapter, cfg: InventoryManagerConfig, logger: pino.Logger) {
    this.instrument = instrument;
    this.cfg = cfg;
    this.logger = logger.child({ component: "inventory", instrument: instrument.id });
  }

  async update(): Promise<void> {
    const [pos, collateral] = await Promise.all([
      this.instrument.getPosition(),
      this.instrument.venue.getCollateral(),
    ]);

    this.netQuantity = pos.netQuantity;
    this.entryPrice = pos.entryPrice;

    this.collateralBalance = collateral.balance;
    this.maintenanceMargin = collateral.maintenanceMargin;
    this.walletTokenBalance = collateral.walletTokenBalance;
    this.nativeBalance = collateral.nativeBalance;
    this.collateralTokenAddress = collateral.collateralTokenAddress;

    this.availableMargin =
      this.collateralBalance > this.maintenanceMargin
        ? this.collateralBalance - this.maintenanceMargin
        : 0n;

    this.utilization =
      this.collateralBalance > 0n
        ? new Fraction(this.maintenanceMargin, this.collateralBalance)
        : new Fraction(0n);

    const maxPos = this.cfg.maxPositionSize;
    if (maxPos > 0n) {
      const raw = new Fraction(this.netQuantity, maxPos);
      const one = new Fraction(1n);
      const negOne = new Fraction(-1n);
      this.inventorySkew = raw.compare(one) > 0 ? one : raw.compare(negOne) < 0 ? negOne : raw;
    } else {
      this.inventorySkew = new Fraction(0n);
    }

    this.logger.debug(
      {
        net: this.netQuantity.toString(),
        balance: this.collateralBalance.toString(),
        skew: this.inventorySkew.valueOf(),
        utilization: this.utilization.valueOf(),
      },
      "inventory tick",
    );
  }

  get hasPosition(): boolean {
    return this.netQuantity !== 0n;
  }

  get absPosition(): bigint {
    return bigAbs(this.netQuantity);
  }

  /** Utilization as integer percent in [0, 100]. */
  get utilizationPct(): number {
    return Number(this.utilization.mul(new Fraction(100n)).round().valueOf());
  }
}
