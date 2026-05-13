import type { Address, Hex } from "viem";

/**
 * Opaque per-venue market identifier.
 *
 * Encoded forms (callers MUST treat this as opaque — only the venue itself
 * decodes it):
 *   - perps:   sentinel `keccak256("perps")` (single market)
 *   - futures: bytes32(uint256(deliveryAt))
 *   - options: keccak256(abi.encode(strike, expiry))
 *
 * Kept opaque so the coordinator can rank cross-market positions without
 * caring which specific kind of market they live in. The `Venue.marketLabel`
 * method renders human-friendly strings for alerts and logs.
 */
export type MarketId = Hex;

export interface VenueOrder {
  id: Hex;
  marketId: MarketId;
}

export interface VenuePosition {
  id: Hex;
  marketId: MarketId;
  /** Loss in collateral-token decimals; 0 if break-even or in profit. */
  unrealizedLoss: bigint;
  /** Notional value of the position (price × |qty|), collateral-token decimals. */
  notional: bigint;
}

export type LiquidateOrdersOutcome =
  | { feeEarned: bigint }
  | { skipped: "notLiquidatable" };

export type LiquidatePositionOutcome =
  | { feeEarned: bigint }
  | { skipped: "unprofitable" | "notLiquidatable" | "ordersStillOpen" };

/**
 * Cross-product abstraction the coordinator and planner consume. Each venue
 * (Perps, Futures, Options) implements this same surface so the rest of the
 * keeper is venue-agnostic.
 *
 * Multi-market awareness is intentional even though Perps is single-market
 * today — Futures has many delivery dates and Options is M×N (strike ×
 * expiry). Returning `marketId`-tagged orders/positions lets the coordinator
 * rank "most underwater" across markets within a venue without leaking
 * venue-specific concepts.
 */
export interface Venue {
  readonly name: "perps" | "futures" | "options";

  /**
   * Human-readable label for a `marketId`. Used in alert payloads and logs.
   * Examples: `"perps"`, `"futures 2025-08-29"`, `"options BTC-29000C-26AUG"`.
   */
  marketLabel(marketId: MarketId): string;

  /** All resting orders the user owns at this venue (across markets). */
  readOpenOrders(user: Address): Promise<VenueOrder[]>;

  /** All active positions the user holds at this venue (across markets). */
  readPositions(user: Address): Promise<VenuePosition[]>;

  /**
   * Calls `liquidateOrders` on the venue. Cancels across all markets owned by
   * `user` (or the supplied `ids` for venues that take a calldata id list).
   *
   * - Perps: takes `ids[]` so the keeper can multicall specific high-margin orders.
   * - Futures: ignores `ids` — the contract sweeps FIFO until healthy.
   * - Options: TBD when added.
   */
  liquidateOrders(user: Address, ids?: readonly Hex[]): Promise<LiquidateOrdersOutcome>;

  /**
   * Calls `liquidatePosition(user, id)` on the venue. `id` is unique within the
   * venue across all markets. Reverts on-chain with `OrdersStillOpen` if any
   * orders remain — the venue surface translates that into
   * `{ skipped: "ordersStillOpen" }` so the coordinator can re-run
   * `liquidateOrders` without crashing the plan.
   */
  liquidatePosition(user: Address, id: Hex): Promise<LiquidatePositionOutcome>;
}
