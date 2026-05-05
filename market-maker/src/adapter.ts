import type { Chain, PublicClient, Transport } from "viem";
import type { WalletContext } from "./wallet.ts";

export type VenueKind = "perps" | "futures" | "options";

/** An order resting on the venue owned by the MM. */
export interface OwnOrder {
  orderId: `0x${string}`;
  price: bigint;
  /** Signed: positive = buy/long, negative = sell/short. */
  quantity: bigint;
  /** Optional instrument identifier (for multi-instrument venues like options). */
  instrumentId?: string;
}

/** A desired quote level produced by a pricing strategy. */
export interface QuoteLevel {
  price: bigint;
  /** Signed: positive = buy/long, negative = sell/short. */
  quantity: bigint;
}

export interface DesiredQuotes {
  bids: QuoteLevel[];
  asks: QuoteLevel[];
}

/** Position snapshot for a single instrument. */
export interface Position {
  netQuantity: bigint;
  entryPrice: bigint;
}

/** A single resting price level (one side) of an order book. */
export interface DepthLevel {
  price: bigint;
  /** Always positive (aggregate quantity at this price). */
  quantity: bigint;
}

/** Snapshot of one instrument's order book. */
export interface OrderBookSnapshot {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

/** Collateral snapshot shared by the venue's entire account (may span multiple instruments). */
export interface CollateralSnapshot {
  /** Collateral deposited into the venue. */
  balance: bigint;
  /** Maintenance margin required across all open positions. */
  maintenanceMargin: bigint;
  /** Non-deposited wallet balance of the collateral token (can be deposited). */
  walletTokenBalance: bigint;
  /** Native gas token balance (for paying gas). */
  nativeBalance: bigint;
  /** Address of the collateral ERC-20 token. */
  collateralTokenAddress: `0x${string}`;
}

/** Venue-specific hint data that pricing strategies can consume. */
export interface InstrumentContext {
  /** Unix seconds of delivery / expiry (optional). */
  deliveryDate?: number;
  /** Contract multiplier (e.g. futures days-to-delivery). */
  contractMultiplier?: bigint;
  /** Strike price (options). */
  strike?: bigint;
  /** Call vs put (options). */
  isCall?: boolean;
  /** Underlying spot (options). */
  underlyingSpot?: bigint;
}

export type VenueEvent =
  | { type: "order-created"; order: OwnOrder; isOwn: boolean }
  | { type: "order-cancelled"; orderId: `0x${string}`; isOwn: boolean; instrumentId?: string }
  | { type: "order-updated"; orderId: `0x${string}`; newQuantity: bigint; isOwn: boolean; instrumentId?: string }
  | { type: "order-matched"; makerOrderId: `0x${string}`; isOwn: boolean; instrumentId?: string }
  | { type: "position-changed"; instrumentId?: string }
  | { type: "depth-changed"; price: bigint; isBid: boolean; newQuantity: bigint; instrumentId?: string };

export type Unsubscribe = () => void;

/**
 * Per-instrument interface. Perps/futures return a singleton; options returns one
 * per strike/expiry.
 */
export interface InstrumentAdapter {
  readonly id: string;
  readonly venue: VenueAdapter;

  getIndexPrice(): Promise<bigint>;
  getMinTick(): Promise<bigint>;
  getOwnOrders(): Promise<OwnOrder[]>;
  getPosition(): Promise<Position>;
  getContext(): Promise<InstrumentContext>;
  /** Snapshot of the resting order book (for full resync). `depth` caps levels per side. */
  getOrderBookSnapshot(opts?: { depth?: number }): Promise<OrderBookSnapshot>;

  buildCancelCalldata(orderId: `0x${string}`): `0x${string}`;
  buildCreateCalldata(price: bigint, quantity: bigint): `0x${string}`;

  /**
   * Estimate gas for a representative createOrder, used by GasTracker.calibrate.
   * Returns 0n on failure.
   */
  estimateCreateGas(account: `0x${string}`): Promise<bigint>;
}

/**
 * Per-venue interface. One per deployed process (a process today has exactly one venue,
 * but that may grow). Owns the wallet, collateral, multicall and events.
 */
export interface VenueAdapter {
  readonly kind: VenueKind;
  readonly wallet: WalletContext;
  readonly publicClient: PublicClient;
  readonly chain: Chain;
  readonly transport: Transport;

  /** Contract address used for tx target and events subscription. */
  readonly address: `0x${string}`;

  listInstruments(): Promise<InstrumentAdapter[]>;
  getCollateral(): Promise<CollateralSnapshot>;
  topUpCollateral(amount: bigint): Promise<void>;

  /** Batch cancels/creates across one or more instruments. Returns tx hash. */
  multicall(calls: `0x${string}`[], opts: { maxFeePerGas?: bigint }): Promise<`0x${string}`>;

  /**
   * Subscribe to venue-level events affecting the MM's own orders/positions.
   * Implementations should filter to the MM's wallet address internally.
   */
  subscribeVenueEvents(handler: (event: VenueEvent) => void): Unsubscribe;

  /**
   * Optional: initial bootstrap read from contract history (past events). Used to
   * seed BookTracker/InventoryManager before live events start flowing.
   * Implementations that don't need this can no-op.
   */
  bootstrapFromHistory?(opts: { fromBlock?: bigint }): Promise<void>;
}
