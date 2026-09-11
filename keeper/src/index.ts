import pino from "pino";
import { CollateralVaultAbi } from "collateral-margin-abi/CollateralVault.ts";
import { serializeError } from "./util/errSerializer.ts";
import { loadConfig } from "./config.ts";
import { createChain } from "./chain.ts";
import { ParticipantTracker } from "./discovery/tracker.ts";
import { FuturesExpiryIndex } from "./discovery/futuresExpiryIndex.ts";
import { CombinedParticipantSource } from "./discovery/combined.ts";
import { WebhookIngester } from "./discovery/webhook.ts";
import { CoordinatorQueue } from "./coordinator/queue.ts";
import { Planner } from "./coordinator/planner.ts";
import { CoordinatorExecutor } from "./coordinator/executor.ts";
import { Notifier } from "./alert/notifier.ts";
import { Healthcheck } from "./runtime/healthcheck.ts";
import { Scheduler } from "./runtime/scheduler.ts";
import { BalanceMonitor } from "./runtime/balanceMonitor.ts";
import { PerpsVenue } from "./venues/perps.ts";
import { FuturesVenue } from "./venues/futures.ts";
import { PriceFeed } from "./oracle/priceFeed.ts";
import { EthUsdFeed } from "./oracle/ethUsdFeed.ts";
import { PredictiveCoordinator } from "./predict/coordinator.ts";
import { DeliveryCoordinator } from "./delivery/coordinator.ts";
import type { Venue } from "./venues/types.ts";

/**
 * Single long-running coordinator. No Lambda. One signer. Two venues today
 * (perps, futures), trivially extensible to options once it's live.
 *
 * Wiring order:
 *   1. Load config + open RPC.
 *   2. Build venue adapters (one per Perps / Futures).
 *   3. Stand up the coordinator queue + planner + executor.
 *   4. Wire the tracker → executor edge: a newly-discovered user kicks the
 *      executor so the next sweep picks them up immediately.
 *   5. Start ParticipantTracker (events) and optionally WebhookIngester.
 *   6. Start the periodic Scheduler (safety-net sweep).
 *   7. Start the healthcheck server.
 *   8. Run a one-shot historical backfill (vault + perps + futures logs) so
 *      the tracker is primed before the first sweep — closes the cold-start
 *      gap that the live event subscriptions can't see.
 *   9. Wait for SIGINT / SIGTERM, then stop everything in reverse order.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.runtime.logLevel,
    serializers: { err: serializeError },
  });

  logger.info(
    {
      perps: config.perps.address,
      futures: config.futures.address,
      vault: config.vault.address,
      pme: config.pme.address,
      dryRun: config.keeper.dryRun,
      discoveryMode: config.chain.discoveryMode,
    },
    "Starting collateral-margin keeper",
  );

  const chain = createChain(config);
  logger.info({ liquidator: chain.account.address }, "Wallet ready");

  // Read the vault's `decimals()` once at startup so every consumer (price
  // feed, planners, alerts) speaks the same units as on-chain balances. The
  // vault mirrors the wrapped collateral token's decimals on init, so this
  // is the canonical source — avoids a hard-coded "USDC = 6" that silently
  // drifts if we ever swap collateral assets.
  const tokenDecimals = await chain.publicClient.readContract({
    address: config.vault.address,
    abi: CollateralVaultAbi,
    functionName: "decimals",
  });
  logger.info({ tokenDecimals }, "Collateral token decimals");

  // Optional ETH/USD Chainlink feed for `gasCostUsd` enrichment on every
  // confirmed-tx log. Built only when the operator has configured an
  // aggregator address — when unset, every tx log still gets `gasUsed`
  // and `gasCostEth` but skips the USD field. Refresh cadence is fixed
  // at 60s because this is a logging-only price (drift of a minute is
  // immaterial when the consumer is a 4-a.m. operator scanning logs).
  const ethUsdFeed =
    config.oracle.ethUsdcFeedAddress !== undefined
      ? new EthUsdFeed(chain, config.oracle.ethUsdcFeedAddress, logger, 60_000)
      : undefined;
  if (ethUsdFeed === undefined) {
    logger.info(
      "ETH_USD_FEED_ADDRESS unset — confirmed-tx logs will include gasCostEth but skip gasCostUsd",
    );
  }

  const venues: Venue[] = [
    new PerpsVenue(chain, config, logger, ethUsdFeed),
    new FuturesVenue(chain, config, logger, ethUsdFeed),
  ];

  const notifier = new Notifier(config, logger);
  const tracker = new ParticipantTracker(chain, config, logger);
  const futuresExpiryIndex = new FuturesExpiryIndex(chain, config, logger);
  const participants = new CombinedParticipantSource([
    tracker,
    futuresExpiryIndex,
  ]);
  const queue = new CoordinatorQueue();
  const planner = new Planner(chain, config, venues, logger);
  const executor = new CoordinatorExecutor(config, queue, planner, logger);
  const scheduler = new Scheduler(
    chain,
    config,
    participants,
    queue,
    executor,
    notifier,
    logger,
  );

  // Predictive layer: subscribes to BTC/USDC AnswerUpdated events, reads
  // the current HashpriceUSDC value, and pre-computes per-user liquidation
  // thresholds so price ticks feed the coordinator queue directly. The
  // periodic Scheduler stays as a safety net at a relaxed cadence.
  const priceFeed = new PriceFeed(chain, config, logger, tokenDecimals);
  const predictor = new PredictiveCoordinator(
    chain,
    config,
    participants,
    queue,
    executor,
    priceFeed,
    logger,
    notifier,
  );

  let webhookIngester: WebhookIngester | undefined;
  if (config.chain.discoveryMode !== "events") {
    webhookIngester = new WebhookIngester(config, tracker, logger);
  }

  // Optional: cash-settle futures positions at their maturity (`expirationAt`)
  // via the permissionless `Futures.settlePosition`. Off by default. Any keeper
  // signer can settle — no validator role required. See `delivery/coordinator.ts`.
  let deliveryCoordinator: DeliveryCoordinator | undefined;
  if (config.delivery.enabled) {
    deliveryCoordinator = new DeliveryCoordinator(
      chain,
      config,
      logger,
      ethUsdFeed,
      futuresExpiryIndex,
    );
  }

  const health = new Healthcheck(
    config,
    chain.account.address,
    participants,
    executor,
    queue,
    logger,
    predictor,
    priceFeed,
    futuresExpiryIndex,
    deliveryCoordinator,
  );

  // Always-on gas-balance monitor on the keeper signer. Logs INFO with
  // current balance every tick (default 5 min), and escalates to WARN /
  // ERROR below the configured low / critical thresholds. Built outside
  // the delivery / executor coordinators because every tx-sending
  // module shares this same wallet — the monitor is a cross-cutting
  // concern, not specific to any one venue.
  const balanceMonitor = new BalanceMonitor(chain, config, logger);

  // Newly-tracked users should not wait for the next sweep tick. Kicking the
  // executor wakes any idle workers so they can pick up the new user as soon
  // as the next sweep enriches the queue. (We can't enqueue here without an
  // AccountHealth snapshot — that lives in the scheduler.)
  participants.onAdded(() => {
    executor.kick();
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  // Predictor / priceFeed stop before the tracker so their listeners
  // unhook before the tracker goes away.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down…");
    await health.stop();
    scheduler.stop();
    predictor.stop();
    priceFeed.stop();
    balanceMonitor.stop();
    ethUsdFeed?.stop();
    deliveryCoordinator?.stop();
    futuresExpiryIndex.stop();
    await executor.stop();
    if (webhookIngester !== undefined) await webhookIngester.stop();
    tracker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // ── Start ─────────────────────────────────────────────────────────────
  // Bind liveness before any historical replay. ECS must be able to observe
  // a healthy "booting" process while expiry discovery catches up.
  health.start();
  // PriceFeed first: primes `current()` with one read so the predictor has
  // a baseline before the first tracker event fires. Predictor next so its
  // tracker hooks are in place before tracker.start() flushes any backlog.
  await priceFeed.start();
  // ETH/USD feed primes cheaply (one read) and is logging-only — start
  // alongside the other oracle feeds so the very first tx after boot
  // already has a `gasCostUsd` value rather than waiting a tick.
  if (ethUsdFeed !== undefined) await ethUsdFeed.start();
  await predictor.start();
  await tracker.start();
  await futuresExpiryIndex.start();
  if (webhookIngester !== undefined) await webhookIngester.start();
  if (deliveryCoordinator !== undefined) await deliveryCoordinator.start();
  await executor.start();
  scheduler.start();
  // Eager initial check (logs the boot-time balance) + interval polling.
  // Started after the venues so a startup failure earlier doesn't leave
  // a phantom monitor running.
  await balanceMonitor.start();

  // Pull initial state so the first sweep tick has something to chew on
  // instead of waiting on event traffic. Backfill scans the same discovery
  // events the tracker live-subscribes to, from `backfillFromBlock` up to
  // the current head, then `runSweep` reads health for everyone we found.
  // Each newly-added user fires `tracker.onAdded`, which the predictor
  // consumes via `rebuild` — so the predictor index also gets seeded here.
  // No backfill anchor → forward-only (only safe with webhook discovery or
  // a prior keeper that's already populated the set out-of-band).
  if (config.chain.backfillFromBlock !== undefined) {
    await tracker.backfill(
      config.chain.backfillFromBlock,
      config.chain.backfillChunkSize,
    );
  } else {
    logger.warn(
      "BACKFILL_FROM_BLOCK unset — skipping historical scan; cold-start may miss participants until they next emit an event",
    );
  }
  await scheduler.runSweep();
  // Backfill fires `tracker.onAdded` for every existing user, which the
  // predictor consumes via `rebuild`. Those rebuilds are fire-and-forget,
  // so we wait until `inflightRebuilds` drains before claiming "running"
  // — otherwise the first health probe can race a half-built index.
  await predictor.awaitIdle();
  health.markReady();

  // If we discovered users but couldn't index any, something is wrong
  // with the snapshot path (RPC, ABI mismatch, oracle missing) — surface
  // it loudly. Tracker > 0 but predictor = 0 is a real outage shape.
  if (participants.size() > 0 && predictor.size() === 0) {
    logger.warn(
      { tracked: participants.size() },
      "tracker has users but predictor index is empty — snapshot path may be failing; check earlier 'rebuild failed' logs",
    );
  }

  logger.info(
    {
      tracked: participants.size(),
      predicted: predictor.size(),
      currentPrice: priceFeed.current()?.toString(),
    },
    "Keeper is running",
  );
}

main().catch((err) => {
  // Fail hard so the orchestrator restarts the pod with full logs.
  // Using stderr directly avoids pino formatting on a logger that might not
  // be initialised yet (e.g. config load failure).
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
