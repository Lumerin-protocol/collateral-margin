import { parseUnits, type Address } from "viem";
import { hardhat } from "viem/chains";
import { deployStack, type DeployedStack, type Wallet } from "./deployStack.ts";

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
  bumpHashprice(newPrice: bigint): Promise<void>;
  bumpBtcUsdc(newPrice: bigint): Promise<void>;
  /** Deposit USDC into the vault from the given (test-known) wallet. */
  deposit(userAddr: Address, amount: bigint): Promise<void>;
  /**
   * Apply a fresh hashprice and a *paired* BTC/USDC tick. The predictor
   * only listens to the BTC/USDC channel, so the second write is what
   * makes the event-driven liquidation path observable; the hashprice
   * write is what actually moves PnL.
   *
   * `crashOracles` moves BTC/USDC *down* (long-side loss); `pumpOracles`
   * moves it *up* (short-side loss).
   */
  crashOracles(hashpricePrice: bigint): Promise<void>;
  pumpOracles(hashpricePrice: bigint): Promise<void>;
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
 * same global `deliveryDurationDays` risk weight, the aggregate margin matches
 * the single-expiry 12-lot case. Used to prove the keeper's ONE
 * `liquidatePositions` tx spreads the close *across both expirations* instead
 * of draining one book first.
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

export async function baseFixture(rpcUrl: string): Promise<BaseFixture> {
  const stack = await deployStack(rpcUrl);
  return {
    ...stack,
    bumpHashprice: (price) => writeOracle(stack, stack.addresses.hashpriceOracle, price),
    bumpBtcUsdc: (price) => writeOracle(stack, stack.addresses.btcUsdcFeed, price),
    deposit: (user, amount) => depositTo(stack, user, amount),
    crashOracles: async (hashpricePrice) => {
      await writeOracle(stack, stack.addresses.hashpriceOracle, hashpricePrice);
      const movedBtc = (stack.config.initialBtcUsdc * 9n) / 10n;
      await writeOracle(stack, stack.addresses.btcUsdcFeed, movedBtc);
    },
    pumpOracles: async (hashpricePrice) => {
      await writeOracle(stack, stack.addresses.hashpriceOracle, hashpricePrice);
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
      price: base.config.initialHashprice,
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
      price: base.config.initialHashprice,
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
      base.config.initialHashprice,
      -(aliceQty + daveQty),
    );
    await placePerpsOrder(base, base.accounts.alice, base.config.initialHashprice, aliceQty);
    await placePerpsOrder(base, base.accounts.dave, base.config.initialHashprice, daveQty);

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
      price: base.config.initialHashprice,
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
 * the matched seller. Position PnL accrues per day across the full
 * delivery window: at entry 4.21 / day × 7 days = $29.47 notional per
 * unit. A crash to 0.01 puts ($4.20 × 7) = $29.40 of unrealized loss per
 * unit — sized so 12 units exceed Alice's $200 deposit.
 */
export function futuresLongCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<FuturesLongFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("200", base.config.tokenDecimals);
    const bobDeposit = parseUnits("2000", base.config.tokenDecimals);
    const aliceFuturesQty = 12;

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      aliceFuturesQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
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
    const aliceDeposit = parseUnits("200", base.config.tokenDecimals);
    const bobDeposit = parseUnits("2000", base.config.tokenDecimals);
    const aliceFuturesQty = 12;

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    // Stale buy order well below the current mark — no counterparty
    // exists at this price level so the order rests on the book.
    const restingPrice = parseUnits("2.00", base.config.oracleDecimals);
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
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
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
    const aliceDeposit = parseUnits("200", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const firstDeliveryAt = base.config.futuresFirstDeliveryDate;
    const secondDeliveryAt =
      firstDeliveryAt + BigInt(7 * 24 * 3600); // matches `FUTURES_DELIVERY_INTERVAL_DAYS`.

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    for (const deliveryAt of [firstDeliveryAt, secondDeliveryAt]) {
      await matchFuturesTrade(base, {
        buyer: base.accounts.alice,
        seller: base.accounts.bob,
        price: base.config.initialHashprice,
        deliveryAt,
        quantity: 6,
      });
    }

    return {
      ...base,
      aliceDeposit,
      deliveryDates: [firstDeliveryAt, secondDeliveryAt] as const,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("0.01", base.config.oracleDecimals)),
    };
  };
}

/**
 * Alice holds 12 long futures lots at the first delivery date; a moderate
 * hashprice crash (4.21 → 3.90 / 100 TH/s / day) drives her below MM while
 * leaving enough headroom that closing a worst-first subset of lots restores
 * `balance >= IM`. Sizing (deliveryDurationDays = 7, PME shocks 10% IM / 5%
 * MM, $1 flat liquidation fee):
 *   - unrealized loss / lot after crash ≈ (4.21 − 3.90) · 7 = $2.17
 *   - MM stress / lot ≈ 0.05 · 3.90 · 7 = $1.365, IM stress ≈ $2.73
 *   - MM_req₀ ≈ 12 · (1.365 + 2.17) = $42.42 > $40 deposit ⇒ underwater
 *   - closing ~7–10 lots frees enough MM stress to re-cross MM while staying
 *     at/under IM (the rest stay open) — a genuine partial liquidation.
 * Deposit $40 also clears the entry IM (12 · 0.10 · 4.21 · 7 ... perp-free
 * futures IM ≈ $35.36) so Alice can open the position pre-crash.
 */
export function futuresPartialCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<FuturesPartialCrashFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("40", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const aliceFuturesQty = 12;

    // Zero the futures taker fee for this fixture only. Opening 12 lots costs
    // an entry IM of 84·(0.1·$4.21) = $35.36, which fits the $40 deposit — but
    // the default $1/lot taker fee ($12) would drop the post-match balance to
    // $28 < IM and revert `InsufficientMarginBalance`. Zeroing it keeps the
    // [MM, IM] band math clean; the $1/lot *liquidation* fee still applies to
    // the sweep (so the solver's fee-aware sizing is still exercised).
    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      aliceFuturesQty,
      // Moderate crash: 4.21 → 3.90. Deep enough to break MM, shallow enough
      // that a subset of lots restores the IM buffer.
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("3.90", base.config.oracleDecimals)),
    };
  };
}

/**
 * Alice holds 6 long futures lots on EACH of two delivery dates (12 total),
 * then takes the same moderate crash (4.21 → 3.90) as
 * `futuresPartialCrashFixtureBuilder`. Because the on-chain futures risk model
 * weights every lot by the single global `deliveryDurationDays` (7) regardless
 * of which date it delivers on, the aggregate MM/IM and unrealized loss are
 * identical to the single-expiry 12-lot fixture — so the same $40 deposit
 * breaks MM and a worst-first subset restores the IM buffer. The distinction
 * under test: the keeper's ONE `liquidatePositions` sweep must close lots from
 * BOTH expirations (balanced), not empty the first book before touching the
 * second.
 */
export function futuresMultiExpiryPartialCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<MultiExpiryFuturesPartialCrashFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("40", base.config.tokenDecimals);
    const bobDeposit = parseUnits("3000", base.config.tokenDecimals);
    const perExpiryQty = 6;
    const firstDeliveryAt = base.config.futuresFirstDeliveryDate;
    const secondDeliveryAt = firstDeliveryAt + BigInt(7 * 24 * 3600); // FUTURES_DELIVERY_INTERVAL_DAYS

    // Zero the taker fee (see `futuresPartialCrashFixtureBuilder`) so the 12-lot
    // entry IM (~$35.36) fits the $40 deposit; the liquidation-fee payout is
    // already disabled contract-side.
    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    for (const deliveryAt of [firstDeliveryAt, secondDeliveryAt]) {
      await matchFuturesTrade(base, {
        buyer: base.accounts.alice,
        seller: base.accounts.bob,
        price: base.config.initialHashprice,
        deliveryAt,
        quantity: perExpiryQty,
      });
    }

    return {
      ...base,
      aliceDeposit,
      deliveryDates: [firstDeliveryAt, secondDeliveryAt] as const,
      perExpiryQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("3.90", base.config.oracleDecimals)),
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
      price: base.config.initialHashprice,
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
 * long. A moderate crash (4.21 → 3.00) puts the *combined* portfolio below MM,
 * but the account is recoverable by a partial close. Because both legs are long
 * at the same entry, the portfolio behaves like one net-long book of size
 * `perpQty + deliveryDays·futuresLots` (= 40 + 7 = 47 delta units) for margin
 * purposes.
 *
 * Sizing (PME 10% IM / 5% MM, deliveryDays = 7, fee payout disabled):
 *   - mmReq(3.00) = 47 · (4.21 − 3.00·0.95) = 47 · 1.36 = $63.92
 *   - imReq(3.00) = 47 · (4.21 − 3.00·0.90) = 47 · 1.51 = $70.97
 *   - $61 deposit < $63.92 ⇒ underwater by ~$2.92
 *   - each closed delta unit lifts mmSurplus by mmShock·P = $0.15, imSurplus by
 *     $0.30, so the deepest in-band close is δ ≈ (70.97−61)/0.30 ≈ 33.2 delta
 *     units — a PARTIAL perps close (≈6.8 units of the 40 stay open), suppliable
 *     by the perps leg alone so the futures leg is never touched.
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
    const aliceDeposit = parseUnits("61", base.config.tokenDecimals);
    const bobDeposit = parseUnits("5000", base.config.tokenDecimals);
    const alicePerpsQty = parseUnits("40", base.config.quantityDecimals);
    const aliceFuturesQty = 1;

    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      alicePerpsQty,
      aliceFuturesQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("3.00", base.config.oracleDecimals)),
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
 * Alice holds a dominant 6-lot futures long + a 25-qty perps long (delta units:
 * futures 6·7 = 42, perps 25; S = 67). Moderate crash 4.21 → 3.00:
 *   - mmReq(3.00) = 67 · 1.36 = $91.12 ; imReq = 67 · 1.51 = $101.17
 *   - $83 deposit ⇒ underwater by ~$8.12 (substantial)
 *   - futures is worst by loss ($50.82 > $30.25), so it's reduced first — but
 *     even fully closing all 6 futures lots only lifts mmSurplus by 6·0.15·7 =
 *     $6.30, short of the $8.12 deficit, so the account is STILL under MM (the
 *     futures leg simply doesn't have the lots to close the gap alone).
 *   - the planner then takes a SECOND iteration and reduces the perps leg. Perps
 *     closes by a *continuous* quantity, so the solver lands the account
 *     precisely on the IM boundary — a robust in-band result (residual perps
 *     ~6.4 qty stays open), unlike the discrete futures-lot granularity.
 *
 * Net effect the test asserts: BOTH venues carry liquidation activity in the
 * one sweep (futures fully closed, perps partially closed), the account lands in
 * `[MM, IM]`, and it is not fully wiped (the perps leg keeps a residual long).
 * The futures taker fee is zeroed (as elsewhere) so the $1/lot open cost doesn't
 * shift the sizing.
 */
export function crossVenueBothLegsCrashFixtureBuilder(rpcUrl: string) {
  return async (): Promise<CrossVenueFixture> => {
    const base = await baseFixture(rpcUrl);
    const aliceDeposit = parseUnits("83", base.config.tokenDecimals);
    const bobDeposit = parseUnits("5000", base.config.tokenDecimals);
    const alicePerpsQty = parseUnits("25", base.config.quantityDecimals);
    const aliceFuturesQty = 6;

    await setFuturesTakerFee(base, 0n);

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      deliveryAt: base.config.futuresFirstDeliveryDate,
      quantity: aliceFuturesQty,
    });

    return {
      ...base,
      aliceDeposit,
      alicePerpsQty,
      aliceFuturesQty,
      makeLiquidatable: () =>
        base.crashOracles(parseUnits("3.00", base.config.oracleDecimals)),
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
 *     dominates futures (ratio ≈ 14:1). The planner should liquidate
 *     perps first, then futures.
 *   - `crossVenueFuturesDominantFixtureBuilder` — futures dominates perps
 *     (ratio ≈ 1:140). The planner should liquidate futures first.
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
      price: base.config.initialHashprice,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
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
 * Perps-dominant: alice has a 100-qty perps long ($420 unrealized loss
 * after the crash) and a 1-unit futures long ($29.40 loss). The planner
 * must liquidate perps first by `unrealizedLoss` ranking.
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
    const aliceDeposit = parseUnits("250", base.config.tokenDecimals);
    const bobDeposit = parseUnits("5000", base.config.tokenDecimals);
    const alicePerpsQty = parseUnits("40", base.config.quantityDecimals);
    const aliceFuturesQty = 6;

    await base.deposit(base.accounts.alice.account.address, aliceDeposit);
    await base.deposit(base.accounts.bob.account.address, bobDeposit);

    await matchPerpsTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
      quantity: alicePerpsQty,
    });
    await matchFuturesTrade(base, {
      buyer: base.accounts.alice,
      seller: base.accounts.bob,
      price: base.config.initialHashprice,
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
 * Futures-dominant: alice has a 1-qty perps long ($4.20 unrealized loss)
 * and a 12-unit futures long ($352.80 loss over the 7-day delivery
 * window). The planner must liquidate futures first.
 *
 * The futures qty is capped at 12 because `createOrder` loops once per
 * contract in the matching engine; larger values blow past Hardhat's
 * per-tx gas cap (16M).
 */
export function crossVenueFuturesDominantFixtureBuilder(rpcUrl: string) {
  return async (): Promise<CrossVenueFixture> => {
    const base = await baseFixture(rpcUrl);
    return crossVenueFixtureBody(base, {
      aliceDeposit: parseUnits("300", base.config.tokenDecimals),
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
  /** int8 — number of contracts. */
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
  // Futures takes a packed (price, deliveryDate, destURL, qty) tuple.
  // `qty` is `int8` — positive = buyer-side, negative = seller-side.
  const hash = await wallet.client.writeContract({
    address: base.addresses.futures,
    abi: base.abis.futures,
    functionName: "createOrder",
    args: [price, deliveryAt, "//keeper-test", qty],
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
