import type pino from "pino";
import type Fraction from "fraction.js";
import type { DesiredQuotes, InstrumentAdapter, InstrumentContext, QuoteLevel } from "./adapter.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { RiskManager } from "./riskManager.ts";
import { roundDownToTick, roundUpToTick } from "./math.ts";
import { computeMidQuote, type EffectiveSpreadConfig } from "./pricing/effectiveSpread.ts";
import { computeReservationMidQuote, type ReservationPriceConfig } from "./pricing/reservationPrice.ts";
import { linearSizes } from "./sizing/linear.ts";
import { geometricTaperSizes } from "./sizing/geometricTaper.ts";

export type { ReservationPriceConfig };
export type PricingStrategyName = "effective-spread" | "reservation-price";
export type SizingStrategyName = "linear" | "geometric-taper";

export interface QuoterConfig {
  pricing:
    | ({ strategy: "effective-spread" } & EffectiveSpreadConfig)
    | ({ strategy: "reservation-price" } & ReservationPriceConfig);
  sizing:
    | { strategy: "linear"; baseQuantity: bigint; numLevelsPerSide: number }
    | { strategy: "geometric-taper"; baseQuantity: bigint; numLevelsPerSide: number; taperRatio: number };
  /** Max ticks the inventory skew can shift quotes (effective-spread only). */
  maxSkewTicks: number;
}

/**
 * Computes desired bid/ask quotes for one instrument by combining a pricing strategy
 * (mid + spread) with a sizing strategy (per-level quantities).
 *
 * Stateless across ticks; all state lives in the trackers it reads from.
 */
export class Quoter {
  private tick = 0n;
  private context: InstrumentContext = {};
  private readonly instrument: InstrumentAdapter;
  private readonly cfg: QuoterConfig;
  private readonly oracle: OracleTracker;
  private readonly gas: GasTracker;
  private readonly inventory: InventoryManager;
  private readonly risk: RiskManager;
  private readonly logger: pino.Logger;

  constructor(
    instrument: InstrumentAdapter,
    cfg: QuoterConfig,
    oracle: OracleTracker,
    gas: GasTracker,
    inventory: InventoryManager,
    risk: RiskManager,
    logger: pino.Logger,
  ) {
    this.instrument = instrument;
    this.cfg = cfg;
    this.oracle = oracle;
    this.gas = gas;
    this.inventory = inventory;
    this.risk = risk;
    this.logger = logger.child({ component: "quoter", instrument: instrument.id });
  }

  async initialize(): Promise<void> {
    this.tick = await this.instrument.getMinTick();
    this.context = await this.instrument.getContext();
    this.logger.info(
      { tick: this.tick.toString(), deliveryDate: this.context.deliveryDate },
      "quoter initialized",
    );
  }

  getTick(): bigint {
    return this.tick;
  }

  computeQuotes(): DesiredQuotes {
    const oraclePrice = this.oracle.currentPrice;
    if (oraclePrice === 0n || this.tick === 0n) {
      return { bids: [], asks: [] };
    }

    const sizes = this.computeSizes();
    const midQuote = this.cfg.pricing.strategy === "reservation-price"
      ? computeReservationMidQuote({
          oracle: this.oracle,
          gas: this.gas,
          inventory: this.inventory,
          context: this.context,
          cfg: this.cfg.pricing,
          tick: this.tick,
        })
      : computeMidQuote({
          oracle: this.oracle,
          gas: this.gas,
          inventory: this.inventory,
          cfg: this.cfg.pricing,
          baseQuantity: this.cfg.sizing.baseQuantity,
          maxSkewTicks: this.cfg.maxSkewTicks,
          tick: this.tick,
        });

    const { bidMid, askMid, spreadBps } = midQuote;
    const { quoteBid, quoteAsk } = this.risk.allowedSides();

    const bids: QuoteLevel[] = [];
    const asks: QuoteLevel[] = [];

    for (let level = 0; level < sizes.length; level++) {
      const levelTicks = BigInt(level) * this.tick;
      const qty = sizes[level];

      if (quoteBid) {
        const bidRaw = bidMid - levelTicks;
        const bidPrice = roundDownToTick(bidRaw > 0n ? bidRaw : this.tick, this.tick);
        bids.push({ price: bidPrice, quantity: qty });
      }

      if (quoteAsk) {
        const askRaw = askMid + levelTicks;
        const askPrice = roundUpToTick(askRaw, this.tick);
        if (askPrice > 0n) asks.push({ price: askPrice, quantity: -qty });
      }
    }

    this.logger.debug(
      {
        strategy: this.cfg.pricing.strategy,
        spreadBps: fractionToString(spreadBps),
        bidLevels: bids.length,
        askLevels: asks.length,
        bidTop: bids[0]?.price.toString(),
        askTop: asks[0]?.price.toString(),
      },
      "quotes computed",
    );

    return { bids, asks };
  }

  private computeSizes(): bigint[] {
    const s = this.cfg.sizing;
    if (s.strategy === "linear") {
      return linearSizes(s.baseQuantity, s.numLevelsPerSide);
    }
    return geometricTaperSizes(s.baseQuantity * BigInt(s.numLevelsPerSide), s.taperRatio, s.numLevelsPerSide);
  }
}

function fractionToString(f: Fraction): string {
  // safe approximation for diagnostics; never used in trading math
  return (Number(f.n) / Number(f.d)).toFixed(2);
}
