import { parseUnits, type Address } from "viem";
import { hardhat } from "viem/chains";
import {
  deployStack,
  ORACLE_TO_MARKET_MULTIPLIER,
  type DeployedStack,
  type Wallet,
} from "./deployStack.ts";

/**
 * Fixture builders.
 *
 * Each builder returns a closure (`(): Promise<Fixture>`). The closure
 * itself is the cache key used by `loadFixture` — tests must hold the
 * returned closure in module scope, not recreate it per-test, otherwise
 * the snapshot cache won't engage and every test pays the full deploy
 * cost.
 *
 * Fixtures encode a *business state*, not just deploys: who has
 * deposited, who holds which positions, what stale orders are still
 * resting, what oracle level the markets sit at. The matching `make…`
 * method on each fixture triggers the price move that should turn the
 * scenario "interesting" (i.e. liquidatable). Tests then ask the keeper
 * what it did and helpers in `helpers.ts` translate that into specific
 * `assert` calls.
 *
 * Naming convention — every public builder is `<verb><Subject>FixtureBuilder`
 * so the test file reads naturally:
 *   `const f = perpsLongCrashFixtureBuilder(rpcUrl);`
 *   `const ctx = await loadFixture(f, testClient);`
 *   `await ctx.makeLiquidatable();`
 */

// ─────────────────────────────────────────────────────────────────────────
// Public fixture types
// ─────────────────────────────────────────────────────────────────────────

export interface BaseFixture extends DeployedStack {
  /** Write a raw hashprice *oracle answer* (per 100 TH/s·day). */
  bumpHashprice(newPrice: bigint): Promise<void>;
  bumpBtcUsdc(newPrice: bigint): Promise<void>;
  /**
   * Set the per-contract *mark* (`getMarketPrice()` value). Internally divides
   * by `ORACLE_TO_MARKET_MULTIPLIER` (×10 rebase) before writing the oracle, so
   * callers can reason in the same contract unit that orders/positions use.
   * Does not touch BTC/USDC — used to stage a fixture's at-the-money entry mark.
   */
  setMark(marketPrice: bigint): Promise<void>;
  /** Deposit USDC into the vault from the given (test-known) wallet. */
  deposit(userAddr: Address, amount: bigint): Promise<void>;
  /**
   * Apply a fresh mark and a *paired* BTC/USDC tick. The predictor only listens
   * to the BTC/USDC channel, so the second write is what makes the event-driven
   * liquidation path observable; the mark write is what actually moves PnL.
   *
   * The argument is a per-contract *mark* (contract unit), rebased ×10 down to
   * the oracle answer internally — the same unit as entry/order prices.
   *
   * `crashOracles` moves BTC/USDC *down* (long-side loss); `pumpOracles`
   * moves it *up* (short-side loss).
   */
  crashOracles(marketPrice: bigint): Promise<void>;
  pumpOracles(marketPrice: bigint): Promise<void>;
}

export interface AliceDepositFixture extends BaseFixture {
  aliceDeposit: bigint;
}

/** Alice holds a perps long that is healthy at the entry price. */
export interface PerpsLongFixture extends BaseFixture {
  aliceDeposit: bigint;
  aliceQty: bigint;
  /** Crash hashprice + BTC/USDC so Alice's long becomes liquidatable. */
  makeLiquidatable(): Promise<void>;
}

/** Alice holds a perps short that is healthy at the entry price. */
export interface PerpsShortFixture extends BaseFixture {
  aliceDeposit: bigint;
  /** Positive — the absolute value of alice's short. */
  aliceQty: bigint;
  /** Pump hashprice + BTC/USDC so Alice's short becomes liquidatable. */
  makeLiquidatable(): Promise<void>;
}

/** Two independent users both hold underwater positions after the crash. */
export interface TwoUnderwaterUsersFixture extends BaseFixture {
  /** Deeper-underwater user (closed first by mmSurplus priority). */
  worseDeposit: bigint;
  worseQty: bigint;
  worseUser: Address;
  /** Less-underwater user (closed second). */
  betterDeposit: bigint;
  betterQty: bigint;
  betterUser: Address;
  makeLiquidatable(): Promise<void>;
}

/** Alice holds a perps long *and* a resting buy order that didn't match. */
export interface PerpsOrdersAndPositionFixture extends PerpsLongFixture {
  /** Count of resting (unmatched) orders Alice has after setup. */
  restingOrderCount: number;
}

/** Alice holds a long futures contract (1 unit @ first delivery date). */
export interface FuturesLongFixture extends BaseFixture {
  aliceDeposit: bigint;
  aliceFuturesQty: number;
  makeLiquidatable(): Promise<void>;
}

/** Alice holds futures longs across multiple delivery dates. */
export interface MultiFuturesFixture extends BaseFixture {
  aliceDeposit: bigint;
  deliveryDates: readonly bigint[];
  makeLiquidatable(): Promise<void>;
}

/**
 * Alice holds many futures lots and takes a *moderate* crash — deep enough
 * to break MM but shallow enough that closing a strict subset of lots
 * restores the IM buffer. Contrast with `futuresLongCrashFixtureBuilder`
 * (a 99.8% crash that fully liquidates into bad debt). This is the anti-churn
 * scenario: one batched `liquidatePositions` call should land the account in
 * the `[MM, IM]` band with lots still open.
 */
export interface FuturesPartialCrashFixture extends BaseFixture {
  aliceDeposit: bigint;
  aliceFuturesQty: number;
  makeLiquidatable(): Promise<void>;
}

/**
 * Alice holds one perps net position and takes a *moderate* crash — below MM
 * but recoverable by a partial-qty close back into the `[MM, IM]` band. The
 * mirror of `FuturesPartialCrashFixture` for the perps `liquidatePosition(user,
 * closeQty)` partial path.
 */
export interface PerpsPartialCrashFixture extends BaseFixture {
  aliceDeposit: bigint;
  aliceQty: bigint;
  makeLiquidatable(): Promise<void>;
}

/**
 * Alice holds equal-size futures long books on TWO delivery dates (separate
 * markets) and takes the same *moderate* crash as `FuturesPartialCrashFixture`.
 * A subset close restores the IM buffer — and because every lot carries the
 * same per-day risk weight (duration-free, ±1 delta each) regardless of expiry,
 * the aggregate margin matches the single-expiry 12-lot case. Used to prove the
 * keeper's ONE `liquidatePositions` tx spreads the close *across both
 * expirations* instead of draining one book first.
 */
export interface MultiExpiryFuturesPartialCrashFixture extends BaseFixture {
  aliceDeposit: bigint;
  /** The two delivery dates Alice holds lots on. */
  deliveryDates: readonly [bigint, bigint];
  /** Lots per delivery date (equal split). */
  perExpiryQty: number;
  makeLiquidatable(): Promise<void>;
}

/** Alice holds a futures long AND has a resting (unmatched) buy order. */
export interface FuturesOrdersAndPositionFixture extends FuturesLongFixture {
  /** Count of resting orders held by alice at fixture time. */
  restingOrderCount: number;
}

/** Alice has both perps + futures legs underwater after the crash. */
export interface CrossVenueFixture extends BaseFixture {
  aliceDeposit: bigint;
  alicePerpsQty: bigint;
  aliceFuturesQty: number;
  makeLiquidatable(): Promise<void>;
}

/**
 * Alice has perps + futures *positions* AND a resting order on each
 * venue. The crash makes everything underwater so the planner has to run
 * its full two-leg flow (orders across both venues, then positions).
 */
export interface CrossVenueOrdersAndPositionsFixture extends CrossVenueFixture {
  perpsRestingOrderCount: number;
  futuresRestingOrderCount: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Base fixture
// ─────────────────────────────────────────────────────────────────────────

/** Convert a per-contract mark into the raw oracle answer the venues rebase ×10. */
function markToOracle(marketPrice: bigint): bigint {
  return marketPrice / ORACLE_TO_MARKET_MULTIPLIER;
}

export async function baseFixture(rpcUrl: string): Promise<BaseFixture> {
  const stack = await deployStack(rpcUrl);
  return {
    ...stack,
    bumpHashprice: (price) => writeOracle(stack, stack.addresses.hashpriceOracle, price),
    bumpBtcUsdc: (price) => writeOracle(stack, stack.addresses.btcUsdcFeed, price),
    setMark: (marketPrice) =>
      writeOracle(stack, stack.addresses.hashpriceOracle, markToOracle(marketPrice)),
    deposit: (user, amount) => depositTo(stack, user, amount),
    crashOracles: async (marketPrice) => {
      await writeOracle(stack, stack.addresses.hashpriceOracle, markToOracle(marketPrice));
      const movedBtc = (stack.config.initialBtcUsdc * 9n) / 10n;
      await writeOracle(stack, stack.addresses.btcUsdcFeed, movedBtc);
    },
    pumpOracles: async (marketPrice) => {
      await writeOracle(stack, stack.addresses.hashpriceOracle, markToOracle(marketPrice));
      const movedBtc = (stack.config.initialBtcUsdc * 11n) / 10n;
      await writeOracle(stack, stack.addresses.btcUsdcFeed, movedBtc);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Scenario builders
// ─────────────────────────────────────────────────────────────────────────

/**
 * Alice has just deposited collateral — no orders, no positions. Useful
 * only for verifying that the tracker discovers her via `Vault.Deposited`.
 */
export function aliceDepositFixtureBuilder(rpcUrl: string) {
  return async (): Promise<AliceDepositFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("100", base.config.tokenDecimals);
    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    return { ...base, aliceDeposit };
  };
}

/**
 * Alice holds a perps long that survives the entry-price IM check but is
 * deeply liquidatable after a price crash.
 *
 * Sizing math (see `_computeMargin` in PME):
 *   - IM at 10% shock: 40 · 0.10 · $4.21 = $16.84 → fits in $100 deposit.
 *   - After crash to $0.01: unrealized loss = ($4.21 − $0.01) · 40 = $168.
 *   - Vault balance ($100) < MM (~$168) ⇒ liquidatable by ~$68.
 */
export function perpsLongCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<PerpsLongFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("100", base.config.tokenDecimals);
    const bobDeposit = parseUnits("2000", base.config.tokenDecimals);
    const aliceQty = parseUnits("40", base.config.quantityDecimals);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      quantity: aliceQty,
    });

    return {
      ...base,
      aliceDeposit,
      aliceQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
    };
  };
}

/**
 * Mirror of `perpsLongCrashFixtureBuilder` for short-side coverage. Alice
 * sells (negative qty) into Bob's bid; a price *rise* makes her short
 * unrealized-loss climb past the deposit. Sizing is identical to the
 * long-side case (40 qty, $100 deposit) — symmetry test for the PnL sign
 * handling in `PerpsVenue.readPositions`.
 *
 *   - IM at entry: 40 · 0.10 · $4.21 = $16.84 → fits.
 *   - On price doubling to $8.42: unrealized loss = ($8.42 − $4.21) · 40 = $168.40.
 *   - Vault $100 < MM (~$168) ⇒ liquidatable.
 */
export function perpsShortCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<PerpsShortFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("100", base.config.tokenDecimals);
    const bobDeposit = parseUnits("2000", base.config.tokenDecimals);
    const aliceQty = parseUnits("40", base.config.quantityDecimals);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    // Bob bids, alice sells into it. Sign convention: positive qty = buy.
    await matchPerpsTrade(base, {
      buyer: base.accounts.bob,
      seller: base.accounts.alice,
      price: base.config.initialMarketPrice,
      quantity: aliceQty,
    });

    return {
      ...base,
      aliceDeposit,
      aliceQty,
      makeLiquidatable: () =>
        base.pumpOracles(parseUnits("8.42", base.config.oracleDecimals)),
    };
  };
}

/**
 * Two independent users (`alice` + `dave`) both go long perps. Alice has
 * a larger position so her post-crash `mmSurplus` is more negative than
 * dave's — she should be popped from the coordinator queue first.
 *
 * Bob is the shared counterparty taking the combined short.
 */
export function twoUnderwaterUsersFixtureBuilder(rpcUrl: string) {
  return async (): Promise<TwoUnderwaterUsersFixture> => {
    const base = await baseFixture(rpcUrl);
    // Both deposits are insufficient to cover the post-crash unrealized
    // loss; alice's deficit is bigger so her `mmSurplus` is more negative.
    const aliceDeposit = parseUnits("100", base.config.tokenDecimals);
    const daveDeposit = parseUnits("30", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const aliceQty = parseUnits("40", base.config.quantityDecimals); // ~$168 loss, $100 cover ⇒ −$68
    const daveQty = parseUnits("20", base.config.quantityDecimals); // ~$84 loss, $30 cover  ⇒ −$54

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.dave.account.address, daveDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    // One bob short covering both — placed first so both takers match it.
    await placePerpsOrder(
      base,
      base.accounts.bob,
      base.config.initialMarketPrice,
      -(aliceQty + daveQty),
    );
    await placePerpsOrder(base, base.accounts.alice, base.config.initialMarketPrice, aliceQty);
    await placePerpsOrder(base, base.accounts.dave, base.config.initialMarketPrice, daveQty);

    return {
      ...base,
      worseDeposit: aliceDeposit,
      worseQty: aliceQty,
      worseUser: base.accounts.alice.account.address,
      betterDeposit: daveDeposit,
      betterQty: daveQty,
      betterUser: base.accounts.dave.account.address,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
    };
  };
}

/**
 * Same as `perpsLongCrashFixtureBuilder` but at entry-time Alice *also*
 * places a far-away resting buy order that never matched. After the
 * crash the planner should walk the orders-leg first (cancelling the
 * resting order) and then the position-leg.
 *
 * The resting order's price is set below `minimumPriceIncrement * 1`
 * relative to the market so it can never cross with bob's bids in the
 * book — it's a deliberate stale-quote scenario.
 */
export function perpsOrdersAndPositionFixtureBuilder(rpcUrl: string) {
  return async (): Promise<PerpsOrdersAndPositionFixture> => {
    const base = await baseFixture(rpcUrl);
    // Same balance as `perpsLongCrashFixtureBuilder` — sized so the
    // post-crash MM ($168) exceeds the $100 deposit. Adding a resting
    // order on top barely moves IM at entry but lets us verify that
    // the planner walks the orders-leg as part of the same plan.
    const aliceDeposit = parseUnits("100", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const aliceQty = parseUnits("40", base.config.quantityDecimals);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      quantity: aliceQty,
    });

    const restingPrice = parseUnits("1.00", base.config.oracleDecimals);
    const restingQty = parseUnits("5", base.config.quantityDecimals);
    await placePerpsOrder(base, base.accounts.alice, restingPrice, restingQty);

    return {
      ...base,
      aliceDeposit,
      aliceQty,
      restingOrderCount: 1,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
    };
  };
}

/**
 * Alice holds a long futures contract at the first delivery date; Bob is
 * the matched seller. Duration-free model: one contract settles the per-day
 * value with a multiplier of 1 (no × delivery window), so at the $4.21 mark
 * each unit carries $4.21 of notional. A crash to a $0.01 mark inflicts
 * ($4.21 − $0.01) = $4.20 of unrealized loss per unit → 12 units = $50.40,
 * far exceeding Alice's post-fee balance ($40 − $12 taker fee = $28) so the
 * account is deeply underwater and fully liquidates into bad debt.
 */
export function futuresLongCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<FuturesLongFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("40", base.config.tokenDecimals);
    const bobDeposit = parseUnits("2000", base.config.tokenDecimals);
    const aliceFuturesQty = 12;

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      aliceFuturesQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.tokenDecimals)),
    };
  };
}

/**
 * Same as `futuresLongCrashFixtureBuilder` but Alice *also* places a
 * far-out-of-market resting buy order before the crash. The order never
 * matches (Bob doesn't offer a sell at $2/day), so it sits on the book
 * until the planner walks the orders-leg. After the crash, the planner
 * must run:
 *   1. `liquidateOrders(user)` on futures (FIFO sweep) → cancels the
 *      resting order;
 *   2. `liquidatePosition(user, id)` → cash-settles the position.
 */
export function futuresOrdersAndPositionFixtureBuilder(rpcUrl: string) {
  return async (): Promise<FuturesOrdersAndPositionFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("40", base.config.tokenDecimals);
    const bobDeposit = parseUnits("2000", base.config.tokenDecimals);
    const aliceFuturesQty = 12;

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    // Stale buy order well below the current $4.21 mark — no counterparty
    // exists at this price level so the order rests on the book.
    const restingPrice = parseUnits("2.00", base.config.tokenDecimals);
    await placeFuturesOrder(
      base,
      base.accounts.alice,
      restingPrice,
      base.config.futuresFirstDeliveryDate,
      1,
    );

    return {
      ...base,
      aliceDeposit,
      aliceFuturesQty,
      restingOrderCount: 1,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.tokenDecimals)),
    };
  };
}

/**
 * Alice holds futures longs on *two* different delivery dates. After the
 * crash, the planner must iterate the position loop more than once
 * (worst-first by unrealized loss) and end with both positions closed.
 */
export function multiFuturesFixtureBuilder(rpcUrl: string) {
  return async (): Promise<MultiFuturesFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("40", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const firstDeliveryAt = base.config.futuresFirstDeliveryDate;
    // Must match on-chain Futures.EXPIRATION_INTERVAL_DAYS (= 30).
    const secondDeliveryAt = firstDeliveryAt + BigInt(30 * 24 * 3600);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    for (const deliveryAt of [firstDeliveryAt, secondDeliveryAt]) {
      await matchFuturesTrade(base, {
        buyer: base.accounts.alice,
        seller: base.accounts.bob,
        price: base.config.initialMarketPrice,
        deliveryAt,
        quantity: 6,
      });
    }

    return {
      ...base,
      aliceDeposit,
      deliveryDates: [firstDeliveryAt, secondDeliveryAt] as const,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.tokenDecimals)),
    };
  };
}

/**
 * Alice holds 12 long futures lots at the first delivery date; a moderate crash
 * drives her below MM while leaving enough headroom that closing a worst-first
 * subset of lots restores `balance >= IM`.
 *
 * Duration-free rescale (mirrors the unit `solveTarget` fixture): each contract
 * settles the per-day value ×1 (no ×7 window), so a shallow $4.21→$3.90 move no
 * longer clears the flat $1/lot liquidation fee (0.05·3.90 = $0.195 < $1) and a
 * partial close could never help. We therefore stage the book at a $40 mark and
 * crash to a $30 mark — the same shape used by the unit fixtures — so the
 * per-lot MM stress freed by a close (0.05·$30 = $1.50) exceeds the $1 fee.
 *
 * Sizing (PME shocks 10% IM / 5% MM, $1 flat liquidation fee, entry = $40 mark):
 *   - unrealized loss / lot after crash = (40 − 30) = $10
 *   - MM stress / lot = 0.05·30 = $1.50 ; IM stress / lot = 0.10·30 = $3.00
 *   - MM_req = 12·(1.50 + 10) = $138 > $136 deposit ⇒ underwater by ~$2
 *   - IM_req = 12·(3.00 + 10) = $156
 *   - each closed lot nets +$0.50 to MM surplus ($1.50 stress − $1 fee) and
 *     +$2.00 to IM surplus ($3.00 stress − $1 fee), so closing ~10 lots lands
 *     the account on the IM boundary with 2 lots still open — a genuine partial.
 * Entry IM (at the $40 mark, no PnL) = 12·0.10·40 = $48, well under the $136
 * deposit, so Alice can open pre-crash (taker fee zeroed — see below).
 */
export function futuresPartialCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<FuturesPartialCrashFixture> => {
    const base = await baseFixture(rpcUrl);
    // Stage the entry mark at $40 (oracle answer $4.00 × 10). Larger than the
    // default $4.21 so the moderate-crash stress clears the flat liquidation fee.
    const entryMark = parseUnits("40", base.config.tokenDecimals);
    await base.setMark(entryMark);

    const aliceDeposit = parseUnits("136", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const aliceFuturesQty = 12;

    // Zero the futures taker fee for this fixture only so the entry IM ($48)
    // isn't inflated by the $1/lot open cost; the $1/lot *liquidation* fee still
    // applies to the sweep (so the solver's fee-aware sizing is exercised).
    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: entryMark,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      aliceFuturesQty,
      // Moderate crash: $40 → $30 mark. Deep enough to break MM, shallow enough
      // that a subset of lots restores the IM buffer.
      makeLiquidatable: () => base.crashOracles(parseUnits("30", base.config.tokenDecimals)),
    };
  };
}

/**
 * Alice holds 6 long futures lots on EACH of two delivery dates (12 total),
 * then takes the same moderate crash ($40 → $30 mark) as
 * `futuresPartialCrashFixtureBuilder`. In the duration-free model each lot
 * carries the same per-day risk weight (multiplier 1) regardless of which date
 * it expires on, so the aggregate MM/IM and unrealized loss are identical to the
 * single-expiry 12-lot fixture — the same $136 deposit breaks MM and a
 * worst-first subset restores the IM buffer. The distinction under test: the
 * keeper's ONE `liquidatePositions` sweep must close lots from BOTH expirations
 * (balanced), not empty the first book before touching the second.
 */
export function futuresMultiExpiryPartialCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<MultiExpiryFuturesPartialCrashFixture> => {
    const base = await baseFixture(rpcUrl);
    // Stage the entry mark at $40 (see `futuresPartialCrashFixtureBuilder`).
    const entryMark = parseUnits("40", base.config.tokenDecimals);
    await base.setMark(entryMark);

    const aliceDeposit = parseUnits("136", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const perExpiryQty = 6;
    const firstDeliveryAt = base.config.futuresFirstDeliveryDate;
    const secondDeliveryAt = firstDeliveryAt + BigInt(30 * 24 * 3600); // Futures.EXPIRATION_INTERVAL_DAYS

    // Zero the taker fee (see `futuresPartialCrashFixtureBuilder`) so the 12-lot
    // entry IM ($48) fits the $136 deposit; the liquidation fee still applies.
    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    for (const deliveryAt of [firstDeliveryAt, secondDeliveryAt]) {
      await matchFuturesTrade(base, {
        buyer: base.accounts.alice,
        seller: base.accounts.bob,
        price: entryMark,
        deliveryAt,
        quantity: perExpiryQty,
      });
    }

    return {
      ...base,
      aliceDeposit,
      deliveryDates: [firstDeliveryAt, secondDeliveryAt] as const,
      perExpiryQty,
      makeLiquidatable: () => base.crashOracles(parseUnits("30", base.config.tokenDecimals)),
    };
  };
}

/**
 * Alice holds a single 40-qty perps long; a moderate crash (4.21 → 3.00)
 * puts her below MM but a *partial* qty close restores `balance >= IM`.
 * Sizing (PME 10% IM / 5% MM, $1 perps liquidation fee):
 *   - loss / qty after crash = (4.21 − 3.00) = $1.21
 *   - MM stress / qty = 0.05 · 3.00 = $0.15, IM stress = $0.30
 *   - MM_req₀ ≈ 40 · (0.15 + 1.21) = $54.4 > $52 deposit ⇒ underwater
 *   - closing ~23–31 qty re-crosses MM while staying at/under IM (residual
 *     long stays open) — the partial-close path under test.
 */
export function perpsPartialCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<PerpsPartialCrashFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("52", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const aliceQty = parseUnits("40", base.config.quantityDecimals);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      quantity: aliceQty,
    });

    return {
      ...base,
      aliceDeposit,
      aliceQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("3.00", base.config.oracleDecimals)),
    };
  };
}

/**
 * Cross-venue *partial* crash — the reduce-to-IM-buffer path spanning both
 * venues. Alice holds a dominant 40-qty perps long plus a small 1-lot futures
 * long. A moderate crash (4.21 → 3.00 mark) puts the *combined* portfolio below
 * MM, but the account is recoverable by a partial close. In the duration-free
 * model each futures lot is ±1 delta, so the portfolio behaves like one net-long
 * book of size `perpQty + futuresLots` (= 40 + 1 = 41 delta units) for margin.
 *
 * Sizing (PME 10% IM / 5% MM, entry = $4.21 mark, futures taker fee disabled):
 *   - mmReq(3.00) = 41·0.05·3.00 + 40·(4.21−3.00) + 1·(4.21−3.00)
 *                 = 6.15 + 48.40 + 1.21 = $55.76
 *   - imReq(3.00) = 41·0.10·3.00 + 49.61 = 12.30 + 49.61 = $61.91
 *   - $53 deposit < $55.76 ⇒ underwater by ~$2.76
 *   - closing a perps unit frees imShock·P = $0.30 of IM surplus (its realized
 *     loss cancels the freed unrealized loss), so the deepest in-band close is
 *     δ ≈ (61.91 − 53 + $1 flat fee)/0.30 ≈ 33 units — a PARTIAL perps close
 *     (~7 of the 40 stay open), suppliable by the perps leg alone so the futures
 *     leg is never touched.
 *
 * The flat $1/lot futures taker fee is zeroed for this fixture (as in
 * `futuresPartialCrashFixtureBuilder`) so it doesn't eat into the narrow
 * partial-close band and flip the dominant-leg close from partial to full.
 *
 * Contract under test: the planner reduces the *dominant* venue (perps, by
 * unrealized loss) down to the portfolio `[MM, IM]` band in one sweep. Because
 * the perps solver sizes against whole-portfolio margin (the futures leg's loss
 * AND stress are folded in), a perps-only partial close suffices — the futures
 * leg is left fully intact. This is the cross-venue analogue of the single-venue
 * partial tests, and distinct from the deep-crash cross-venue tests that fully
 * wipe both books.
 */
export function crossVenuePartialCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<CrossVenueFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("53", base.config.tokenDecimals);
    const bobDeposit = parseUnits("5000", base.config.tokenDecimals);
    const alicePerpsQty = parseUnits("40", base.config.quantityDecimals);
    const aliceFuturesQty = 1;

    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      alicePerpsQty,
      aliceFuturesQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("3.00", base.config.tokenDecimals)),
    };
  };
}

/**
 * Cross-venue *deep-but-recoverable* crash — the account is substantially
 * underwater, so reducing the single worst venue to EMPTY still leaves it below
 * MM and the planner must sweep the SECOND venue too before landing in the
 * `[MM, IM]` band. This exercises the planner's multi-iteration cross-venue loop
 * in the partial regime (distinct from both the single-venue-suffices partial
 * test and the 99.8% deep-crash test that wipes everything into bad debt).
 *
 * Staged at a $40 mark (crash to $30) — the duration-free equivalent of the old
 * $4.21-scale sizing. Alice holds a dominant 12-lot futures long + an 11-qty
 * perps long (delta units: futures 12·1 = 12, perps 11; S = 23). Futures is made
 * the worst leg by lot count (each lot now ±1 delta, so its loss out-numbers the
 * perps qty). Moderate crash 40 → 30:
 *   - mmReq(30) = 23·0.05·30 + 11·(40−30) + 12·(40−30)
 *              = 34.50 + 110 + 120 = $264.50
 *   - imReq(30) = 23·0.10·30 + 230 = 69 + 230 = $299
 *   - $235 deposit (−$1 perps taker fee ⇒ $234 balance) ⇒ underwater by ~$30.50
 *     (substantial).
 *
 * The key sizing invariant: closing a delta unit only improves the portfolio
 * margin *gap* by the maintenance-margin relief `mmRate·mark = 0.05·30 = $1.50`
 * (realizing the loss debits the balance but drops mmReq by the same amount, so
 * only the shock-margin term nets out). Liquidation fees are zero in this harness
 * (futures taker fee zeroed; no per-lot liquidation fee applied), so:
 *   - Full futures capacity = 12·$1.50 = $18 < $30.50 deficit ⇒ even closing ALL
 *     12 lots leaves the account under MM: the futures leg CANNOT heal it alone.
 *   - The planner therefore fully closes the futures leg, then takes a SECOND
 *     iteration on perps. Perps closes by a *continuous* quantity down to the IM
 *     boundary (deepest close staying at/under IM), reducing ~9.67 of the 11 qty
 *     and leaving a residual ~1.33-qty long — unlike the discrete futures-lot
 *     granularity.
 *   - Total capacity = 23·$1.50 = $34.50 > $30.50, so the account stays
 *     recoverable (a residual perps long survives — not the bad-debt path).
 *
 * Net effect the test asserts: BOTH venues carry liquidation activity in the one
 * sweep (futures fully closed, perps partially closed), the account lands in
 * `[MM, IM]`, and it is not fully wiped (the perps leg keeps a residual long).
 */
export function crossVenueBothLegsCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<CrossVenueFixture> => {
    const base = await baseFixture(rpcUrl);
    // Stage entry at a $40 mark (see `futuresPartialCrashFixtureBuilder`).
    const entryMark = parseUnits("40", base.config.tokenDecimals);
    await base.setMark(entryMark);

    const aliceDeposit = parseUnits("235", base.config.tokenDecimals);
    const bobDeposit = parseUnits("5000", base.config.tokenDecimals);
    const alicePerpsQty = parseUnits("11", base.config.quantityDecimals);
    const aliceFuturesQty = 12;

    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: entryMark,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: entryMark,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      alicePerpsQty,
      aliceFuturesQty,
      makeLiquidatable: () => base.crashOracles(parseUnits("30", base.config.tokenDecimals)),
    };
  };
}

/**
 * Alice holds simultaneous perps + futures longs. A single oracle move
 * puts both legs underwater at once, exercising the planner's coordinated
 * cross-venue ranking.
 *
 * Two parameterised variants are exposed via dedicated builders:
 *
 *   - `crossVenuePerpsDominantFixtureBuilder` — perps `unrealizedLoss`
 *     dominates futures (ratio ≈ 100:1). The planner should liquidate
 *     perps first, then futures.
 *   - `crossVenueFuturesDominantFixtureBuilder` — futures dominates perps
 *     (ratio ≈ 12:1). The planner should liquidate futures first.
 *
 * Together they prove the planner ranks by *loss size*, not venue order.
 */
function crossVenueFixtureBody(
  base: BaseFixture,
  sizing: { aliceDeposit: bigint; bobDeposit: bigint; alicePerpsQty: bigint; aliceFuturesQty: number },
): Promise<CrossVenueFixture> {
  return (async () => {
    const { aliceDeposit, bobDeposit, alicePerpsQty, aliceFuturesQty } = sizing;
    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      alicePerpsQty,
      aliceFuturesQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
    };
  })();
}

/**
 * Perps-dominant: alice has a 100-qty perps long ($420 unrealized loss after the
 * crash to a $0.01 mark) and a 1-unit futures long ($4.20 loss, duration-free).
 * The planner must liquidate perps first by `unrealizedLoss` ranking.
 */
export function crossVenuePerpsDominantFixtureBuilder(rpcUrl: string) {
  return async (): Promise<CrossVenueFixture> => {
    const base = await baseFixture(rpcUrl);
    return crossVenueFixtureBody(base, {
      aliceDeposit: parseUnits("200", base.config.tokenDecimals),
      bobDeposit: parseUnits("5000", base.config.tokenDecimals),
      alicePerpsQty: parseUnits("100", base.config.quantityDecimals),
      aliceFuturesQty: 1,
    });
  };
}

/**
 * Cross-venue with resting orders on *both* venues. Alice has matched
 * positions (perps long + futures long) plus a stale far-out-of-market
 * resting buy order on each book. The crash makes everything underwater.
 *
 * The keeper must:
 *   1. Cancel the resting perps order   (orders-leg, perps venue)
 *   2. Cancel the resting futures order (orders-leg, futures venue)
 *   3. Close the perps position         (position-leg, worst-first)
 *   4. Close the futures position       (position-leg, next-worst)
 *
 * Steps 1–2 must strictly precede 3–4: the planner walks every venue's
 * orders-leg before touching any position. The test verifies this by
 * comparing block numbers of `OrderLiquidated` vs `PositionLiquidated`
 * events on each venue.
 */
export function crossVenueOrdersAndPositionsFixtureBuilder(rpcUrl: string) {
  return async (): Promise<CrossVenueOrdersAndPositionsFixture> => {
    const base = await baseFixture(rpcUrl);
    // Duration-free rescale: the 6-lot futures leg contributes ~$25 of loss
    // (was ~$176 with the ×7 window), so the deposit drops to keep the combined
    // book underwater after the deep crash and fully wiped across both venues.
    const aliceDeposit = parseUnits("150", base.config.tokenDecimals);
    const bobDeposit = parseUnits("5000", base.config.tokenDecimals);
    const alicePerpsQty = parseUnits("40", base.config.quantityDecimals);
    const aliceFuturesQty = 6;

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialMarketPrice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    // Stale buys well below current marks — no counterparty exists at
    // these levels so each order rests on its book.
    const restingPrice = parseUnits("1.00", base.config.oracleDecimals);
    await placePerpsOrder(
      base,
      base.accounts.alice,
      restingPrice,
      parseUnits("5", base.config.quantityDecimals),
    );
    await placeFuturesOrder(
      base,
      base.accounts.alice,
      parseUnits("2.00", base.config.oracleDecimals),
      base.config.futuresFirstDeliveryDate,
      1,
    );

    return {
      ...base,
      aliceDeposit,
      alicePerpsQty,
      aliceFuturesQty,
      perpsRestingOrderCount: 1,
      futuresRestingOrderCount: 1,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
    };
  };
}

/**
 * Futures-dominant: alice has a 1-qty perps long ($4.20 unrealized loss) and a
 * 12-unit futures long ($50.40 loss, duration-free: 12 · ($4.21 − $0.01 mark)).
 * The planner must liquidate futures first.
 *
 * Futures qty is a single signed createOrder in 3.0; 12 contracts remains a
 * convenient fixture size for margin math (not a gas/looping constraint).
 */
export function crossVenueFuturesDominantFixtureBuilder(rpcUrl: string) {
  return async (): Promise<CrossVenueFixture> => {
    const base = await baseFixture(rpcUrl);
    return crossVenueFixtureBody(base, {
      aliceDeposit: parseUnits("40", base.config.tokenDecimals),
      bobDeposit: parseUnits("5000", base.config.tokenDecimals),
      alicePerpsQty: parseUnits("1", base.config.quantityDecimals),
      aliceFuturesQty: 12,
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal placement / writing helpers
// ─────────────────────────────────────────────────────────────────────────

interface PerpsTrade {
  buyer: Wallet;
  seller: Wallet;
  price: bigint;
  /** Always positive — sign is derived per leg. */
  quantity: bigint;
}

/**
 * Cross a perps order at `price` between `buyer` (positive qty) and
 * `seller` (negative qty). Seller's resting short is placed *first* so
 * the taker (`buyer`) matches against it on submission.
 */
async function matchPerpsTrade(base: BaseFixture, t: PerpsTrade): Promise<void> {
  await placePerpsOrder(base, t.seller, t.price, -t.quantity);
  await placePerpsOrder(base, t.buyer, t.price, t.quantity);
}

interface FuturesTrade {
  buyer: Wallet;
  seller: Wallet;
  price: bigint;
  deliveryAt: bigint;
  /** Whole contracts (signed at placement: +buy / −sell). */
  quantity: number;
}

/** Same shape as `matchPerpsTrade`, but for the Futures venue. */
async function matchFuturesTrade(base: BaseFixture, t: FuturesTrade): Promise<void> {
  await placeFuturesOrder(base, t.seller, t.price, t.deliveryAt, -t.quantity);
  await placeFuturesOrder(base, t.buyer, t.price, t.deliveryAt, t.quantity);
}

async function placePerpsOrder(
  base: BaseFixture,
  wallet: Wallet,
  price: bigint,
  quantity: bigint,
): Promise<void> {
  const hash = await wallet.client.writeContract({
    address: base.addresses.perps,
    abi: base.abis.perps,
    functionName: "createOrder",
    args: [price, quantity],
    chain: hardhat,
    account: wallet.account,
  });
  await base.publicClient.waitForTransactionReceipt({ hash });
}

async function placeFuturesOrder(
  base: BaseFixture,
  wallet: Wallet,
  price: bigint,
  deliveryAt: bigint,
  qty: number,
): Promise<void> {
  // Futures 3.0: createOrder(price, deliveryAt, signedQuantity) — whole contracts.
  const hash = await wallet.client.writeContract({
    address: base.addresses.futures,
    abi: base.abis.futures,
    functionName: "createOrder",
    args: [price, deliveryAt, BigInt(qty)],
    chain: hardhat,
    account: wallet.account,
  });
  await base.publicClient.waitForTransactionReceipt({ hash });
}

/** Owner-only: set the futures per-lot taker fee (token decimals). */
async function setFuturesTakerFee(stack: DeployedStack, fee: bigint): Promise<void> {
  const hash = await stack.accounts.owner.client.writeContract({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    functionName: "setTakerFee",
    args: [fee],
    chain: hardhat,
    account: stack.accounts.owner.account,
  });
  await stack.publicClient.waitForTransactionReceipt({ hash });
}

async function writeOracle(stack: DeployedStack, oracle: Address, price: bigint): Promise<void> {
  const hash = await stack.accounts.owner.client.writeContract({
    address: oracle,
    abi: stack.abis.hashpriceOracle,
    functionName: "setAnswer",
    args: [price],
    chain: hardhat,
    account: stack.accounts.owner.account,
  });
  await stack.publicClient.waitForTransactionReceipt({ hash });
}

async function depositTo(stack: DeployedStack, user: Address, amount: bigint): Promise<void> {
  const wallet = Object.values(stack.accounts).find((w) => w.account.address === user);
  if (wallet === undefined) throw new Error(`No fixture wallet for ${user}`);
  const hash = await wallet.client.writeContract({
    address: stack.addresses.vault,
    abi: stack.abis.vault,
    functionName: "deposit",
    args: [amount],
    chain: hardhat,
    account: wallet.account,
  });
  await stack.publicClient.waitForTransactionReceipt({ hash });
}
