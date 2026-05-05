import Fraction from "fraction.js";
import type { OracleTracker } from "../oracleTracker.ts";
import type { GasTracker } from "../gasTracker.ts";
import type { InventoryManager } from "../inventoryManager.ts";
import { BPS_SCALE, calculateNotional } from "../math.ts";
import { toBigint } from "../rational.ts";

export interface EffectiveSpreadConfig {
  /** Floor spread in basis points; one-side half-spread is half this. */
  minSpreadBps: number;
  /** Multiplier on realised volatility (Fraction → bps). */
  volatilityMultiplier: number;
  /** Multiplier on |inventory skew| (×minSpreadBps). */
  inventorySkewGamma: number;
  /** Penalty added when gas spikes (×spike fraction). */
  gasPenaltyBps: number;
}

export interface MidQuote {
  /** Bid mid (oracle − halfSpread − skewOffset). */
  bidMid: bigint;
  /** Ask mid (oracle + halfSpread − skewOffset). */
  askMid: bigint;
  /** Effective full spread used (Fraction bps, for diagnostics). */
  spreadBps: Fraction;
}

/**
 * Effective-spread mid pricing, ported from the legacy perps quoter.
 *
 * Spread = max(minSpread, gasFloor) + volMult·σ·1e4 + γ·|skew|·minSpread + gasPenalty·spike%
 * Skew offset shifts both bid and ask down (long inv) or up (short inv).
 */
export function computeMidQuote(opts: {
  oracle: OracleTracker;
  gas: GasTracker;
  inventory: InventoryManager;
  cfg: EffectiveSpreadConfig;
  baseQuantity: bigint;
  maxSkewTicks: number;
  tick: bigint;
}): MidQuote {
  const { oracle, gas, inventory, cfg, baseQuantity, maxSkewTicks, tick } = opts;
  const oraclePrice = oracle.currentPrice;

  const spreadBps = effectiveSpreadBps({ oracle, gas, inventory, cfg, baseQuantity });
  const halfSpreadBps = spreadBps.div(new Fraction(2n));

  const skewOffset = inventorySkewOffset({ inventory, oraclePrice, maxSkewTicks, tick, gamma: cfg.inventorySkewGamma });

  const halfBpsBig = bpsToBigint(halfSpreadBps);
  const bidMid = (oraclePrice * (BPS_SCALE - halfBpsBig)) / BPS_SCALE - skewOffset;
  const askMid = (oraclePrice * (BPS_SCALE + halfBpsBig)) / BPS_SCALE - skewOffset;

  return { bidMid, askMid, spreadBps };
}

function effectiveSpreadBps(opts: {
  oracle: OracleTracker;
  gas: GasTracker;
  inventory: InventoryManager;
  cfg: EffectiveSpreadConfig;
  baseQuantity: bigint;
}): Fraction {
  const { oracle, gas, inventory, cfg, baseQuantity } = opts;

  const gasFloor = gasFloorBps(oracle, gas, baseQuantity);
  const minSpread = new Fraction(cfg.minSpreadBps);
  const base = gasFloor.compare(minSpread) > 0 ? gasFloor : minSpread;

  // vol Fraction (stddev of log returns) * multiplier * 10000 gives bps
  const vol = oracle.volatility.mul(new Fraction(Math.round(cfg.volatilityMultiplier * 1_000_000), 1_000_000)).mul(
    new Fraction(10_000n),
  );

  const skewAbs = inventory.inventorySkew.abs();
  const inv = skewAbs.mul(minSpread);

  const spike = gas.gasSpikePct;
  const gasPenalty = spike.compare(new Fraction(0n)) > 0
    ? spike.div(new Fraction(100n)).mul(new Fraction(cfg.gasPenaltyBps))
    : new Fraction(0n);

  return base.add(vol).add(inv).add(gasPenalty);
}

function gasFloorBps(oracle: OracleTracker, gas: GasTracker, baseQuantity: bigint): Fraction {
  const rt = gas.roundTripCostUsd;
  if (rt === 0n) return new Fraction(0n);
  const expectedNotional = calculateNotional(oracle.currentPrice, baseQuantity);
  if (expectedNotional === 0n) return new Fraction(0n);
  return new Fraction(rt * 10_000n, expectedNotional);
}

function inventorySkewOffset(opts: {
  inventory: InventoryManager;
  oraclePrice: bigint;
  maxSkewTicks: number;
  tick: bigint;
  gamma: number;
}): bigint {
  const { inventory, oraclePrice, maxSkewTicks, tick, gamma } = opts;
  if (oraclePrice === 0n || tick === 0n) return 0n;
  // skewTicks = round(gamma * skew * maxSkewTicks)
  const skewTicks = inventory.inventorySkew
    .mul(new Fraction(Math.round(gamma * 1_000_000), 1_000_000))
    .mul(new Fraction(maxSkewTicks));
  const skewTicksBig = toBigint(skewTicks, 1n, "nearest");
  return skewTicksBig * tick;
}

function bpsToBigint(bpsFraction: Fraction): bigint {
  return toBigint(bpsFraction, 1n, "nearest");
}
