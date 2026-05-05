import type pino from "pino";
import Fraction from "fraction.js";
import type { InstrumentAdapter } from "./adapter.ts";
import { RollingWindow } from "./math.ts";

export interface OracleTrackerConfig {
  windowSize?: number;
  precisionBits?: number;
}

export class OracleTracker {
  currentPrice = 0n;
  /** Realized volatility as a Fraction (stddev of log returns). */
  volatility: Fraction = new Fraction(0n);

  private readonly instrument: InstrumentAdapter;
  private readonly priceWindow: RollingWindow;
  private readonly logger: pino.Logger;

  constructor(instrument: InstrumentAdapter, logger: pino.Logger, cfg: OracleTrackerConfig = {}) {
    this.instrument = instrument;
    this.priceWindow = new RollingWindow(cfg.windowSize ?? 60, cfg.precisionBits ?? 48);
    this.logger = logger.child({ component: "oracle" });
  }

  async update(): Promise<void> {
    const price = await this.instrument.getIndexPrice();
    this.currentPrice = price;
    if (price > 0n) {
      this.priceWindow.push(price);
      this.volatility = this.priceWindow.volatility();
    }
    this.logger.debug(
      { price: price.toString(), volatility: this.volatility.valueOf() },
      "oracle tick",
    );
  }
}
