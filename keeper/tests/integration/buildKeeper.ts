import pino from "pino";
import pretty from "pino-pretty";
import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Address,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import type { Config } from "../../src/config.ts";
import type { Chain } from "../../src/chain.ts";
import { ParticipantTracker } from "../../src/discovery/tracker.ts";
import { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import { Planner } from "../../src/coordinator/planner.ts";
import { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { Notifier } from "../../src/alert/notifier.ts";
import { PerpsVenue } from "../../src/venues/perps.ts";
import { FuturesVenue } from "../../src/venues/futures.ts";
import { PriceFeed } from "../../src/oracle/priceFeed.ts";
import { PredictiveCoordinator } from "../../src/predict/coordinator.ts";
import { DeliveryCoordinator } from "../../src/delivery/coordinator.ts";
import type { Venue } from "../../src/venues/types.ts";
import type { DeployedStack } from "./deployStack.ts";
import { HARDHAT_PRIVATE_KEYS } from "./deployStack.ts";

/**
 * Wires the keeper component graph against an already-deployed stack.
 * Mirrors the order in `keeper/src/index.ts::main` but skips bits the test
 * doesn't need (Healthcheck HTTP server, WebhookIngester, SIGINT handlers).
 *
 * Every component sees the SAME `Chain` instance; the `publicClient` is
 * configured with a 100ms polling interval so `watchContractEvent` reacts
 * fast enough that `waitFor` loops don't time out (the keeper's default is
 * viem's 4s, which would dominate every test).
 *
 * Returns a small lifecycle facade. Callers should always `await kp.stop()`
 * in their `afterEach` — leaked `watchContractEvent` unwatchers fire after
 * `evm_revert` and tend to crash the next test with stale state.
 */
export interface KeeperHarness {
  config: Config;
  chain: Chain;
  tracker: ParticipantTracker;
  queue: CoordinatorQueue;
  planner: Planner;
  executor: CoordinatorExecutor;
  scheduler: Scheduler;
  notifier: Notifier;
  priceFeed: PriceFeed;
  predictor: PredictiveCoordinator;
  /**
   * Only present when `BuildKeeperOverrides.delivery` is set. Tests that
   * exercise the delivery module must pass `delivery: true` and ensure the
   * keeper signer equals the Futures contract's `validatorAddress` —
   * otherwise every `closeDelivery` simulate fails authorization and the
   * sweep silently no-ops.
   */
  delivery?: DeliveryCoordinator;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BuildKeeperOverrides {
  webhookUrl?: string;
  /** Default 60_000 — set lower to exercise the periodic sweep mid-test. */
  sweepIntervalMs?: number;
  /** Default "warn"; set "debug" when diagnosing a failing test. */
  logLevel?: pino.Level;
  /** Inject your own keeper signer key. Defaults to Hardhat account #3. */
  liquidatorPrivateKey?: `0x${string}`;
  /**
   * Wire up the optional `DeliveryCoordinator`. Defaults to false. When
   * true, tests should also pass `liquidatorPrivateKey: HARDHAT_PRIVATE_KEYS[4]`
   * (the validator) so `closeDelivery` simulations pass the contract's
   * `_msgSender() == validatorAddress` guard.
   */
  delivery?: boolean;
  /**
   * Manual seed list for the delivery coordinator. Mirrors
   * `DELIVERY_BOOTSTRAP_USERS` in production. Tests use it to verify that
   * a known stuck user can be settled even when the tracker never
   * discovered them (e.g. log backfill broken on a rate-limited RPC).
   */
  deliveryBootstrapUsers?: readonly Address[];
  /**
   * Maximum closeDelivery calls bundled into one Futures.multicall tx by
   * the delivery coordinator. Defaults to 50 for parity with production.
   * Override to a small value to assert batching behaviour explicitly
   * (e.g. set to 1 to force per-id calls, or 2 to assert chunked sweeps).
   */
  deliveryMaxBatchSize?: number;
}

const LIQUIDATOR_PK = HARDHAT_PRIVATE_KEYS[3];

export function buildKeeper(
  stack: DeployedStack,
  overrides: BuildKeeperOverrides = {},
  logger?: pino.Logger,
): KeeperHarness {
  const config = buildConfig(stack, overrides);
  // Reuse the stack's publicClient so every keeper shares ONE transport —
  // creating a new http() transport per keeper accumulates socket listeners
  // (undici unpipe events) and triggers MaxListenersExceededWarning in CI.
  const chain = buildChain(
    stack.transport,
    overrides.liquidatorPrivateKey ?? LIQUIDATOR_PK,
    stack.addresses.multicall3,
  );

  const log =
    logger ??
    pino(pretty({ sync: true, colorize: true, minimumLevel: "fatal" }));

  const venues: Venue[] = [
    new PerpsVenue(chain, config, log),
    new FuturesVenue(chain, config, log),
  ];

  const notifier = new Notifier(config, log);
  const tracker = new ParticipantTracker(chain, config, log);
  const queue = new CoordinatorQueue();
  const planner = new Planner(chain, config, venues, log);
  const executor = new CoordinatorExecutor(config, queue, planner, log);
  const scheduler = new Scheduler(
    chain,
    config,
    tracker,
    queue,
    executor,
    notifier,
    log,
  );
  // tokenDecimals flows from the deploy stack so the PriceFeed rescales
  // the BTC/USDC answer to the same units used by the venue contracts.
  const priceFeed = new PriceFeed(
    chain,
    config,
    log,
    stack.config.tokenDecimals,
  );
  const predictor = new PredictiveCoordinator(
    chain,
    config,
    tracker,
    queue,
    executor,
    priceFeed,
    log,
    notifier,
  );

  // Newly-tracked users wake idle workers — same edge `keeper/src/index.ts`
  // wires in production.
  tracker.onAdded(() => executor.kick());

  // Optional delivery coordinator — opt-in per test. Built but not started;
  // start() below boots it after the live tracker is up so it sees the same
  // event ordering production does.
  const delivery =
    overrides.delivery === true
      ? new DeliveryCoordinator(chain, config, log)
      : undefined;

  let started = false;
  return {
    config,
    chain,
    tracker,
    queue,
    planner,
    executor,
    scheduler,
    notifier,
    priceFeed,
    predictor,
    delivery,
    async start() {
      if (started) return;
      started = true;
      await priceFeed.start();
      await predictor.start();
      await tracker.start();
      if (delivery !== undefined) await delivery.start();
      await executor.start();
      // Scheduler is NOT started: tests drive it manually via
      // `scheduler.runSweep()` to avoid timer races against `evm_revert`.
    },
    async stop() {
      if (!started) return;
      started = false;
      scheduler.stop();
      predictor.stop();
      priceFeed.stop();
      delivery?.stop();
      await executor.stop();
      tracker.stop();
    },
  };
}

function buildConfig(
  stack: DeployedStack,
  overrides: BuildKeeperOverrides,
): Config {
  return {
    version: "test",
    chain: {
      network: "hardhat",
      rpcUrl: stack.rpcUrl,
      discoveryMode: "events",
      backfillChunkSize: 10_000n,
    },
    vault: { address: stack.addresses.vault },
    perps: { address: stack.addresses.perps },
    futures: { address: stack.addresses.futures },
    pme: { address: stack.addresses.pme },
    oracle: {
      hashpriceUsdcAddress: stack.addresses.hashpriceOracle,
      btcUsdcFeedAddress: stack.addresses.btcUsdcFeed,
      priceMoveTriggerBps: 0, // process every event for deterministic tests
    },
    keeper: {
      privateKey: overrides.liquidatorPrivateKey ?? LIQUIDATOR_PK,
      dryRun: false,
      minProfitMargin: 0n,
    },
    alerts: {
      webhookUrl: overrides.webhookUrl,
      dedupeMs: 0, // disable dedupe for tests — every alert fires
      imWarnUtilization: 0.8,
      imCriticalUtilization: 0.95,
    },
    triggers: {
      webhookPort: 0,
    },
    coordinator: {
      maxConcurrentAccounts: 1,
      confirmationBlocks: 0,
    },
    runtime: {
      sweepIntervalMs: overrides.sweepIntervalMs ?? 60_000,
      healthPort: 0,
      logLevel: overrides.logLevel ?? "warn",
      // Effectively disabled in integration tests — the monitor is wired
      // in production (see `index.ts`) but has no role in fixture-driven
      // assertions, and a 5-min interval would never fire anyway.
      balanceCheckIntervalMs: 60 * 60 * 1000,
      balanceLowWei: 10_000_000_000_000_000n,
      balanceCriticalWei: 1_000_000_000_000_000n,
    },
    outdatedOrders: {
      // Disabled by default in integration tests — they cover liquidation
      // and delivery flows; expired-order sweep has its own unit tests.
      // Tests that want to exercise it can override via a future flag.
      sweepIntervalMs: 0,
      maxBatchSize: 50,
    },
    delivery: {
      enabled: overrides.delivery === true,
      blameSeller: true,
      // Tighter than production so tests don't have to wait a minute for
      // the safety-net sweep when they want to verify backfill behaviour.
      sweepIntervalMs: 1_000,
      settleDelayMs: 0,
      bootstrapUsers: overrides.deliveryBootstrapUsers ?? [],
      maxBatchSize: overrides.deliveryMaxBatchSize ?? 50,
    },
  };
}

/**
 * Test-local equivalent of `keeper/src/chain.ts::createChain`. Two
 * meaningful differences from the production wiring:
 *
 *   1. `pollingInterval: 100` — `watchContractEvent` (tracker, priceFeed,
 *      predictor) sees new logs in ~one polling tick rather than the
 *      default 4s. Without this, every event-based test would idle for
 *      seconds before the keeper noticed anything happened.
 *   2. `contracts.multicall3.address` set to whatever address `deployStack`
 *      installed Multicall3 at. viem's `multicall` action refuses to run
 *      against a chain whose `multicall3` is unconfigured — `pme/health.ts`
 *      uses it for batched reads, so it's a hard requirement.
 */
function buildChain(
  transport: Transport,
  privateKey: `0x${string}`,
  multicall3Address: `0x${string}`,
): Chain {
  const account: Account = privateKeyToAccount(privateKey);
  const chainWithMulticall = {
    ...hardhat,
    contracts: {
      ...hardhat.contracts,
      multicall3: { address: multicall3Address },
    },
  };
  // Derive a new publicClient from the same transport so watchContractEvent
  // polling reuses the stack's shared connection pool. The multicall3 config
  // is patched onto the chain definition; the transport is inherited.
  const publicClient: PublicClient = createPublicClient({
    chain: chainWithMulticall,
    transport,
    pollingInterval: 100,
  });
  const walletClient: WalletClient = createWalletClient({
    chain: chainWithMulticall,
    transport,
    account,
  });
  return { publicClient, walletClient, account };
}
