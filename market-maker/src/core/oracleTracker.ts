import type pino from "pino";
import Fraction from "fraction.js";
import type { InstrumentAdapter, OracleScale } from "./adapter.ts";
import type {
  HistoricalPriceSeries,
  HistoricalPriceSource,
  PricePoint,
} from "./historicalPriceSource.ts";
import { fractionToNumber, RollingWindow } from "./math.ts";

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
   * Upper bound on the age of a backfilled sample, in seconds.
   *
   * Backfill asks for the newest `windowSize` oracle updates, so the span the
   * window covers is decided by the feed's own cadence — this only stops a
   * stale regime from seeding σ when the feed has been quiet. Must stay above
   * `windowSize × the feed's update interval` or the backfill comes back
   * short. Defaults to 24h.
   */
  historyMaxAgeSec?: number;
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
 * wall-clock before σ is meaningful — hours on a feed that updates every few
 * minutes. With the subgraph-backed `HistoricalPriceSource`, the window is
 * already populated when the first live tick lands.
 *
 * Note that the poll interval plays no part in sizing the backfill. The
 * window de-duplicates, so it holds `windowSize` *oracle updates* however
 * often we poll; asking the source for that many is the whole sizing rule.
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
  private readonly windowSize: number;
  private readonly historyMaxAgeSec: number;
  private readonly nowSec: () => number;
  private readonly logger: pino.Logger;
  private lastSampledPrice: bigint | null = null;

  constructor(instrument: InstrumentAdapter, logger: pino.Logger, cfg: OracleTrackerConfig = {}) {
    this.instrument = instrument;
    this.windowSize = cfg.windowSize ?? 60;
    this.priceWindow = new RollingWindow(this.windowSize, cfg.precisionBits ?? 48);
    this.history = cfg.history;
    this.historyMaxAgeSec = cfg.historyMaxAgeSec ?? 86_400;
    this.nowSec = cfg.nowSec ?? (() => Date.now() / 1000);
    this.logger = logger.child({ component: "oracle" });
  }

  /**
   * Backfill the rolling window from `history` (if provided) and read the
   * first live price. Safe to call multiple times — successive invocations
   * are equivalent to plain `update()`.
   */
  async initialize(): Promise<void> {
    if (this.history) {
      try {
        const [live, series] = await Promise.all([
          this.instrument.getOracleScale(),
          // The window keeps `windowSize` de-duplicated samples, so that is
          // exactly how many oracle updates to ask for; the feed decides how
          // far back that reaches.
          this.history.fetch({
            maxPoints: this.windowSize,
            maxAgeSec: this.historyMaxAgeSec,
          }),
        ]);
        const mismatch = reconcileScales(series, live);
        if (mismatch !== null) {
          this.logger.warn(
            {
              reason: mismatch,
              historyAddress: series.address,
              historyDecimals: series.decimals,
              oracleAddress: live.address,
              oracleDecimals: live.decimals,
            },
            "historical series does not match the live oracle; skipping backfill",
          );
        } else {
          const rebased = rebase(series, live.decimals);
          let pushed = 0;
          for (const s of rebased) {
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
            {
              fetched: series.points.length,
              pushed,
              windowSize: this.windowSize,
              maxAgeSec: this.historyMaxAgeSec,
              spanSec: sampleSpanSec(series),
              decimalShift: series.decimals - live.decimals,
              volatilityPerSec: fractionToNumber(this.volatilityPerSecond),
            },
            "backfilled volatility window from historical source",
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, windowSize: this.windowSize, maxAgeSec: this.historyMaxAgeSec },
          "history backfill failed; volatility will warm up from live polls",
        );
      }
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
        volatilityPerSec: fractionToNumber(this.volatilityPerSecond),
        windowFill: this.priceWindow.length,
      },
      "oracle tick",
    );
  }
}

/**
 * Check a historical series against the live oracle before its samples are
 * allowed into the window. Returns `null` when they agree, otherwise a short
 * reason for the log.
 *
 * Both sides declare their feed and their fixed-point scale — the aggregator
 * address and decimals come off chain via `getOracleScale()`, and the source
 * reports the pair it indexed. Nothing is inferred from the magnitude of the
 * prices: a series from a different feed can look perfectly plausible next to
 * the live one, and a decimal difference is indistinguishable from a real
 * price move once you are only comparing numbers.
 */
function reconcileScales(series: HistoricalPriceSeries, live: OracleScale): string | null {
  if (series.address.toLowerCase() !== live.address.toLowerCase()) {
    return "aggregator address differs";
  }
  if (!Number.isInteger(series.decimals) || series.decimals < 0) {
    return "history decimals are not a valid scale";
  }
  return null;
}

/**
 * Restate a series on `targetDecimals`.
 *
 * Historical sources publish the aggregator's own answer, while live reads
 * arrive rebased to token decimals (see `RawOracleReader`). Mixing the two
 * unrebased fabricates a log return the size of the decimal difference at the
 * seam, which then dominates σ.
 */
/** Wall-clock the fetched samples cover, for spotting a window that came back short. */
function sampleSpanSec(series: HistoricalPriceSeries): number {
  const { points } = series;
  if (points.length < 2) return 0;
  return Math.round(points[points.length - 1].timestampSec - points[0].timestampSec);
}

function rebase(series: HistoricalPriceSeries, targetDecimals: number): readonly PricePoint[] {
  const shift = series.decimals - targetDecimals;
  if (shift === 0) return series.points;
  const factor = 10n ** BigInt(Math.abs(shift));
  return series.points.map((s) => ({
    ...s,
    price: shift > 0 ? s.price / factor : s.price * factor,
  }));
}
