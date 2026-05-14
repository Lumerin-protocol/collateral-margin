import pino from "pino";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
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
}

const LIQUIDATOR_PK = HARDHAT_PRIVATE_KEYS[3];

export function buildKeeper(stack: DeployedStack, overrides: BuildKeeperOverrides = {}): KeeperHarness {
  const config = buildConfig(stack, overrides);
  const chain = buildChain(
    stack.rpcUrl,
    overrides.liquidatorPrivateKey ?? LIQUIDATOR_PK,
    stack.addresses.multicall3,
  );

  const logger = pino({
    level: overrides.logLevel ?? "warn",
    // The default JSON output makes test failures unreadable when tests
    // are timing-sensitive. `transport: pino-pretty` would be ideal but
    // requires the worker thread bootstrap — fine for dev but flaky in CI.
    // We just turn off the noisy hostname/pid/time fields instead.
    base: undefined,
    timestamp: false,
  });

  const venues: Venue[] = [
    new PerpsVenue(chain, config, logger),
    new FuturesVenue(chain, config, logger),
  ];

  const notifier = new Notifier(config, logger);
  const tracker = new ParticipantTracker(chain, config, logger);
  const queue = new CoordinatorQueue();
  const planner = new Planner(chain, config, venues, logger);
  const executor = new CoordinatorExecutor(config, queue, planner, logger);
  const scheduler = new Scheduler(chain, config, tracker, queue, executor, notifier, logger);
  // tokenDecimals flows from the deploy stack so the PriceFeed rescales
  // the BTC/USDC answer to the same units used by the venue contracts.
  const priceFeed = new PriceFeed(chain, config, logger, stack.config.tokenDecimals);
  const predictor = new PredictiveCoordinator(
    chain,
    config,
    tracker,
    queue,
    executor,
    priceFeed,
    logger,
    notifier,
  );

  // Newly-tracked users wake idle workers — same edge `keeper/src/index.ts`
  // wires in production.
  tracker.onAdded(() => executor.kick());

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
    async start() {
      if (started) return;
      started = true;
      await priceFeed.start();
      await predictor.start();
      await tracker.start();
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
      await executor.stop();
      tracker.stop();
    },
  };
}

function buildConfig(stack: DeployedStack, overrides: BuildKeeperOverrides): Config {
  return {
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
  rpcUrl: string,
  privateKey: `0x${string}`,
  multicall3Address: `0x${string}`,
): Chain {
  const transport = http(rpcUrl);
  const account: Account = privateKeyToAccount(privateKey);
  const chainWithMulticall = {
    ...hardhat,
    contracts: {
      ...hardhat.contracts,
      multicall3: { address: multicall3Address },
    },
  };
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
