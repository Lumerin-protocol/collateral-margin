import type pino from "pino";
import type Fraction from "fraction.js";
import type { InstrumentAdapter, InstrumentContext, OrderIntent, Side } from "./adapter.ts";
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
    | {
        strategy: "geometric-taper";
        baseQuantity: bigint;
        numLevelsPerSide: number;
        taperRatio: number;
      };
  /** Max ticks the inventory skew can shift quotes (effective-spread only). */
  maxSkewTicks: number;
  /**
   * Spacing between successive quote levels, in ticks. App-defaulted per
   * venue: futures wants narrow spacing (dense ladder), perps wants wider
   * spacing (deeper levels only fill after shallower ones).
   */
  levelSpacingTicks: number;
  /**
   * Holding-time horizon (seconds) used to convert per-second realized
   * volatility (`OracleTracker.volatilityPerSecond`) into per-horizon log
   * returns for bps math: `vol_bps ∝ σ_s · √volHorizonSec`. Set to the
   * typical time between requotes — `pollIntervalSec` is a sensible default.
   */
  volHorizonSec: number;
}

/**
 * Computes desired bid/ask quotes for one instrument by combining a pricing
 * strategy (mid + spread) with a sizing strategy (per-level quantities).
 *
 * Stateless across ticks; all state lives in the trackers it reads from.
 *
 * The output is a flat list of `OrderIntent`s; the executor diffs against
 * resting orders. The Quoter never emits raw calldata — that lives entirely
 * in the instrument adapter via `encodeCreate`.
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
    this.tick = await this.instrument.book.tick();
    this.context = await this.instrument.getContext();
    this.logger.info(
      { tick: this.tick.toString(), expirationAt: this.context.expirationAt },
      "quoter initialized",
    );
  }

  getTick(): bigint {
    return this.tick;
  }

  getContext(): InstrumentContext {
    return this.context;
  }

  computeQuotes(): OrderIntent[] {
    const oraclePrice = this.oracle.currentPrice;
    if (oraclePrice === 0n || this.tick === 0n) {
      return [];
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
          volHorizonSec: this.cfg.volHorizonSec,
        })
      : computeMidQuote({
          oracle: this.oracle,
          gas: this.gas,
          inventory: this.inventory,
          cfg: this.cfg.pricing,
          baseQuantity: this.cfg.sizing.baseQuantity,
          maxSkewTicks: this.cfg.maxSkewTicks,
          tick: this.tick,
          volHorizonSec: this.cfg.volHorizonSec,
        });

    const { bidMid, askMid, spreadBps } = midQuote;
    const { quoteBid, quoteAsk } = this.risk.allowedSides(
      this.inventory,
      this.inventory.maxPositionSize,
    );

    const intents: OrderIntent[] = [];
    const spacing = BigInt(this.cfg.levelSpacingTicks) * this.tick;

    for (let level = 0; level < sizes.length; level++) {
      const offset = BigInt(level) * spacing;
      const size = sizes[level];
      if (size <= 0n) continue;

      if (quoteBid) {
        const bidRaw = bidMid - offset;
        const bidPrice = roundDownToTick(bidRaw > 0n ? bidRaw : this.tick, this.tick);
        intents.push({ side: "buy", price: bidPrice, size });
      }

      if (quoteAsk) {
        const askRaw = askMid + offset;
        const askPrice = roundUpToTick(askRaw, this.tick);
        if (askPrice > 0n) intents.push({ side: "sell", price: askPrice, size });
      }
    }

    this.logger.debug(
      {
        strategy: this.cfg.pricing.strategy,
        spreadBps: fractionToString(spreadBps),
        bids: intents.filter((i) => i.side === "buy").length,
        asks: intents.filter((i) => i.side === "sell").length,
      },
      "quotes computed",
    );

    return intents;
  }

  private computeSizes(): bigint[] {
    const s = this.cfg.sizing;
    if (s.strategy === "linear") {
      return linearSizes(s.baseQuantity, s.numLevelsPerSide);
    }
    return geometricTaperSizes(
      s.baseQuantity * BigInt(s.numLevelsPerSide),
      s.taperRatio,
      s.numLevelsPerSide,
    );
  }
}

/** Diagnostic-only Fraction → string. Never used in trading math. */
function fractionToString(f: Fraction): string {
  return (Number(f.n) / Number(f.d)).toFixed(2);
}

/** Convenience helper. */
export function bidIntents(intents: OrderIntent[]): OrderIntent[] {
  return intents.filter((i) => i.side === "buy");
}
export function askIntents(intents: OrderIntent[]): OrderIntent[] {
  return intents.filter((i) => i.side === "sell");
}
export const isBuy = (s: Side): boolean => s === "buy";
