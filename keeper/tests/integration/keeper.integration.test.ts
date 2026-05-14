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
  futuresLongCrashFixtureBuilder,
  futuresOrdersAndPositionFixtureBuilder,
  multiFuturesFixtureBuilder,
  crossVenueFixtureBuilder,
} from "./scenarios.ts";
import {
  discoverUser,
  discoverAndIndex,
  runOneSweep,
  readFuturesOrderIds,
  expectPerpsClosed,
  expectFuturesClosed,
  expectNoOpenOrders,
  expectHealthy,
  isCriticalAlert,
  waitFor,
} from "./helpers.ts";

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
let futuresLongCrashFixture: ReturnType<typeof futuresLongCrashFixtureBuilder>;
let futuresOrdersAndPositionFixture: ReturnType<typeof futuresOrdersAndPositionFixtureBuilder>;
let multiFuturesFixture: ReturnType<typeof multiFuturesFixtureBuilder>;
let crossVenueFixture: ReturnType<typeof crossVenueFixtureBuilder>;

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
    futuresLongCrashFixture = futuresLongCrashFixtureBuilder(node.rpcUrl);
    futuresOrdersAndPositionFixture = futuresOrdersAndPositionFixtureBuilder(node.rpcUrl);
    multiFuturesFixture = multiFuturesFixtureBuilder(node.rpcUrl);
    crossVenueFixture = crossVenueFixtureBuilder(node.rpcUrl);
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

  // NOTE: this exercises the planner's orders-leg-then-position-leg flow
  // on the perps venue. Currently blocked by a keeper/contract drift —
  // `PerpsVenue.liquidateOrders` calls a batch `liquidateOrders(user, ids[])`
  // entry point that was retired in favour of N `liquidateOrder` calls
  // composed via `multicallStopOnFailure` (see
  // perps/contracts/tests/liquidateOrdersAndPosition.test.ts). The keeper
  // adapter needs to switch to that primitive before this scenario
  // becomes pass-able. Until then the planner's two-leg flow is still
  // exercised on the *futures* venue (see "Futures liquidation" below),
  // which retains a native batch `liquidateOrders(user)`.
  it.todo(
    "cancels resting orders alongside the position liquidation (blocked on keeper#perps batch-orders gap)",
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
      const ctx = await loadFixture(crossVenueFixture, testClient);
      keeper = buildKeeper(ctx);
      await keeper.start();

      const alice = ctx.accounts.alice.account.address;
      await ctx.makeLiquidatable();
      await runOneSweep(keeper, alice);

      await expectPerpsClosed(ctx, alice);
      await expectFuturesClosed(ctx, alice);
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
