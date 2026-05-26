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
  crossVenuePerpsDominantFixtureBuilder,
  crossVenueFuturesDominantFixtureBuilder,
  crossVenueOrdersAndPositionsFixtureBuilder,
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
  expectPerpsClosed,
  expectFuturesClosed,
  expectNoOpenOrders,
  expectHealthy,
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
let crossVenuePerpsDominantFixture: ReturnType<typeof crossVenuePerpsDominantFixtureBuilder>;
let crossVenueFuturesDominantFixture: ReturnType<typeof crossVenueFuturesDominantFixtureBuilder>;
let crossVenueOrdersAndPositionsFixture: ReturnType<typeof crossVenueOrdersAndPositionsFixtureBuilder>;

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
    crossVenuePerpsDominantFixture = crossVenuePerpsDominantFixtureBuilder(node.rpcUrl);
    crossVenueFuturesDominantFixture = crossVenueFuturesDominantFixtureBuilder(node.rpcUrl);
    crossVenueOrdersAndPositionsFixture = crossVenueOrdersAndPositionsFixtureBuilder(node.rpcUrl);
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
      // first delivery date. The unrealized loss is `(entryPrice − marketPrice)
      // · deliveryDurationDays · qty`; sized so the deposit can't cover it.
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
      // long ($29.40 loss). The planner's `rankPositions` orders by
      // `unrealizedLoss DESC`, so perps must be closed strictly before
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
      // ($4.20 loss) + 20-unit futures long ($588 loss across the 7-day
      // delivery window). Futures must be closed strictly before perps,
      // confirming the planner's ranking is by loss size and not by a
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
      // at fixture time. The keeper boots with delivery enabled and the
      // *validator* signing key — so `closeDelivery` simulations clear
      // the contract's `_msgSender() == validatorAddress` guard.
      //
      // We then fast-forward the chain past `deliveryAt` and trigger one
      // sweep. The contract's `_closeAndCashSettleDelivery` cash-settles
      // the entire window at the current market price (positionElapsedTime
      // = 0 → no contract-price portion), and emits `LotClosed`
      // followed by `LotClosed`.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);
      keeper = buildKeeper(ctx, {
        liquidatorPrivateKey: HARDHAT_PRIVATE_KEYS[4], // validator
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

      // Fast-forward past `deliveryAt`. `closeDelivery` requires
      // `block.timestamp >= position.deliveryAt`, and `block.timestamp` is
      // only advanced once a block is mined at the new clock.
      const deliveryAt = ctx.config.futuresFirstDeliveryDate;
      await testClient.setNextBlockTimestamp({ timestamp: deliveryAt + 60n });
      await testClient.mine({ blocks: 1 });

      // The hashprice oracle has been silent for 7 days — refresh it so
      // `_getHashpriceUsd` doesn't revert `OracleStale` inside
      // `closeDelivery`. We re-post the entry price; the cash-settlement
      // formula uses this as the "current market price" applied to the
      // full delivery window (positionElapsedTime = 0).
      await ctx.bumpHashprice(ctx.config.initialHashprice);

      await keeper.delivery.sweep();

      // End state: every position is gone from chain storage, each emitted
      // a `LotClosed` event from the keeper's signer, and the
      // index dropped all of them.
      await expectFuturesClosed(ctx, alice);
      const settledBlocks: bigint[] = [];
      for (const id of positionsBefore) {
        const settledBlock = await readLotClosedBlock(ctx, id);
        assert.ok(
          settledBlock !== null,
          `expected a LotClosed event for position ${id}`,
        );
        settledBlocks.push(settledBlock);
        assert.equal(keeper.delivery.has(id), false, `settled position ${id} is dropped`);
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
      // someone calls `closeDelivery` the position lingers, and the
      // settlement window stays open for `deliveryDurationDays`.
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
    "refuses to start when the keeper signer is not the futures validator",
    { timeout: 60_000 },
    async () => {
      // Operator-safety contract: if `DELIVERY_KEEPER_ENABLED=true` is set
      // but `LIQUIDATOR_PRIVATE_KEY` does not derive to
      // `Futures.validatorAddress()`, the coordinator must throw at start.
      // Bubbles up to `main().catch` → `process.exit(1)`; the orchestrator
      // (k8s, systemd) sees the crash, healthcheck flips to 503, and
      // standard infra alerting (CrashLoopBackOff etc.) pages on-call.
      // The alternative — silent `simulateContract` reverts at debug level —
      // is invisible at the default `info` log level and was the actual
      // production failure mode that motivated this check.
      const ctx = await loadFixture(futuresLongCrashFixture, testClient);
      const k = buildKeeper(ctx, {
        // Default liquidator key (account #3), NOT the validator (#4).
        delivery: true,
      });
      keeper = k;
      await assert.rejects(
        () => k.start(),
        /signer is not the futures validator/i,
        "boot must fail loudly so the operator cannot miss the misconfig",
      );

      // Sanity: nothing was indexed and no positions were settled.
      const alice = ctx.accounts.alice.account.address;
      const positionsBefore = await readFuturesPositionIds(ctx, alice);
      assert.ok(positionsBefore.length > 0, "fixture should have created positions");
      for (const id of positionsBefore) {
        assert.equal(
          await readLotClosedBlock(ctx, id),
          null,
          `position ${id} must not be settled by a misconfigured keeper`,
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
