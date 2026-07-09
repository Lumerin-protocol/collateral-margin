import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createTestClient,
  http,
  publicActions,
  walletActions,
  type TestClient,
} from "viem";
import { hardhat } from "viem/chains";
import { startHardhatNode, type HardhatNode } from "./nodeProcess.ts";
import { loadFixture } from "./loadFixture.ts";
import { buildKeeper, type KeeperHarness } from "./buildKeeper.ts";
import { startWebhookSink } from "./webhookSink.ts";
import {
  aliceDepositFixtureBuilder,
  perpsLongCrashFixtureBuilder,
  perpsShortCrashFixtureBuilder,
  perpsOrdersAndPositionFixtureBuilder,
  twoUnderwaterUsersFixtureBuilder,
  futuresLongCrashFixtureBuilder,
  futuresOrdersAndPositionFixtureBuilder,
  multiFuturesFixtureBuilder,
  futuresPartialCrashFixtureBuilder,
  futuresMultiExpiryPartialCrashFixtureBuilder,
  perpsPartialCrashFixtureBuilder,
  crossVenuePerpsDominantFixtureBuilder,
  crossVenueFuturesDominantFixtureBuilder,
  crossVenueOrdersAndPositionsFixtureBuilder,
  crossVenuePartialCrashFixtureBuilder,
  crossVenueBothLegsCrashFixtureBuilder,
} from "./scenarios.ts";
import {
  discoverUser,
  discoverAndIndex,
  runOneSweep,
  readPerpsOrderIds,
  readFuturesOrderIds,
  readFuturesPositionIds,
  readPerpsPositionLiquidationBlock,
  readFuturesPositionLiquidationBlock,
  readPerpsOrderLiquidationBlock,
  readFuturesOrderLiquidationBlock,
  readLotClosedBlock,
  readPerpsPosition,
  readAccountMargins,
  expectPerpsClosed,
  expectFuturesClosed,
  expectNoOpenOrders,
  expectHealthy,
  expectReducedToImBuffer,
  readFuturesLotLiquidatedBlocks,
  readFuturesLotExpiries,
  assertSingleBlock,
  isCriticalAlert,
  waitFor,
} from "./helpers.ts";
import { HARDHAT_PRIVATE_KEYS } from "./deployStack.ts";

/**
 * Integration test suite for `@collateral-margin/keeper`.
 *
 * Architecture:
 *   - One Hardhat node, started once (`before`) and stopped on suite exit.
 *   - Per-test isolation via `evm_snapshot` / `evm_revert` (see
 *     `loadFixture.ts`). Snapshots are keyed by fixture *function
 *     reference*, so each scenario closure is a top-level constant.
 *   - Each test rebuilds the keeper from scratch in-process (`buildKeeper`)
 *     against the live RPC, so cross-test leakage in in-memory caches is
 *     impossible.
 *
 * Each test body reads as a small spec:
 *   1. Load a fixture that names the scenario (`perpsLongCrashFixture`).
 *   2. Build + start the keeper.
 *   3. Trigger the scenario action (e.g. `ctx.makeLiquidatable()`).
 *   4. Assert what the keeper did using `expectXyz(outcome)` or
 *      `expect{Perps,Futures}Closed`.
 *
 * Prereq: sibling repos (perps + futures-marketplace) must be compiled.
 * `pretest:integration` in `package.json` handles this.
 */

let node: HardhatNode;
let testClient: TestClient;
let keeper: KeeperHarness | undefined;

// Fixture closures held at module scope — see scenarios.ts for why.
let aliceDepositFixture: ReturnType<typeof aliceDepositFixtureBuilder>;
let perpsLongCrashFixture: ReturnType<typeof perpsLongCrashFixtureBuilder>;
let perpsShortCrashFixture: ReturnType<typeof perpsShortCrashFixtureBuilder>;
let perpsOrdersAndPositionFixture: ReturnType<typeof perpsOrdersAndPositionFixtureBuilder>;
let twoUnderwaterUsersFixture: ReturnType<typeof twoUnderwaterUsersFixtureBuilder>;
let futuresLongCrashFixture: ReturnType<typeof futuresLongCrashFixtureBuilder>;
let futuresOrdersAndPositionFixture: ReturnType<typeof futuresOrdersAndPositionFixtureBuilder>;
let multiFuturesFixture: ReturnType<typeof multiFuturesFixtureBuilder>;
let futuresPartialCrashFixture: ReturnType<typeof futuresPartialCrashFixtureBuilder>;
let futuresMultiExpiryPartialCrashFixture: ReturnType<
  typeof futuresMultiExpiryPartialCrashFixtureBuilder
>;
let perpsPartialCrashFixture: ReturnType<typeof perpsPartialCrashFixtureBuilder>;
let crossVenuePerpsDominantFixture: ReturnType<typeof crossVenuePerpsDominantFixtureBuilder>;
let crossVenueFuturesDominantFixture: ReturnType<typeof crossVenueFuturesDominantFixtureBuilder>;
let crossVenueOrdersAndPositionsFixture: ReturnType<typeof crossVenueOrdersAndPositionsFixtureBuilder>;
let crossVenuePartialCrashFixture: ReturnType<typeof crossVenuePartialCrashFixtureBuilder>;
let crossVenueBothLegsCrashFixture: ReturnType<typeof crossVenueBothLegsCrashFixtureBuilder>;

before(
  async () => {
    node = await startHardhatNode();
    testClient = createTestClient({
      chain: hardhat,
      mode: "hardhat",
      transport: http(node.rpcUrl),
    })
      .extend(publicActions)
      .extend(walletActions);
    aliceDepositFixture = aliceDepositFixtureBuilder(node.rpcUrl);
    perpsLongCrashFixture = perpsLongCrashFixtureBuilder(node.rpcUrl);
    perpsShortCrashFixture = perpsShortCrashFixtureBuilder(node.rpcUrl);
    perpsOrdersAndPositionFixture = perpsOrdersAndPositionFixtureBuilder(node.rpcUrl);
    twoUnderwaterUsersFixture = twoUnderwaterUsersFixtureBuilder(node.rpcUrl);
    futuresLongCrashFixture = futuresLongCrashFixtureBuilder(node.rpcUrl);
    futuresOrdersAndPositionFixture = futuresOrdersAndPositionFixtureBuilder(node.rpcUrl);
    multiFuturesFixture = multiFuturesFixtureBuilder(node.rpcUrl);
    futuresPartialCrashFixture = futuresPartialCrashFixtureBuilder(node.rpcUrl);
    futuresMultiExpiryPartialCrashFixture =
      futuresMultiExpiryPartialCrashFixtureBuilder(node.rpcUrl);
    perpsPartialCrashFixture = perpsPartialCrashFixtureBuilder(node.rpcUrl);
    crossVenuePerpsDominantFixture = crossVenuePerpsDominantFixtureBuilder(node.rpcUrl);
    crossVenueFuturesDominantFixture = crossVenueFuturesDominantFixtureBuilder(node.rpcUrl);
    crossVenueOrdersAndPositionsFixture = crossVenueOrdersAndPositionsFixtureBuilder(node.rpcUrl);
    crossVenuePartialCrashFixture = crossVenuePartialCrashFixtureBuilder(node.rpcUrl);
    crossVenueBothLegsCrashFixture = crossVenueBothLegsCrashFixtureBuilder(node.rpcUrl);
  },
  { timeout: 60_000 },
);

after(async () => {
  await node?.stop();
});

afterEach(async () => {
  await keeper?.stop();
  keeper = undefined;
});

// ─────────────────────────────────────────────────────────────────────────
// Tracker discovery
// ─────────────────────────────────────────────────────────────────────────

describe("ParticipantTracker (live RPC)", () => {
  it("discovers a user from a Vault.Deposited event", { timeout: 30_000 }, async () => {
    const ctx = await loadFixture(aliceDepositFixture, testClient);
    keeper = buildKeeper(ctx);
    await keeper.start();
    await discoverUser(keeper, ctx.accounts.alice.account.address);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Perps-only liquidation scenarios
// ─────────────────────────────────────────────────────────────────────────

describe("Perps liquidation", () => {
  it(
    "reports `healthy` when prices have not moved",
    { timeout: 30_000 },
    async () => {
      // Precondition: alice holds a perps long at the entry mark; oracle
      // is *unchanged*, so the planner should never take action.
      const ctx = await loadFixture(perpsLongCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await discoverUser(keeper, alice);

      const outcome = await keeper.planner.run(alice);
      const healthy = expectHealthy(outcome);
      assert.ok(healthy.mmSurplus >= 0n, "mmSurplus should be non-negative");
    },
  );

  it(
    "closes a deeply underwater long position",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice's $100 deposit cannot cover ~$168 unrealized
      // loss after a 99.8% hashprice crash. The planner runs the orders-
      // leg (no-op) then closes her single position.
      const ctx = await loadFixture(perpsLongCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectPerpsClosed(ctx, alice);
    },
  );

  it(
    "closes an underwater short position when the price rises",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice is SHORT 40 perps at $4.21. A 2× price pump
      // to $8.42 puts her short ~$168 underwater on a $100 deposit. This
      // is the mirror of `closes a deeply underwater long position` and
      // pins down the PnL sign handling in `PerpsVenue.readPositions`
      // — `netQuantity < 0` ⇒ short ⇒ loss when price moves *up*.
      const ctx = await loadFixture(perpsShortCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectPerpsClosed(ctx, alice);
    },
  );

  it(
    "cancels resting orders alongside the position liquidation",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice holds a perps long AND a stale far-out-of-
      // market resting buy order. The perps venue cancels the resting
      // order via `multicallStopOnFailure([liquidateOrder(user, id)])`
      // (the contract retired the batch `liquidateOrders` entry point);
      // the planner then walks the position-leg in the same plan.
      const ctx = await loadFixture(perpsOrdersAndPositionFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      assert.equal(
        (await readPerpsOrderIds(ctx, alice)).length,
        ctx.restingOrderCount,
        "test precondition: alice should have a resting perps order at fixture time",
      );

      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectPerpsClosed(ctx, alice);
      await expectNoOpenOrders(ctx, alice);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Multi-account coordination (queue priority, serialized execution)
// ─────────────────────────────────────────────────────────────────────────

describe("Multi-account coordination", () => {
  it(
    "liquidates both underwater users, worst-mmSurplus first",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice and dave are both long perps with the same
      // deposit ($100) but different sizes — alice is 40-qty (~$168
      // loss after crash), dave is 20-qty (~$84 loss). Post-crash
      // `mmSurplus` is more negative for alice.
      //
      // The queue is a priority queue ordered by `mmSurplus` ASC, so
      // alice must be popped first. With `maxConcurrentAccounts: 1`
      // (default) the executor processes them serially — alice closes
      // first, then dave. We assert ordering via the block numbers of
      // their respective `PositionLiquidated` events.
      const ctx = await loadFixture(twoUnderwaterUsersFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      // Both users are pre-existing in the fixture snapshot; seed them
      // directly into the tracker rather than relying on the `Deposited`
      // watcher to back-scan. This test is about queue priority and the
      // executor's serial behavior, not tracker discovery (covered above).
      keeper.tracker.add(ctx.worseUser);
      keeper.tracker.add(ctx.betterUser);

      await ctx.makeLiquidatable();
      await keeper.scheduler.runSweep();

      await expectPerpsClosed(ctx, ctx.worseUser);
      await expectPerpsClosed(ctx, ctx.betterUser);

      const worseBlock = await readPerpsPositionLiquidationBlock(ctx, ctx.worseUser);
      const betterBlock = await readPerpsPositionLiquidationBlock(ctx, ctx.betterUser);
      assert.ok(worseBlock !== null && betterBlock !== null);
      assert.ok(
        worseBlock <= betterBlock,
        `expected worse-mmSurplus user liquidated first, got worse=${worseBlock} better=${betterBlock}`,
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Futures-only liquidation scenarios
// ─────────────────────────────────────────────────────────────────────────

describe("Futures liquidation", () => {
  it(
    "closes a futures long after the hashprice crashes",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice holds a single long futures contract at the
      // first delivery date. Duration-free: the unrealized loss is
      // `(entryPrice − marketPrice) · qty` (multiplier of 1); sized so the
      // deposit can't cover it.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectFuturesClosed(ctx, alice);
    },
  );

  it(
    "cancels resting orders before closing the futures position",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice holds a long futures position AND a stale
      // far-out-of-market resting buy order. After the crash the planner
      // must run orders-leg (FIFO sweep via `liquidateOrders(user)`) and
      // position-leg in the same plan; we verify on-chain that both
      // legs end up empty.
      const ctx = await loadFixture(futuresOrdersAndPositionFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      assert.equal(
        (await readFuturesOrderIds(ctx, alice)).length,
        ctx.restingOrderCount,
        "test precondition: alice should have a resting futures order at fixture time",
      );

      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectFuturesClosed(ctx, alice);
      await expectNoOpenOrders(ctx, alice);
    },
  );

  it(
    "iterates the position loop to close multiple delivery dates",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice holds long futures across two delivery dates.
      // The planner's worst-first loop must run at least twice (once per
      // position) before the account becomes healthy. End state: no
      // futures positions remain.
      const ctx = await loadFixture(multiFuturesFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectFuturesClosed(ctx, alice);
      // Bonus: no straggler orders left in the book either.
      assert.equal((await readFuturesOrderIds(ctx, alice)).length, 0);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Close-to-IM-buffer (partial liquidation — the anti-churn acceptance spec)
// ─────────────────────────────────────────────────────────────────────────

describe("Liquidate down to the IM buffer", () => {
  it(
    "futures: one batched sweep closes a strict subset of lots into the [MM, IM] band",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice holds 12 long futures lots; a moderate crash
      // ($40 → $30 mark) breaks MM but a subset close restores the IM buffer.
      // Contract under test (the screenshot bug fix): the planner must NOT
      // fan out into one-lot-per-tx churn. Instead a single
      // `liquidatePositions(user, ids[])` closes the worst-first subset in
      // ONE block, leaves ≥1 lot open, and lands `MM <= balance <= IM`.
      const ctx = await loadFixture(futuresPartialCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      const lotsBefore = await readFuturesPositionIds(ctx, alice);
      assert.equal(
        lotsBefore.length,
        ctx.aliceFuturesQty,
        "precondition: alice should hold one lot per matched contract",
      );

      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      // Landed in the buffer band — healthy but not over-liquidated.
      await expectReducedToImBuffer(ctx, alice);

      // A strict subset closed: at least one lot remains open.
      const lotsAfter = await readFuturesPositionIds(ctx, alice);
      assert.ok(
        lotsAfter.length > 0,
        `expected a strict subset closed (>=1 lot open), got ${lotsAfter.length} remaining`,
      );
      assert.ok(
        lotsAfter.length < lotsBefore.length,
        `expected some lots closed, before=${lotsBefore.length} after=${lotsAfter.length}`,
      );

      // Anti-churn regression guard: every closed lot rides a SINGLE block.
      const liqBlocks = await readFuturesLotLiquidatedBlocks(ctx, alice);
      assert.equal(
        liqBlocks.length,
        lotsBefore.length - lotsAfter.length,
        "expected one LotLiquidated event per closed lot",
      );
      assertSingleBlock(liqBlocks, "futures liquidatePositions batch");
    },
  );

  it(
    "futures: one batched sweep balances the subset close across two expirations",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice holds 6 long futures lots on EACH of two delivery
      // dates (12 total). The moderate crash ($40 → $30 mark) breaks MM; because
      // the duration-free risk model weights every lot by the same per-day value
      // (±1 delta each) regardless of expiry, the aggregate margin equals the
      // single-expiry 12-lot case, so a worst-first subset restores the IM buffer.
      //
      // Contract under test (the balancing feature): the ONE
      // `liquidatePositions(user, ids[])` call must draw its closed lots from
      // BOTH books — not empty the first expiry before touching the second.
      // We snapshot each lot's `deliveryAt` *before* the close (positions are
      // deleted on liquidation), diff the surviving ids to find what closed,
      // and assert the per-expiry counts are balanced (differ by ≤ 1) with at
      // least one lot closed on each date.
      const ctx = await loadFixture(futuresMultiExpiryPartialCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      const lotsBefore = await readFuturesPositionIds(ctx, alice);
      assert.equal(
        lotsBefore.length,
        ctx.perExpiryQty * ctx.deliveryDates.length,
        "precondition: alice holds perExpiryQty lots per delivery date",
      );

      // Snapshot id → expiry while every lot is still alive on-chain.
      const expiryById = await readFuturesLotExpiries(ctx, lotsBefore);
      const [firstDelivery, secondDelivery] = ctx.deliveryDates;

      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      // Landed in the buffer band — healthy but not over-liquidated.
      await expectReducedToImBuffer(ctx, alice);

      const lotsAfter = await readFuturesPositionIds(ctx, alice);
      const survivors = new Set<string>(lotsAfter.map((id) => id.toLowerCase()));
      const closed = lotsBefore.filter((id) => !survivors.has(id.toLowerCase()));

      assert.ok(
        lotsAfter.length > 0 && lotsAfter.length < lotsBefore.length,
        `expected a strict subset closed, before=${lotsBefore.length} after=${lotsAfter.length}`,
      );

      // Attribute every closed lot back to its book.
      let closedFirst = 0;
      let closedSecond = 0;
      for (const id of closed) {
        const expiry = expiryById.get(id);
        assert.ok(expiry !== undefined, `missing pre-close expiry for lot ${id}`);
        if (expiry === firstDelivery) closedFirst += 1;
        else if (expiry === secondDelivery) closedSecond += 1;
        else assert.fail(`lot ${id} has an unexpected expiry ${expiry}`);
      }

      // The balancing invariant: both books contributed, and the split is even
      // (the round-robin worst-first selection differs by at most one lot).
      assert.ok(
        closedFirst >= 1 && closedSecond >= 1,
        `expected the close to span BOTH expirations, got first=${closedFirst} second=${closedSecond}`,
      );
      const skew = closedFirst > closedSecond ? closedFirst - closedSecond : closedSecond - closedFirst;
      assert.ok(
        skew <= 1,
        `expected a balanced split across expirations (skew <= 1), got first=${closedFirst} second=${closedSecond}`,
      );

      // Anti-churn guard: the whole balanced subset rides a single block.
      const liqBlocks = await readFuturesLotLiquidatedBlocks(ctx, alice);
      assert.equal(
        liqBlocks.length,
        closed.length,
        "expected one LotLiquidated event per closed lot",
      );
      assertSingleBlock(liqBlocks, "futures multi-expiry liquidatePositions batch");
    },
  );

  it(
    "perps: one sweep partially closes the net position into the [MM, IM] band",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice is long 40 perps; a moderate crash (4.21 → 3.00)
      // breaks MM but a partial-qty close restores the IM buffer. The perps
      // venue must call `liquidatePosition(user, closeQty)` with an
      // off-chain-sized `closeQty` so the residual long stays open and the
      // account lands `MM <= balance <= IM` (not fully closed, not over-closed).
      const ctx = await loadFixture(perpsPartialCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      const posBefore = await readPerpsPosition(ctx, alice);
      assert.equal(posBefore.netQuantity, ctx.aliceQty, "precondition: alice long 40");

      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectReducedToImBuffer(ctx, alice);

      const posAfter = await readPerpsPosition(ctx, alice);
      assert.notEqual(posAfter.netQuantity, 0n, "expected a partial close, not a full close");
      assert.ok(
        posAfter.netQuantity > 0n && posAfter.netQuantity < posBefore.netQuantity,
        `expected reduced long, before=${posBefore.netQuantity} after=${posAfter.netQuantity}`,
      );
    },
  );

  it(
    "cross-venue: one sweep reduces the dominant perps leg into the [MM, IM] band, leaving the futures leg open",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice is long 40 perps AND long 1 futures lot; a moderate
      // crash (4.21 → 3.00 mark) puts the *combined* portfolio below MM. The
      // perps leg dominates by unrealized loss ($48.40 vs $1.21, duration-free),
      // so the planner reduces it first.
      //
      // Contract under test: the perps `reduceToTarget` sizes its partial
      // `closeQty` against WHOLE-portfolio margin — the still-open futures leg's
      // loss and stress are folded into the [MM, IM] band it targets. A
      // perps-only partial close therefore suffices; the account lands in the
      // band and the futures leg is left fully intact (never touched). This is
      // the cross-venue partial-liquidation path, distinct from the deep-crash
      // cross-venue tests that wipe both books.
      const ctx = await loadFixture(crossVenuePartialCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      const perpsBefore = await readPerpsPosition(ctx, alice);
      assert.equal(perpsBefore.netQuantity, ctx.alicePerpsQty, "precondition: alice long 40 perps");
      const futuresBefore = await readFuturesPositionIds(ctx, alice);
      assert.equal(
        futuresBefore.length,
        ctx.aliceFuturesQty,
        "precondition: alice holds the futures lot(s)",
      );

      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      // Landed in the buffer band across the combined portfolio.
      await expectReducedToImBuffer(ctx, alice);

      // The dominant perps leg was partially closed — residual long still open.
      const perpsAfter = await readPerpsPosition(ctx, alice);
      assert.ok(
        perpsAfter.netQuantity > 0n && perpsAfter.netQuantity < perpsBefore.netQuantity,
        `expected a partial perps close, before=${perpsBefore.netQuantity} after=${perpsAfter.netQuantity}`,
      );

      // The futures leg was folded into the perps sizing math but never closed —
      // reducing the dominant venue alone restored the whole-portfolio buffer.
      const futuresAfter = await readFuturesPositionIds(ctx, alice);
      assert.equal(
        futuresAfter.length,
        futuresBefore.length,
        `expected the futures leg untouched, before=${futuresBefore.length} after=${futuresAfter.length}`,
      );
    },
  );

  it(
    "cross-venue: a substantially underwater account is swept on BOTH venues into the [MM, IM] band",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice is long 12 futures lots AND long 11 perps (staged at
      // a $40 mark); a moderate crash ($40 → $30 mark) leaves the combined
      // portfolio SUBSTANTIALLY under MM (~$14.50 deficit). The futures leg
      // dominates by loss ($120 vs $110), so it's reduced first — but fully
      // closing all 12 lots realizes $120 of loss + $12 fee, still short of the
      // residual perps MM requirement, so the account is still under MM.
      //
      // Contract under test: the planner's position loop must then take a
      // SECOND iteration and reduce the perps leg (partial, continuous qty) to
      // finish the job. End state: liquidation activity on BOTH venues in the
      // one sweep, the account lands in the [MM, IM] band, and it is NOT fully
      // wiped (a residual perps long stays open — this is the partial regime,
      // not the bad-debt full-deleverage path).
      const ctx = await loadFixture(crossVenueBothLegsCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      const perpsBefore = await readPerpsPosition(ctx, alice);
      assert.equal(perpsBefore.netQuantity, ctx.alicePerpsQty, "precondition: alice long 11 perps");
      const futuresBefore = await readFuturesPositionIds(ctx, alice);
      assert.equal(
        futuresBefore.length,
        ctx.aliceFuturesQty,
        "precondition: alice holds 12 futures lots",
      );

      await ctx.makeLiquidatable();

      // Substantially underwater: even the whole perps leg's stress relief can't
      // close the gap on its own (a single-venue sweep would be insufficient).
      const pre = await readAccountMargins(ctx, alice);
      assert.ok(
        pre.balance < pre.mmRequired,
        `precondition: expected underwater, balance=${pre.balance}n mm=${pre.mmRequired}n`,
      );

      await runOneSweep(keeper, alice);

      // Landed in the buffer band across the combined portfolio.
      await expectReducedToImBuffer(ctx, alice);

      // BOTH venues were liquidated in the sweep.
      const perpsBlock = await readPerpsPositionLiquidationBlock(ctx, alice);
      const futuresBlock = await readFuturesPositionLiquidationBlock(ctx, alice);
      assert.ok(perpsBlock !== null, "expected a perps PositionLiquidated event (perps leg swept)");
      assert.ok(futuresBlock !== null, "expected a futures LotLiquidated event (futures leg swept)");

      // Both legs reduced; the account is not fully wiped (partial regime).
      const perpsAfter = await readPerpsPosition(ctx, alice);
      const futuresAfter = await readFuturesPositionIds(ctx, alice);
      assert.ok(
        perpsAfter.netQuantity < perpsBefore.netQuantity,
        `expected the perps leg reduced, before=${perpsBefore.netQuantity} after=${perpsAfter.netQuantity}`,
      );
      assert.ok(
        futuresAfter.length < futuresBefore.length,
        `expected the futures leg reduced, before=${futuresBefore.length} after=${futuresAfter.length}`,
      );
      assert.ok(
        perpsAfter.netQuantity > 0n || futuresAfter.length > 0,
        "expected a strict subset closed (some position remains — landed in band, not bad debt)",
      );
    },
  );

  it(
    "deep futures crash still fully closes (bad-debt path — guard skipped)",
    { timeout: 60_000 },
    async () => {
      // Regression: the close-to-IM change must NOT strand deep-crash
      // accounts. A 99.8% crash leaves no in-band subset, so the batch
      // closes every lot (the end-of-batch OverLiquidation guard is skipped
      // once no positions remain). This keeps the existing bad-debt path green.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectFuturesClosed(ctx, alice);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-venue coordination
// ─────────────────────────────────────────────────────────────────────────

describe("Cross-venue coordination", () => {
  it(
    "closes both perps and futures legs of an underwater account",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice is simultaneously long perps + long futures
      // (same hashprice). A single oracle move puts both legs underwater
      // and the planner must coordinate across venues. The contract under
      // test is: both legs end up flat from a single sweep — neither
      // venue is left stranded just because the other one's closure made
      // alice momentarily healthy on a different venue's MM math.
      const ctx = await loadFixture(crossVenuePerpsDominantFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectPerpsClosed(ctx, alice);
      await expectFuturesClosed(ctx, alice);
    },
  );

  it(
    "liquidates the perps leg first when perps unrealized loss dominates",
    { timeout: 60_000 },
    async () => {
      // Precondition: 100-qty perps long ($420 loss) + 1-unit futures
      // long ($4.20 loss, duration-free). The planner's `rankPositions` orders
      // by `unrealizedLoss DESC`, so perps must be closed strictly before
      // futures. Observable signal: the block number of the perps
      // `PositionLiquidated` event is strictly less than the futures one.
      const ctx = await loadFixture(crossVenuePerpsDominantFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectPerpsClosed(ctx, alice);
      await expectFuturesClosed(ctx, alice);

      const perpsBlock = await readPerpsPositionLiquidationBlock(ctx, alice);
      const futuresBlock = await readFuturesPositionLiquidationBlock(ctx, alice);
      assert.ok(perpsBlock !== null, "expected a perps PositionLiquidated event");
      assert.ok(futuresBlock !== null, "expected a futures LotLiquidated event");
      assert.ok(
        perpsBlock < futuresBlock,
        `expected perps liquidated before futures, got perps=${perpsBlock} futures=${futuresBlock}`,
      );
    },
  );

  it(
    "liquidates the futures leg first when futures unrealized loss dominates",
    { timeout: 60_000 },
    async () => {
      // Precondition: inverted from the previous test — 1-qty perps long
      // ($4.20 loss) + 12-unit futures long ($50.40 loss, duration-free:
      // 12 · ($4.21 − $0.01 mark)). Futures must be closed strictly before
      // perps, confirming the planner's ranking is by loss size and not by a
      // hard-coded venue order.
      const ctx = await loadFixture(crossVenueFuturesDominantFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectPerpsClosed(ctx, alice);
      await expectFuturesClosed(ctx, alice);

      const perpsBlock = await readPerpsPositionLiquidationBlock(ctx, alice);
      const futuresBlock = await readFuturesPositionLiquidationBlock(ctx, alice);
      assert.ok(perpsBlock !== null, "expected a perps PositionLiquidated event");
      assert.ok(futuresBlock !== null, "expected a futures LotLiquidated event");
      assert.ok(
        futuresBlock < perpsBlock,
        `expected futures liquidated before perps, got perps=${perpsBlock} futures=${futuresBlock}`,
      );
    },
  );

  it(
    "liquidates orders across every venue before touching any position",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice has positions on both venues AND a stale
      // resting order on each book. After the crash, the planner's
      // contract is:
      //
      //   1. orders-leg fans out across every venue (perps then
      //      futures) and cancels open orders;
      //   2. only THEN does position-leg run and start closing
      //      positions worst-first.
      //
      // Observable invariant: every `OrderLiquidated` event lives in a
      // block ≤ every `PositionLiquidated` event, on either venue. We
      // pick the latest order block and the earliest position block and
      // compare — that catches any interleaving regression.
      const ctx = await loadFixture(crossVenueOrdersAndPositionsFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      assert.equal(
        (await readPerpsOrderIds(ctx, alice)).length,
        ctx.perpsRestingOrderCount,
        "test precondition: alice should have a resting perps order at fixture time",
      );
      assert.equal(
        (await readFuturesOrderIds(ctx, alice)).length,
        ctx.futuresRestingOrderCount,
        "test precondition: alice should have a resting futures order at fixture time",
      );

      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      // End state: nothing left on either venue.
      await expectPerpsClosed(ctx, alice);
      await expectFuturesClosed(ctx, alice);
      await expectNoOpenOrders(ctx, alice);

      // The actual ordering invariant.
      const perpsOrderBlock = await readPerpsOrderLiquidationBlock(ctx, alice);
      const futuresOrderBlock = await readFuturesOrderLiquidationBlock(ctx, alice);
      const perpsPositionBlock = await readPerpsPositionLiquidationBlock(ctx, alice);
      const futuresPositionBlock = await readFuturesPositionLiquidationBlock(ctx, alice);
      assert.ok(perpsOrderBlock !== null, "expected a perps OrderLiquidated event");
      assert.ok(futuresOrderBlock !== null, "expected a futures OrderLiquidated event");
      assert.ok(perpsPositionBlock !== null, "expected a perps PositionLiquidated event");
      assert.ok(futuresPositionBlock !== null, "expected a futures LotLiquidated event");

      const latestOrderBlock = max(perpsOrderBlock, futuresOrderBlock);
      const earliestPositionBlock = min(perpsPositionBlock, futuresPositionBlock);
      assert.ok(
        latestOrderBlock <= earliestPositionBlock,
        `expected every order liquidation to precede every position liquidation, ` +
          `got orders={perps:${perpsOrderBlock}, futures:${futuresOrderBlock}} ` +
          `positions={perps:${perpsPositionBlock}, futures:${futuresPositionBlock}}`,
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Predictor-driven liquidation (event path, no scheduler sweep)
// ─────────────────────────────────────────────────────────────────────────

describe("PredictiveCoordinator (live oracle events)", () => {
  it(
    "drives liquidation via AnswerUpdated alone (scheduler sweep disabled)",
    { timeout: 30_000 },
    async () => {
      // Precondition: alice holds a healthy perps long. We never call
      // `scheduler.runSweep()` — if the position closes, the only path
      // was `BTC/USDC AnswerUpdated` → PriceFeed → PredictiveCoordinator
      // → Queue → CoordinatorExecutor → Planner.
      const ctx = await loadFixture(perpsLongCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      // The predictor needs alice's *pre-crash* thresholds indexed before
      // we move the oracle, otherwise `solveLiquidationThresholds` would
      // short-circuit on an underwater snapshot.
      await discoverAndIndex(keeper, alice);

      await ctx.makeLiquidatable();

      await expectPerpsClosed(ctx, alice);
    },
  );

  it(
    "stays silent when the oracle moves but no user threshold is crossed",
    { timeout: 30_000 },
    async () => {
      // Precondition: alice holds a healthy perps long ($4.21 entry,
      // ~$1.82 `liqDown` threshold per the predictor's solver). A 3%
      // BTC/USDC tick translates to a ~3% hashprice change — comfortably
      // above her liquidation threshold.
      //
      // Contract: the predictor must observe the `AnswerUpdated` event
      // (price feed *does* update) but conclude no user is crossing and
      // therefore enqueue nothing. We verify the negative invariant:
      //   1. queue stays empty,
      //   2. alice's position is untouched,
      //   3. her account survives a planner run with `healthy` outcome.
      //
      // This guards against a regression where every oracle tick would
      // wastefully fan out into a full planner sweep.
      const ctx = await loadFixture(perpsLongCrashFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await discoverAndIndex(keeper, alice);
      assert.equal(keeper.queue.size(), 0, "precondition: queue empty before move");

      // 3% downward tick on BTC/USDC. Hashprice is derived from
      // BTC/USDC, so we don't need to touch the hashprice oracle directly.
      const smallMovedBtc = (ctx.config.initialBtcUsdc * 97n) / 100n;
      await ctx.bumpBtcUsdc(smallMovedBtc);

      // Let the predictor's `AnswerUpdated` watcher process the event
      // and finish any rebuild. `awaitIdle` blocks on the rebuild queue.
      await keeper.predictor.awaitIdle();

      assert.equal(
        keeper.queue.size(),
        0,
        "predictor enqueued the user on a sub-threshold move (false positive)",
      );

      // Sanity: the planner agrees alice is still healthy.
      const outcome = await keeper.planner.run(alice);
      expectHealthy(outcome);

      const position = await readPerpsPosition(ctx, alice);
      assert.notEqual(position.netQuantity, 0n, "position should still be open");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Alert notifier
// ─────────────────────────────────────────────────────────────────────────

describe("Notifier (live HTTP)", () => {
  it(
    "POSTs a critical alert when the account crosses the MM threshold",
    { timeout: 30_000 },
    async () => {
      const ctx = await loadFixture(perpsLongCrashFixture, testClient);
      const sink = await startWebhookSink();
      try {
        keeper = buildKeeper(ctx, { webhookUrl: sink.url });
        await keeper.start();

        const alice = ctx.accounts.alice.account.address;
        await ctx.makeLiquidatable();
        await runOneSweep(keeper, alice);

        await waitFor(() => sink.received.some((r) => isCriticalAlert(r.body)), 15_000);
      } finally {
        await sink.stop();
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Delivery coordinator (live RPC, opt-in keeper module)
// ─────────────────────────────────────────────────────────────────────────

describe("DeliveryCoordinator (live RPC)", () => {
  it(
    "settles a futures position at its delivery date with the current market price",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice holds a single long futures contract created
      // at fixture time. The keeper boots with delivery enabled. (The
      // validator key is used here for historical parity, but `settlePosition`
      // is permissionless — see the dedicated non-validator test below.)
      //
      // We then fast-forward the chain past `deliveryAt` and trigger one
      // sweep. `settlePosition` cash-settles the full position notional at the
      // current market price and emits `LotClosed(SETTLED)`.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);
      keeper = buildKeeper(ctx, {
        liquidatorPrivateKey: HARDHAT_PRIVATE_KEYS[4], // validator (parity; not required)
        delivery: true,
      });
      await keeper.start();
      assert.ok(keeper.delivery, "delivery coordinator should be wired when override is true");

      const alice = ctx.accounts.alice.account.address;
      const positionsBefore = await readFuturesPositionIds(ctx, alice);
      // The fixture creates one position per matched contract — Alice's
      // 12-contract long becomes 12 separate position entries sharing one
      // `deliveryAt`. Settling them all is the realistic case (one signer
      // serializing many positions due at the same timestamp).
      assert.equal(positionsBefore.length, ctx.aliceFuturesQty);

      // Seed the delivery index from history — the positions were created
      // before the keeper booted, so the live watcher hasn't seen them.
      await keeper.delivery.backfill(0n, 10_000n);
      for (const id of positionsBefore) {
        assert.ok(keeper.delivery.has(id), `backfill should index position ${id}`);
      }

      // Fast-forward past `deliveryAt`. `settlePosition` requires
      // `block.timestamp >= position.deliveryAt`, and `block.timestamp` is
      // only advanced once a block is mined at the new clock.
      const deliveryAt = ctx.config.futuresFirstDeliveryDate;
      await testClient.setNextBlockTimestamp({ timestamp: deliveryAt + 60n });
      await testClient.mine({ blocks: 1 });

      // The hashprice oracle has been silent for 7 days — refresh it so
      // `_getHashpriceUsd` doesn't revert `OracleStale` inside
      // `settlePosition`. We re-post the entry price; the settlement formula
      // uses this as the mark applied to the full position notional.
      await ctx.bumpHashprice(ctx.config.initialHashprice);

      await keeper.delivery.sweep();

      // End state: every position is gone from chain storage, each emitted
      // a `LotClosed` event from the keeper's signer, and the
      // index dropped all of them.
      await expectFuturesClosed(ctx, alice);

      // The index drop happens after the settling tx confirms. The
      // coordinator also runs a background safety-net sweep every
      // `sweepIntervalMs`; when it wins the race against this manual
      // `sweep()` the on-chain `LotClosed` can be observable a tick before
      // the in-memory index is pruned. Poll for the drop rather than
      // asserting it synchronously to avoid that race.
      const delivery = keeper.delivery;
      assert.ok(delivery);
      await waitFor(
        () => positionsBefore.every((id) => !delivery.has(id)),
        10_000,
      );

      const settledBlocks: bigint[] = [];
      for (const id of positionsBefore) {
        const settledBlock = await readLotClosedBlock(ctx, id);
        assert.ok(
          settledBlock !== null,
          `expected a LotClosed event for position ${id}`,
        );
        settledBlocks.push(settledBlock);
      }
      // Batching invariant: all 12 settlements ride a single
      // `Futures.multicall(bytes[])` transaction, so every
      // `LotClosed` event lands in the same block. Without
      // batching they would have been N separate txs across N blocks
      // (plus a `replacement transaction underpriced` race in production
      // when two of them collided on the same nonce). This assertion
      // locks in the multicall path — if someone reverts the coordinator
      // to per-id sends, the blocks fan out and this fails.
      const uniqueBlocks = new Set(settledBlocks.map((b) => b.toString()));
      assert.equal(
        uniqueBlocks.size,
        1,
        `expected all settlements in one multicall block, got ${uniqueBlocks.size} distinct blocks: ${[...uniqueBlocks].join(", ")}`,
      );
    },
  );

  it(
    "sweeps missing past deliveries during backfill — settles immediately on boot",
    { timeout: 60_000 },
    async () => {
      // Precondition: alice's position was created at fixture time and
      // its `deliveryAt` is *already in the past* by the time the keeper
      // boots. The contract is the spec for "missing delivery": until
      // someone calls `settlePosition` the position lingers, and (unlike the
      // old closeDelivery window) it stays settleable indefinitely.
      //
      // Contract under test: `backfill()` discovers the position from
      // history AND its trailing `sweep()` settles it on the same boot —
      // no live event, no scheduler tick required.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);

      // Move time past deliveryAt *before* the keeper boots, so the live
      // subscription would miss the (long-past) LotCreated event.
      const deliveryAt = ctx.config.futuresFirstDeliveryDate;
      await testClient.setNextBlockTimestamp({ timestamp: deliveryAt + 120n });
      await testClient.mine({ blocks: 1 });
      // Refresh the oracle so `_getHashpriceUsd` doesn't revert `OracleStale`
      // when settlement reads the mark.
      await ctx.bumpHashprice(ctx.config.initialHashprice);

      keeper = buildKeeper(ctx, {
        liquidatorPrivateKey: HARDHAT_PRIVATE_KEYS[4],
        delivery: true,
      });
      await keeper.start();
      assert.ok(keeper.delivery);

      const alice = ctx.accounts.alice.account.address;
      const positionsBefore = await readFuturesPositionIds(ctx, alice);
      assert.ok(positionsBefore.length > 0, "precondition: alice has positions to settle");

      // backfill() runs an immediate sweep at the end — past-due positions
      // settle without waiting on the periodic timer.
      await keeper.delivery.backfill(0n, 10_000n);

      await expectFuturesClosed(ctx, alice);
      for (const id of positionsBefore) {
        assert.ok(
          (await readLotClosedBlock(ctx, id)) !== null,
          `missed delivery for ${id} should be settled by backfill sweep`,
        );
      }
    },
  );

  it(
    "bootstrapFromUsers indexes & settles via contract views (no log scan)",
    { timeout: 60_000 },
    async () => {
      // Production reality: on Alchemy free tier `eth_getLogs` is capped
      // at 10 blocks, so log-based backfill is unusable for any non-trivial
      // window. The view-based discovery path (`bootstrapFromUsers`) reads
      // `getPositionIds` + `getPositionById` directly from contract storage,
      // sidestepping the log limit entirely. This test exercises that exact
      // recovery shape: we never call `backfill()` — only `bootstrapFromUsers`
      // — and verify every still-alive position is found and settled.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);
      keeper = buildKeeper(ctx, {
        liquidatorPrivateKey: HARDHAT_PRIVATE_KEYS[4],
        delivery: true,
      });
      await keeper.start();
      assert.ok(keeper.delivery);

      const alice = ctx.accounts.alice.account.address;
      const positionsBefore = await readFuturesPositionIds(ctx, alice);
      assert.ok(positionsBefore.length > 0);

      await keeper.delivery.bootstrapFromUsers([alice]);
      for (const id of positionsBefore) {
        assert.ok(keeper.delivery.has(id), `bootstrap should index position ${id}`);
      }

      const deliveryAt = ctx.config.futuresFirstDeliveryDate;
      await testClient.setNextBlockTimestamp({ timestamp: deliveryAt + 60n });
      await testClient.mine({ blocks: 1 });
      await ctx.bumpHashprice(ctx.config.initialHashprice);

      await keeper.delivery.sweep();

      await expectFuturesClosed(ctx, alice);
      for (const id of positionsBefore) {
        assert.ok(
          (await readLotClosedBlock(ctx, id)) !== null,
          `position ${id} should be settled via view-based bootstrap`,
        );
        assert.equal(keeper.delivery.has(id), false);
      }
    },
  );

  it(
    "DELIVERY_BOOTSTRAP_USERS recovers a stuck user the tracker never discovered",
    { timeout: 60_000 },
    async () => {
      // Operational scenario from production: the tracker's log backfill
      // failed (Alchemy free tier rate-limits eth_getLogs), so a known user
      // with a past-due futures position is invisible to every other
      // discovery path. Operator sets DELIVERY_BOOTSTRAP_USERS=<addr> as
      // an emergency seed; the coordinator reads the user's positions via
      // the view path and settles them on the first sweep.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);

      // Move past deliveryAt before boot — same shape as the production
      // outage where the keeper has been down/blind during the delivery
      // window.
      const deliveryAt = ctx.config.futuresFirstDeliveryDate;
      await testClient.setNextBlockTimestamp({ timestamp: deliveryAt + 120n });
      await testClient.mine({ blocks: 1 });
      await ctx.bumpHashprice(ctx.config.initialHashprice);

      const alice = ctx.accounts.alice.account.address;
      keeper = buildKeeper(ctx, {
        liquidatorPrivateKey: HARDHAT_PRIVATE_KEYS[4],
        delivery: true,
        deliveryBootstrapUsers: [alice],
      });
      await keeper.start();
      assert.ok(keeper.delivery);

      const positionsBefore = await readFuturesPositionIds(ctx, alice);
      assert.ok(positionsBefore.length > 0, "precondition: alice has past-due positions");

      // Mimic the boot wiring: tracker.list() is empty (we never started
      // backfill / live discovery), but the manual seed list configured via
      // DELIVERY_BOOTSTRAP_USERS still feeds the coordinator.
      await keeper.delivery.bootstrapFromUsers(keeper.config.delivery.bootstrapUsers);
      assert.deepEqual(
        [...keeper.config.delivery.bootstrapUsers],
        [alice],
        "bootstrap list should be the seeded address",
      );

      await expectFuturesClosed(ctx, alice);
      for (const id of positionsBefore) {
        assert.ok(
          (await readLotClosedBlock(ctx, id)) !== null,
          `manually-seeded position ${id} should be settled`,
        );
      }
    },
  );

  it(
    "settles with a non-validator signer (settlePosition is permissionless)",
    { timeout: 60_000 },
    async () => {
      // settlePosition has no validator/participant gate, so a stock keeper
      // running the DEFAULT liquidator key (account #3, NOT the validator #4)
      // must still be able to cash-settle matured positions. This is the
      // whole point of the cash-settlement migration: no special role needed.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);
      keeper = buildKeeper(ctx, {
        // Note: no `liquidatorPrivateKey` override → default account #3.
        delivery: true,
      });
      await keeper.start();
      assert.ok(keeper.delivery);

      const alice = ctx.accounts.alice.account.address;
      const positionsBefore = await readFuturesPositionIds(ctx, alice);
      assert.ok(positionsBefore.length > 0, "fixture should have created positions");

      await keeper.delivery.backfill(0n, 10_000n);

      const deliveryAt = ctx.config.futuresFirstDeliveryDate;
      await testClient.setNextBlockTimestamp({ timestamp: deliveryAt + 60n });
      await testClient.mine({ blocks: 1 });
      await ctx.bumpHashprice(ctx.config.initialHashprice);

      await keeper.delivery.sweep();

      await expectFuturesClosed(ctx, alice);
      for (const id of positionsBefore) {
        assert.ok(
          (await readLotClosedBlock(ctx, id)) !== null,
          `position ${id} should be settled by a permissionless (non-validator) signer`,
        );
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Local utilities
// ─────────────────────────────────────────────────────────────────────────

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
