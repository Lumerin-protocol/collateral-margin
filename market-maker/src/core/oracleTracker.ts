import type pino from "pino";
import Fraction from "fraction.js";
import type { InstrumentAdapter } from "./adapter.ts";
import type { HistoricalPriceSource } from "./historicalPriceSource.ts";
import { RollingWindow } from "./math.ts";

export interface OracleTrackerConfig {
  /** Maximum number of samples kept in the rolling window. Defaults to 60. */
  windowSize?: number;
  /** Bigint precision for `ln` / `sqrt` approximations. Defaults to 48 bits. */
  precisionBits?: number;
  /**
   * Optional historical-price source consulted at `initialize()` time to
   * pre-populate the rolling window. Without it the window starts empty and
   * volatility is biased to 0 for ~`windowSize × pollInterval` seconds.
   */
  history?: HistoricalPriceSource;
  /**
   * Live poll cadence in milliseconds. Used together with `windowSize` to
   * size the historical lookback (`windowSize × pollIntervalMs`). Required
   * when `history` is provided; otherwise ignored.
   */
  pollIntervalMs?: number;
  /**
   * Multiplier applied to the lookback window when fetching history. The
   * underlying oracle (Chainlink) only updates on deviation/heartbeat, so
   * `windowSize × pollIntervalMs` of wall-clock typically yields fewer than
   * `windowSize` samples. Querying a wider window and trimming gets us a
   * full window. Defaults to 4× — generous enough for slow feeds, small
   * enough to keep the gateway response under a few hundred kB.
   */
  historyLookbackMultiplier?: number;
  /**
   * Test seam for deterministic per-second σ math. Returns the current time
   * in seconds (with sub-second precision is fine). Defaults to
   * `() => Date.now() / 1000`.
   */
  nowSec?: () => number;
}

/**
 * Tracks the latest oracle price and computes realized per-second volatility
 * from a rolling window of de-duplicated samples.
 *
 * # Why de-dupe
 *
 * The price source is a Chainlink aggregator that only updates on
 * deviation/heartbeat (every few minutes for slow feeds like hashprice).
 * Polling every few seconds means most polls observe the *same* answer and
 * contribute a zero log-return that biases σ toward 0. We push to the window
 * only when the answer actually changes; the per-second normalisation in
 * `RollingWindow.volatilityPerSecond` then handles the variable Δt between
 * consecutive updates.
 *
 * # Why backfill
 *
 * Cold starts otherwise need ~`windowSize × medianUpdateInterval` of
 * wall-clock before σ is meaningful. With the subgraph-backed
 * `HistoricalPriceSource`, the window is already populated when the first
 * live tick lands.
 */
export class OracleTracker {
  currentPrice = 0n;
  /**
   * Realized per-second volatility (Fraction). Units: dimensionless × s^-1/2.
   * Pricing strategies multiply by √(holding-time-seconds) to convert into
   * a per-step number that can be turned into bps.
   */
  volatilityPerSecond: Fraction = new Fraction(0n);

  private readonly instrument: InstrumentAdapter;
  private readonly priceWindow: RollingWindow;
  private readonly history: HistoricalPriceSource | undefined;
  private readonly pollIntervalMs: number | undefined;
  private readonly windowSize: number;
  private readonly historyLookbackMultiplier: number;
  private readonly nowSec: () => number;
  private readonly logger: pino.Logger;
  private lastSampledPrice: bigint | null = null;

  constructor(instrument: InstrumentAdapter, logger: pino.Logger, cfg: OracleTrackerConfig = {}) {
    this.instrument = instrument;
    this.windowSize = cfg.windowSize ?? 60;
    this.priceWindow = new RollingWindow(this.windowSize, cfg.precisionBits ?? 48);
    this.history = cfg.history;
    this.pollIntervalMs = cfg.pollIntervalMs;
    this.historyLookbackMultiplier = cfg.historyLookbackMultiplier ?? 4;
    this.nowSec = cfg.nowSec ?? (() => Date.now() / 1000);
    this.logger = logger.child({ component: "oracle" });
  }

  /**
   * Backfill the rolling window from `history` (if provided) and read the
   * first live price. Safe to call multiple times — successive invocations
   * are equivalent to plain `update()`.
   */
  async initialize(): Promise<void> {
    if (this.history && this.pollIntervalMs && this.pollIntervalMs > 0) {
      const lookbackSec = (this.windowSize * this.pollIntervalMs * this.historyLookbackMultiplier) / 1000;
      try {
        const samples = await this.history.fetch({
          lookbackSec,
          maxPoints: this.windowSize * this.historyLookbackMultiplier,
        });
        let pushed = 0;
        for (const s of samples) {
          if (s.price <= 0n) continue;
          if (this.lastSampledPrice !== null && s.price === this.lastSampledPrice) continue;
          this.priceWindow.push(s.price, s.timestampSec);
          this.lastSampledPrice = s.price;
          pushed++;
        }
        if (pushed > 0) {
          // Compute σ now so it's already meaningful before the first live tick;
          // `update()` only recomputes when a *new* price arrives, and the live
          // poll often duplicates the last backfilled sample.
          this.volatilityPerSecond = this.priceWindow.volatilityPerSecond();
        }
        this.logger.info(
          { fetched: samples.length, pushed, windowSize: this.windowSize, lookbackSec },
          "backfilled volatility window from historical source",
        );
      } catch (err) {
        this.logger.warn(
          { err, windowSize: this.windowSize, lookbackSec },
          "history backfill failed; volatility will warm up from live polls",
        );
      }
    } else if (this.history) {
      this.logger.warn(
        "history provided without pollIntervalMs; skipping backfill",
      );
    }

    await this.update();
  }

  async update(): Promise<void> {
    const price = await this.instrument.getIndexPrice();
    this.currentPrice = price;
    if (price > 0n && price !== this.lastSampledPrice) {
      this.priceWindow.push(price, this.nowSec());
      this.lastSampledPrice = price;
      this.volatilityPerSecond = this.priceWindow.volatilityPerSecond();
    }
    this.logger.debug(
      {
        price: price.toString(),
        volatilityPerSec: this.volatilityPerSecond.valueOf(),
        windowFill: this.priceWindow.length,
      },
      "oracle tick",
    );
  }
}
