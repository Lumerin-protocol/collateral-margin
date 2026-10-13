import type pino from "pino";
import Fraction from "fraction.js";
import type { InstrumentAdapter } from "./adapter.ts";
import { bigAbs, notionalToSize } from "./math.ts";

export interface InventoryManagerConfig {
  /** Max absolute net position notional, 6dp USD. */
  maxPositionNotional: bigint;
  /** Venue size scale: `notional = price * size / quantityScale` (perps 1e6, futures 1). */
  quantityScale: bigint;
}

/** Source of the price the notional cap is converted at. */
export interface PriceSource {
  readonly currentPrice: bigint;
}

/**
 * Tracks the MM's position on a single instrument.
 *
 * Collateral / portfolio-margin lives in `CollateralTracker` — these were
 * combined in the legacy code and split for the vault era so that position
 * (one instrument) and balance (one wallet, many instruments) can evolve
 * independently.
 *
 * The position cap is configured as USD notional so one number means the same
 * risk on every venue. It is re-expressed in venue-native units at the oracle
 * price on each `update()`, so the oracle must be refreshed first.
 */
export class InventoryManager {
  netQuantity = 0n;
  entryPrice = 0n;

  /** Notional cap converted to venue-native units at the last oracle price. */
  maxPositionSize = 0n;

  /** netQuantity / maxPositionSize as a Fraction in [-1, 1]. */
  inventorySkew: Fraction = new Fraction(0n);

  private readonly instrument: InstrumentAdapter;
  private readonly cfg: InventoryManagerConfig;
  private readonly price: PriceSource;
  private readonly logger: pino.Logger;

  constructor(
    instrument: InstrumentAdapter,
    cfg: InventoryManagerConfig,
    price: PriceSource,
    logger: pino.Logger,
  ) {
    this.instrument = instrument;
    this.cfg = cfg;
    this.price = price;
    this.logger = logger.child({ component: "inventory", instrument: instrument.id });
  }

  async update(): Promise<void> {
    const pos = await this.instrument.getPosition();
    this.netQuantity = pos.netQuantity;
    this.entryPrice = pos.entryPrice;

    this.maxPositionSize = notionalToSize(
      this.price.currentPrice,
      this.cfg.maxPositionNotional,
      this.cfg.quantityScale,
    );

    const maxPos = this.maxPositionSize;
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
        maxPos: maxPos.toString(),
        skew: this.inventorySkew.valueOf(),
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
}
