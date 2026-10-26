/**
 * A 20-byte account address. Declared locally rather than imported from viem so
 * this package stays dependency-free and can be consumed by the keeper (Node)
 * and the UI (bundler) without pinning either to a viem version. Structurally
 * identical to viem's `Address`, so values pass between them freely.
 */
export type Address = `0x${string}`;

/**
 * A resting book reduced to what the margin math needs: per side, the quantity and
 * the first two price moments, exactly as the venue's `RestingOrderAggregate`
 * stores them (perps `getOrderAggregate`, futures `getOrderAggregateAtExpiration`).
 *
 * Nothing here is constant in P. The engine stresses order delta (the quantity) as
 * part of net delta, and the venues charge each side's fill loss as Scarf's bound
 * from these three sums (`fillLossBound` in `mm.ts`): convex in P, never below the
 * loss of any book with the same sums, so a deep order cannot hide a marketable one.
 *
 * Quantities are in the venue's own units (perps `10^perpQuantityDecimals`, futures
 * whole contracts) and prices in token decimals, unscaled: `Σ price · qty`.
 */
export interface RestingOrders {
  /** Σ|q| over resting bids. */
  buyQty: bigint;
  /** Σ|q| over resting asks. */
  sellQty: bigint;
  /** Σ price · |q| over resting bids. */
  buyPQ: bigint;
  /** Σ price² · |q| over resting bids. */
  buyP2Q: bigint;
  /** Σ price · |q| over resting asks. */
  sellPQ: bigint;
  /** Σ price² · |q| over resting asks. */
  sellP2Q: bigint;
}

/**
 * One futures expiry's resting book. The venue bounds fill loss per expiry, at that
 * expiry's own price, and sums the bounds; pooling expiries first would give a
 * different (larger) bound than the engine sees.
 */
export interface FuturesRestingOrders extends RestingOrders {
  expirationAt: bigint;
  /**
   * `Futures.settlementPrice(expirationAt)`; `0` until the expiry settles. Non-zero
   * pins this expiry's fill loss at that price instead of the live mark.
   */
  settlementPrice: bigint;
}

/**
 * Per-account inputs needed to evaluate `mmRequired(P)` and `imRequired(P)`
 * off-chain at an arbitrary spot price `P`. Captured as a snapshot so the
 * predictor can re-evaluate at any new price without further RPC reads.
 *
 * Shapes deliberately mirror the on-chain getters:
 *   - perps: `getRiskView` + `getOrderAggregate` + `getUserPosition`
 *   - futures: `getRiskView` + `getOrderAggregate` + `getActiveExpirationDates`/`getUserPosition`
 *
 * Bigints throughout because PME math is performed in token-decimal units
 * (typically USDC = 6 decimals) with intermediate WAD scaling. JS numbers
 * lose precision at the dollar level for typical position sizes.
 */
export interface AccountSnapshot {
  user: Address;
  /** Vault balance (token decimals). */
  balance: bigint;
  /** Unpaid loss owed to the insurance fund (token decimals). */
  accountDebt: bigint;

  /** Perps single netted position (zero-qty if user has no perp exposure). */
  perp: {
    /** Signed; +long, −short. Scaled by 10^perpQuantityDecimals. */
    netQty: bigint;
    /** Token decimals (matches `getMarketPrice`). */
    entryPrice: bigint;
    /** Resting perps book. */
    orders: RestingOrders;
    /** `max(0, getRiskView(user).pendingFunding)` snapshot (token decimals). */
    fundingOwed: bigint;
  };

  /**
   * One entry per active futures expiry. Unilateral aggregate per
   * `(user, expirationAt)`: signed `netQuantity` (whole contracts) +
   * `netEntryValue` (token decimals) so unrealized PnL is
   * `mark * netQuantity - netEntryValue`, where `mark` is the expiry's pinned
   * settlement price once it has one and the live index until then.
   */
  futures: {
    positions: Array<{
      expirationAt: bigint;
      /** Signed whole contracts (+long / −short). */
      netQuantity: bigint;
      /** Token decimals; `sum(fillPrice * signedFillQty)`. */
      netEntryValue: bigint;
      /**
       * `Futures.settlementPrice(expirationAt)`; `0` until the expiry settles.
       *
       * Non-zero means the leg is settled but not yet swept out of
       * `participantActiveExpirationAts`, which `getRiskView` treats specially:
       * the delta leaves `netPositionDelta` (the price is pinned, so there is no
       * directional risk left) while the PnL stays marked at this frozen price
       * rather than the live one. Both effects are constant in P, so a settled
       * leg drops out of the stress term and contributes only an offset to the
       * unrealized-PnL term.
       */
      settlementPrice: bigint;
    }>;
    /** Resting futures books, one per expiry in the tradable window that has orders. */
    orders: FuturesRestingOrders[];
  };
}

/**
 * Which of the two requirements is being evaluated.
 *
 * Not merely a shock selector. The engine's unrealized-PnL term is clamped once
 * per market for IM and once over the portfolio-wide signed sum for MM, so the
 * two requirements are different piecewise-linear functions of price with
 * different kink sets — see `mm.ts` and `solve.ts`.
 */
export type MarginRequirement = "im" | "mm";

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
  expirationAt: bigint;
  /** Absolute contracts to close toward zero (≤ |netQuantity|). */
  closeQty: bigint;
}
