import type { Address } from "viem";

/**
 * Per-account inputs needed to evaluate `mmRequired(P)` and `imRequired(P)`
 * off-chain at an arbitrary spot price `P`. Captured as a snapshot so the
 * predictor can re-evaluate at any new price without further RPC reads.
 *
 * Shapes deliberately mirror the on-chain getters:
 *   - perps: `getUserPosition` + `getOrderMargin` + `getPendingFunding`
 *   - futures: `getActiveDeliveryDates`/`getUserPosition` + `getFuturesOrderMargin`
 *
 * Bigints throughout because PME math is performed in token-decimal units
 * (typically USDC = 6 decimals) with intermediate WAD scaling. JS numbers
 * lose precision at the dollar level for typical position sizes.
 */
export interface AccountSnapshot {
  user: Address;
  /** Vault balance (token decimals). */
  balance: bigint;

  /** Perps single netted position (zero-qty if user has no perp exposure). */
  perp: {
    /** Signed; +long, −short. Scaled by 10^perpQuantityDecimals. */
    netQty: bigint;
    /** Token decimals (matches `getMarketPrice`). */
    entryPrice: bigint;
    /** Constant in P: `getOrderMargin(user)` (token decimals). */
    orderMargin: bigint;
    /** `max(0, getPendingFunding(user))` snapshot (token decimals). */
    fundingOwed: bigint;
  };

  /**
   * One entry per active futures expiry. Unilateral aggregate per
   * `(user, deliveryAt)`: signed `netQuantity` (whole contracts) +
   * `netEntryValue` (token decimals) so unrealized PnL is
   * `P * netQuantity - netEntryValue`.
   */
  futures: {
    positions: Array<{
      deliveryAt: bigint;
      /** Signed whole contracts (+long / −short). */
      netQuantity: bigint;
      /** Token decimals; `sum(fillPrice * signedFillQty)`. */
      netEntryValue: bigint;
    }>;
    /** Constant in P: `getFuturesOrderMargin(user)`. */
    orderMargin: bigint;
  };
}

/**
 * Engine-wide constants needed by the off-chain MM math. Read once during
 * snapshot setup and cached — they only change on PME admin transactions.
 */
export interface MMParams {
  /** WAD-scaled (e.g. 0.05e18 = 5%). */
  imSpotShock: bigint;
  /** WAD-scaled (e.g. 0.10e18 = 10%). */
  mmSpotShock: bigint;
  /** Decimals of the venues' answer (USDC = 6). */
  tokenDecimals: number;
  /** Perps quantity decimals (typically 6). */
  perpQuantityDecimals: number;
}

/**
 * Per-account price thresholds derived from the snapshot. `undefined` means
 * the user is structurally not liquidatable on that side (e.g. flat or
 * already deeply healthy at any plausible price).
 */
export interface PriceThresholds {
  user: Address;
  /** Liquidatable when spot drops to or below this. */
  liqDown: bigint | undefined;
  /** Liquidatable when spot rises to or above this. */
  liqUp: bigint | undefined;
}

/**
 * Per-account IM-utilization alert thresholds. Same {down, up} pattern as
 * `PriceThresholds`, just one set per severity. `undefined` on a level
 * means the user is already over (or structurally cannot reach) that
 * level — the sweep alert path covers the "already over" case.
 */
export interface AlertThresholds {
  user: Address;
  warnDown: bigint | undefined;
  warnUp: bigint | undefined;
  critDown: bigint | undefined;
  critUp: bigint | undefined;
}

/** One expiry leg of a futures close-to-IM batch. */
export interface FuturesCloseLeg {
  deliveryAt: bigint;
  /** Absolute contracts to close toward zero (≤ |netQuantity|). */
  closeQty: bigint;
}
