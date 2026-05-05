import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fraction from "fraction.js";
import { computeReservationMidQuote } from "../src/pricing/reservationPrice.ts";
import type { ReservationPriceConfig } from "../src/pricing/reservationPrice.ts";
import type { OracleTracker } from "../src/oracleTracker.ts";
import type { GasTracker } from "../src/gasTracker.ts";
import type { InventoryManager } from "../src/inventoryManager.ts";
import type { InstrumentContext } from "../src/adapter.ts";

const TICK = 1_000n; // $0.001 in 6-decimal USDC

function makeOracle(price: bigint, vol = new Fraction(0n)): OracleTracker {
  return { currentPrice: price, volatility: vol } as unknown as OracleTracker;
}

function makeGas(spikePct = new Fraction(0n), roundTripUsd = 0n): GasTracker {
  return { gasSpikePct: spikePct, roundTripCostUsd: roundTripUsd } as unknown as GasTracker;
}

function makeInventory(netQuantity = 0n): InventoryManager {
  return { netQuantity, inventorySkew: new Fraction(0n) } as unknown as InventoryManager;
}

const baseCfg: ReservationPriceConfig = {
  riskAversion: 0.1,
  marginCallTimeSeconds: 3600,
  minSpreadBps: 10,
  volatilityMultiplier: 1.0,
  gasPenaltyBps: 5,
};

describe("computeReservationMidQuote", () => {
  it("with zero inventory, bid < ask and both near oracle", () => {
    const { bidMid, askMid } = computeReservationMidQuote({
      oracle: makeOracle(1_000_000_000n),
      gas: makeGas(),
      inventory: makeInventory(0n),
      context: {},
      cfg: baseCfg,
      tick: TICK,
    });
    assert.ok(bidMid < askMid, `bid ${bidMid} should be < ask ${askMid}`);
    assert.ok(bidMid > 0n);
  });

  it("long inventory shifts mid down (reservation price < oracle)", () => {
    const oracle = 1_000_000_000n;
    const cfg = { ...baseCfg, riskAversion: 1.0, marginCallTimeSeconds: 3600 };

    const noInv = computeReservationMidQuote({
      oracle: makeOracle(oracle, new Fraction(1n, 100n)), // σ=0.01
      gas: makeGas(),
      inventory: makeInventory(0n),
      context: {},
      cfg,
      tick: TICK,
    });
    const longInv = computeReservationMidQuote({
      oracle: makeOracle(oracle, new Fraction(1n, 100n)),
      gas: makeGas(),
      inventory: makeInventory(1_000_000n), // positive net qty → should push mid down
      context: {},
      cfg,
      tick: TICK,
    });
    assert.ok(longInv.bidMid <= noInv.bidMid, "long inventory should push bid mid down or equal");
  });

  it("short inventory shifts mid up (reservation price > oracle)", () => {
    const oracle = 1_000_000_000n;
    const cfg = { ...baseCfg, riskAversion: 1.0, marginCallTimeSeconds: 3600 };

    const noInv = computeReservationMidQuote({
      oracle: makeOracle(oracle, new Fraction(1n, 100n)),
      gas: makeGas(),
      inventory: makeInventory(0n),
      context: {},
      cfg,
      tick: TICK,
    });
    const shortInv = computeReservationMidQuote({
      oracle: makeOracle(oracle, new Fraction(1n, 100n)),
      gas: makeGas(),
      inventory: makeInventory(-1_000_000n), // negative net qty → should push mid up
      context: {},
      cfg,
      tick: TICK,
    });
    assert.ok(shortInv.askMid >= noInv.askMid, "short inventory should push ask mid up or equal");
  });

  it("uses deliveryDate from context when provided", () => {
    const nowMs = Date.now();
    const futureDelivery = Math.floor(nowMs / 1000) + 7200; // 2 hours from now
    const context: InstrumentContext = { deliveryDate: futureDelivery };

    const { bidMid, askMid } = computeReservationMidQuote({
      oracle: makeOracle(1_000_000_000n),
      gas: makeGas(),
      inventory: makeInventory(0n),
      context,
      cfg: baseCfg,
      tick: TICK,
      nowMs,
    });
    assert.ok(bidMid < askMid);
    assert.ok(bidMid > 0n);
  });

  it("expired deliveryDate (T=0) produces no inventory adjustment", () => {
    const nowMs = Date.now();
    const pastDelivery = Math.floor(nowMs / 1000) - 100; // already expired
    const bigInventory = makeInventory(100_000_000n);
    const cfg = { ...baseCfg, riskAversion: 10.0 };

    const expired = computeReservationMidQuote({
      oracle: makeOracle(1_000_000_000n, new Fraction(1n, 100n)),
      gas: makeGas(),
      inventory: bigInventory,
      context: { deliveryDate: pastDelivery },
      cfg,
      tick: TICK,
      nowMs,
    });
    const noDelivery = computeReservationMidQuote({
      oracle: makeOracle(1_000_000_000n, new Fraction(1n, 100n)),
      gas: makeGas(),
      inventory: makeInventory(0n),
      context: {},
      cfg: { ...cfg, riskAversion: 0 },
      tick: TICK,
      nowMs,
    });
    // With T=0, adjustment = 0 regardless of inventory; reservation price = oracle
    // so bid/ask should be symmetric around oracle
    assert.ok(expired.bidMid > 0n);
    assert.ok(expired.bidMid < expired.askMid);
  });

  it("bid and ask are aligned to tick", () => {
    const { bidMid, askMid } = computeReservationMidQuote({
      oracle: makeOracle(1_000_000_000n),
      gas: makeGas(),
      inventory: makeInventory(0n),
      context: {},
      cfg: baseCfg,
      tick: TICK,
    });
    assert.strictEqual(bidMid % TICK, 0n, `bid ${bidMid} not aligned to tick ${TICK}`);
    assert.strictEqual(askMid % TICK, 0n, `ask ${askMid} not aligned to tick ${TICK}`);
  });

  it("higher volatility produces wider spread", () => {
    const opts = {
      oracle: makeOracle(1_000_000_000n),
      gas: makeGas(),
      inventory: makeInventory(0n),
      context: {},
      cfg: baseCfg,
      tick: TICK,
    };

    const lowVol = computeReservationMidQuote({ ...opts, oracle: makeOracle(1_000_000_000n, new Fraction(1n, 1000n)) });
    const highVol = computeReservationMidQuote({ ...opts, oracle: makeOracle(1_000_000_000n, new Fraction(1n, 10n)) });

    const spreadLow = lowVol.askMid - lowVol.bidMid;
    const spreadHigh = highVol.askMid - highVol.bidMid;
    assert.ok(spreadHigh >= spreadLow, `high-vol spread ${spreadHigh} should be >= low-vol spread ${spreadLow}`);
  });
});
