import type {
  Account,
  Chain,
  ContractFunctionParameters,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";

// ─── Order intents ───────────────────────────────────────────────────────────

/**
 * Side of a quote/order. The signed-bigint convention is intentionally NOT used
 * at this boundary — quoter/executor pass `side` explicitly, the adapter chooses
 * what sign convention to encode for its venue.
 */
export type Side = "buy" | "sell";

/**
 * A single new-order intent. `size` is unsigned and in the **venue's native
 * unit** (e.g. perps uses QUANTITY_SCALE bigints, futures uses int8 contract
 * counts cast to bigint). Each adapter validates the unit internally.
 */
export interface OrderIntent {
  side: Side;
  price: bigint;
  size: bigint;
}

export interface CancelIntent {
  orderId: `0x${string}`;
}

/**
 * Batch of cancellations and creations the adapter should execute on-chain.
 * Cancels always process before creates within each tx.
 */
export interface ExecuteOrdersIntent {
  cancels: CancelIntent[];
  creates: OrderIntent[];
  /** Gas price cap. If not set, the wallet estimates from the network. */
  maxFeePerGas?: bigint;
  /** If true, log what would be done but don't broadcast txs. */
  dryRun?: boolean;
}

/** Result from {@link InstrumentAdapter.executeOrders}. */
export interface ExecuteOrdersResult {
  /** Receipts from successful tx chunks (for gas tracking). */
  receipts: { gasUsed: bigint; effectiveGasPrice: bigint }[];
  /** Non-fatal errors from failed tx chunks. */
  errors: Error[];
}

// ─── Resting state types ────────────────────────────────────────────────────

/** An order resting on the venue owned by the MM. */
export interface OwnOrder {
  orderId: `0x${string}`;
  price: bigint;
  side: Side;
  /** Unsigned size in venue-native units. */
  size: bigint;
  /** Optional instrument identifier (for multi-instrument venues). */
  instrumentId?: string;
}

export interface OwnOrderEvent {
  type: "added" | "updated" | "removed";
  order?: OwnOrder;
  orderId: `0x${string}`;
}

/** Position snapshot for a single instrument. */
export interface Position {
  /** Signed: positive = long, negative = short. Venue-native units. */
  netQuantity: bigint;
  entryPrice: bigint;
}

/** A single resting depth level (one side). */
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

// ─── Collateral & risk types ────────────────────────────────────────────────

/**
 * Collateral / portfolio-margin snapshot for the MM's wallet at the current
 * block. All values are unsigned token-decimals except `venueUnrealizedPnl`,
 * which is signed (negative = mark-to-market loss).
 *
 * `vaultBalance` is the canonical "how much do I have" — both perps and futures
 * route balanceOf through CollateralVault.
 *
 * `portfolioIM` and `portfolioMM` are unsigned by the engine's contract.
 * Anything below MM is liquidatable; anything below IM blocks new orders.
 */
export interface CollateralSnapshot {
  vaultBalance: bigint;
  portfolioIM: bigint;
  portfolioMM: bigint;
  venueOrderMargin: bigint;
  venueUnrealizedPnl: bigint;
  walletTokenBalance: bigint;
  nativeBalance: bigint;
  collateralToken: `0x${string}`;
}

/**
 * Per-venue collateral + portfolio-margin facade used by core. Concrete
 * adapters implement this against {perps DEX, futures} + the shared
 * CollateralVault + PortfolioMarginEngine.
 */
export interface CollateralAccount {
  /** One-shot read of all collateral / margin signals. Multicalled on chain. */
  snapshot(): Promise<CollateralSnapshot>;
  /** Cached spot price of the engine's IM shock factor (used for IM estimation). */
  imSpotShock(): Promise<bigint>;
  /**
   * Deposit `amount` of the collateral token from the wallet into the vault.
   * Adapter chooses permit vs approve+deposit; both end at vault.deposit*.
   */
  deposit(amount: bigint): Promise<void>;
  /**
   * Pre-trade gate: `engine.canPlaceOrder(wallet, additionalIM)`.
   * Returns true iff the wallet would still be at-or-above its IM after
   * adding `additionalIM` to current portfolio IM.
   */
  canPlace(additionalIM: bigint): Promise<boolean>;
}

/**
 * A `snapshot()` decomposed into its underlying multicall reads so the
 * portfolio account can batch every venue into a single RPC round trip.
 *
 * `shared` reads are portfolio-wide (vault balance, IM/MM, wallet token, native
 * balance) and therefore **identical across venues** for a given wallet — the
 * aggregator reads them once. `venue` reads are venue-specific (order margin,
 * unrealized PnL). `decode` reconstructs the snapshot from the concatenated
 * results in `[...shared, ...venue]` order.
 */
export interface MarginReadPlan {
  shared: ContractFunctionParameters[];
  venue: ContractFunctionParameters[];
  decode(results: readonly unknown[]): CollateralSnapshot;
}

/**
 * A collateral account that can expose its reads for batched aggregation.
 * Implemented by the concrete venue accounts (perps, futures); the portfolio
 * aggregator uses it to fuse all venues' reads into one multicall.
 */
export interface BatchableCollateralAccount extends CollateralAccount {
  buildMarginReadPlan(): Promise<MarginReadPlan>;
}

export function isBatchableCollateralAccount(
  account: CollateralAccount,
): account is BatchableCollateralAccount {
  return (
    typeof (account as BatchableCollateralAccount).buildMarginReadPlan === "function"
  );
}

// ─── Instrument context (venue-specific hints for pricing) ──────────────────

export interface InstrumentContext {
  /** Unix seconds of delivery / expiry, if any. */
  expirationAt?: number;
  /** Strike price (options). */
  strike?: bigint;
  /** Call vs put (options). */
  isCall?: boolean;
  /** Underlying spot (options). */
  underlyingSpot?: bigint;
}

// ─── Order book / matching mode ─────────────────────────────────────────────

/**
 * "limit" — orders match at any better-or-equal price (perps).
 * "exact" — orders only match at the exact submitted price (futures).
 *
 * Drives stale-order detection in OrderExecutor.
 */
export type MatchingMode = "limit" | "exact";

export interface BookSource {
  readonly matchingMode: MatchingMode;
  /** Smallest price step on the venue. */
  tick(): Promise<bigint>;
  /** Snapshot of resting depth (best `depth` levels per side). */
  snapshot(opts?: { depth?: number }): Promise<OrderBookSnapshot>;
}

// ─── Own-order source ───────────────────────────────────────────────────────

export type Unsubscribe = () => void;

/**
 * Per-instrument "what orders do I have resting" facade.
 *
 * Perps' implementation reads on-chain (`getUserOrders`) and is stateless.
 * Futures' implementation maintains a local cache because the contract has
 * no equivalent view; the cache is seeded by `bootstrap()` and updated by
 * an internal subscription to venue events. Either way, callers only see
 * `list()` / `subscribe()` / `bootstrap()`.
 */
export interface OwnOrderSource {
  /** Current set of resting own orders. */
  list(): Promise<OwnOrder[]>;
  /** Notify on adds/removes/updates. */
  subscribe(cb: (event: OwnOrderEvent) => void): Unsubscribe;
  /**
   * One-shot warm-up. Implementations must be idempotent: calling twice with
   * the same `fromBlock` produces the same final state.
   */
  bootstrap(opts?: { fromBlock?: bigint }): Promise<void>;
}

// ─── Venue events (decode-only) ─────────────────────────────────────────────

/**
 * Decoded venue event. Adapters emit these from `VenueEvents.subscribe`.
 *
 * The contract is decode-only — `subscribe` MUST NOT mutate adapter-internal
 * state. State that needs to be tracked from events lives in the adapter's
 * own `OwnOrderSource` cache (futures) or is recomputed on each call to
 * `OwnOrderSource.list()` (perps).
 */
export type VenueEvent =
  | {
      type: "order-created";
      orderId: `0x${string}`;
      participant: `0x${string}`;
      price: bigint;
      side: Side;
      size: bigint;
      instrumentId?: string;
      /** Futures expiry (unix seconds) the order belongs to; undefined for perps. */
      expirationAt?: bigint;
    }
  | {
      type: "order-updated";
      orderId: `0x${string}`;
      participant: `0x${string}`;
      newSize: bigint;
      instrumentId?: string;
    }
  | {
      type: "order-cancelled";
      orderId: `0x${string}`;
      participant?: `0x${string}`;
      instrumentId?: string;
    }
  | {
      type: "order-matched";
      makerOrderId: `0x${string}`;
      maker?: `0x${string}`;
      taker?: `0x${string}`;
      instrumentId?: string;
    }
  | {
      type: "position-changed";
      participant: `0x${string}`;
      instrumentId?: string;
    };

export interface VenueEvents {
  subscribe(cb: (event: VenueEvent) => void): Unsubscribe;
}

// ─── Wallet context ─────────────────────────────────────────────────────────

export interface WalletContext {
  name: string;
  account: Account;
  walletClient: WalletClient;
}

// ─── Instrument adapter ─────────────────────────────────────────────────────

/**
 * Per-instrument interface. Perps and futures return a singleton from
 * `VenueAdapter.getInstrument()`; an options venue would expose many.
 */
export interface InstrumentAdapter {
  readonly id: string;
  readonly venue: VenueAdapter;
  readonly book: BookSource;
  readonly ownOrders: OwnOrderSource;

  getIndexPrice(): Promise<bigint>;
  getPosition(): Promise<Position>;
  getContext(): Promise<InstrumentContext>;

  encodeCreate(intent: OrderIntent): `0x${string}`;
  encodeCancel(intent: CancelIntent): `0x${string}`;

  /**
   * Relative gas weight of placing this create, in "cost units" where one unit
   * is roughly the cheapest single call. The shared `TxCoordinator` sums these
   * against one per-tx budget when chunking a venue batch, so venues with very
   * different per-call gas profiles share one limiter:
   *   - Perps:   1 per order — a create is one price-level insertion.
   *   - Futures: `size` (qty) — `createOrder(…, int8 qty)` does one unit of
   *              work per contract, so gas scales with total qty, not calls.
   * Cancels are always weight 1 (the coordinator assumes this).
   */
  createCallWeight(intent: OrderIntent): number;

  /**
   * Execute a batch of order cancellations and creations on-chain.
   *
   * The adapter owns the full lifecycle: encoding, batching, tx chunking,
   * nonce sequencing, and gas optimisation. The caller receives receipts
   * for gas tracking and any non-fatal errors from failed tx chunks.
   *
   * Cancels are always processed before creates within each tx to free
   * margin before adding new risk.
   */
  executeOrders(intent: ExecuteOrdersIntent): Promise<ExecuteOrdersResult>;

  /**
   * Estimate the additional Initial Margin a new order would add to the
   * wallet's portfolio IM. Used by RiskManager to call
   * `engine.canPlaceOrder(wallet, sumAdditionalIM)` before placing.
   *
   * Mirrors the on-chain margin computation for the venue:
   *   - Perps:  imSpotShock × notional / 1e18
   *   - Futures: pricePerDay × marginPct / 100 (one unit, no duration multiplier)
   *
   * Adapter computes synchronously from already-cached state (imSpotShock,
   * marginPct). Returns 0n if it can't be estimated yet.
   */
  estimateOrderMargin(intent: OrderIntent): bigint;

  /**
   * Estimate gas for a representative createOrder. Used by GasTracker.calibrate.
   * Returns 0n on failure.
   */
  estimateCreateGas(account: `0x${string}`): Promise<bigint>;
}

// ─── Venue adapter ──────────────────────────────────────────────────────────

export type VenueKind = "perps" | "futures";

/**
 * Per-venue interface. One per process; owns the wallet, the multicall route,
 * the venue-events stream, and the collateral account. Single-instrument
 * venues (perps, futures) expose `getInstrument()` directly; a future
 * multi-instrument venue (options) would expose `listInstruments()` instead.
 */
export interface VenueAdapter {
  readonly kind: VenueKind;
  readonly wallet: WalletContext;
  readonly publicClient: PublicClient;
  readonly chain: Chain;
  readonly transport: Transport;
  /** Contract address used for tx target and event subscription. */
  readonly address: `0x${string}`;

  readonly events: VenueEvents;
  readonly account: CollateralAccount;

  /**
   * The MM's primary instrument on this venue. For single-instrument venues
   * (perps) this is the only book; for multi-instrument venues (futures across
   * expiries) it is the nearest one. Kept for back-compat and single-market
   * callers; prefer {@link listInstruments} for the portfolio runner.
   */
  getInstrument(): Promise<InstrumentAdapter>;

  /**
   * All instruments this venue currently wants quoted. Perps returns a single
   * element; futures returns one `InstrumentAdapter` per selected delivery
   * date. The set can change over time (futures roll) — callers re-invoke to
   * pick up added/dropped markets.
   */
  listInstruments(): Promise<InstrumentAdapter[]>;

  /**
   * Batch cancels/creates in one tx. Returns tx hash. Implementations route
   * through the venue contract's multicall function. `nonce` is supplied by the
   * shared NonceManager when the portfolio runner sequences multi-venue txs.
   */
  multicall(
    calls: `0x${string}`[],
    opts: { maxFeePerGas?: bigint; nonce?: number },
  ): Promise<`0x${string}`>;
}
