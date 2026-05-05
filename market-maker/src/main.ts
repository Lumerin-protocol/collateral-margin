import pino from "pino";
import {
  BookTracker,
  GasTracker,
  HealthCheck,
  InventoryManager,
  OracleTracker,
  OrderExecutor,
  Quoter,
  RiskManager,
  WalletRegistry,
  configBigint,
  createAdapter,
  createNetworkClients,
  loadConfig,
  serializeError,
  toErrorInfo,
} from "./index.ts";
import "./adapters/perps/index.ts";
import "./adapters/futures/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = loadConfig();

  const logger = pino({
    level: config.logLevel,
    serializers: { err: serializeError },
  });

  logger.info(
    {
      venue: config.venue.kind,
      address: config.venue.address,
      network: config.network.name,
      dryRun: config.dryRun,
    },
    "starting market maker",
  );

  const network = createNetworkClients(config.network.name, config.network.rpcUrl);
  const wallets = new WalletRegistry(config.wallets, network.chain, network.transport);

  const venue = await createAdapter(config.venue.kind, {
    config,
    wallets,
    network,
    logger,
  });

  const instruments = await venue.listInstruments();
  if (instruments.length === 0) {
    throw new Error(`venue "${config.venue.kind}" returned no instruments`);
  }
  const instrument = instruments[0];
  if (instruments.length > 1) {
    logger.warn(
      { count: instruments.length, picking: instrument.id },
      "multi-instrument support is not yet wired in apps/maker; using first instrument only",
    );
  }

  const mmAddress = venue.wallet.account.address;
  logger.info({ wallet: venue.wallet.name, address: mmAddress }, "wallet ready");

  const oracle = new OracleTracker(instrument, logger);
  const gas = new GasTracker(
    network.publicClient,
    {
      ethPriceFeedAddress: config.network.ethPriceFeed,
      gasSpikeThresholdPct: config.risk.gasSpikeThresholdPct,
      gasCapMultiplier: config.gas.gasCapMultiplier,
    },
    logger,
  );
  const inventory = new InventoryManager(
    instrument,
    { maxPositionSize: configBigint(config.risk.maxPositionSize, "risk.maxPositionSize") },
    logger,
  );
  const risk = new RiskManager(
    {
      maxPositionSize: configBigint(config.risk.maxPositionSize, "risk.maxPositionSize"),
      maxUtilizationPct: config.risk.maxUtilizationPct,
      minCollateralBalance: configBigint(config.risk.minCollateralBalance, "risk.minCollateralBalance"),
      maxDailyLossUsd: configBigint(config.risk.maxDailyLossUsd, "risk.maxDailyLossUsd"),
      maxGasBudgetPerHourUsd: configBigint(config.risk.maxGasBudgetPerHourUsd, "risk.maxGasBudgetPerHourUsd"),
      maxGasBudgetPerDayUsd: configBigint(config.risk.maxGasBudgetPerDayUsd, "risk.maxGasBudgetPerDayUsd"),
    },
    inventory,
    gas,
    oracle,
    logger,
  );
  const book = new BookTracker(
    instrument,
    {
      resyncIntervalMs: config.timing.resyncIntervalMs,
      snapshotDepth: 200,
    },
    logger,
  );

  const baseQuantity = configBigint(config.sizing.baseQuantity, "sizing.baseQuantity");

  const quoter = new Quoter(
    instrument,
    {
      pricing: config.pricing.strategy === "reservation-price"
        ? {
            strategy: "reservation-price" as const,
            riskAversion: config.pricing.riskAversion ?? 0.1,
            marginCallTimeSeconds: config.pricing.marginCallTimeSeconds ?? 3600,
            minSpreadBps: config.pricing.minSpreadBps,
            volatilityMultiplier: config.pricing.volatilityMultiplier,
            gasPenaltyBps: config.risk.gasPenaltyBps,
          }
        : {
            strategy: "effective-spread" as const,
            minSpreadBps: config.pricing.minSpreadBps,
            volatilityMultiplier: config.pricing.volatilityMultiplier,
            inventorySkewGamma: config.pricing.inventorySkewGamma ?? 0,
            gasPenaltyBps: config.risk.gasPenaltyBps,
          },
      sizing:
        config.sizing.strategy === "geometric-taper"
          ? {
              strategy: "geometric-taper",
              baseQuantity,
              numLevelsPerSide: config.sizing.numLevelsPerSide,
              taperRatio: config.sizing.taperRatio ?? 0.5,
            }
          : {
              strategy: "linear",
              baseQuantity,
              numLevelsPerSide: config.sizing.numLevelsPerSide,
            },
      maxSkewTicks: config.pricing.maxSkewTicks,
    },
    oracle,
    gas,
    inventory,
    risk,
    logger,
  );
  const executor = new OrderExecutor(
    instrument,
    {
      requoteCooldownMs: config.timing.requoteCooldownMs,
      requoteThresholdTicks: config.timing.requoteThresholdTicks,
      urgentRequoteThresholdTicks: config.risk.urgentRequoteThresholdTicks,
      dryRun: config.dryRun,
    },
    quoter,
    book,
    gas,
    risk,
    oracle,
    logger,
  );
  const health = new HealthCheck({
    port: config.health.port,
    config,
    oracle,
    inventory,
    book,
    gas,
    risk,
    logger,
  });

  health.executorStats = executor.stats;
  health.walletAddress = mmAddress;

  health.onStop = async () => {
    logger.info("stop requested via API, cancelling orders");
    await executor.cancelAll();
    book.stop();
  };
  health.onStart = async () => {
    logger.info("start requested via API, re-initializing");
    await book.start();
    await oracle.update();
    await gas.update();
    await inventory.update();
  };

  await health.start();

  const BASE_ERROR_DELAY_MS = 5_000;
  const MAX_ERROR_DELAY_MS = 3 * 60_000;

  for (let attempt = 1; ; attempt++) {
    try {
      await quoter.initialize();
      await gas.calibrate(() => instrument.estimateCreateGas(mmAddress));
      await book.start();
      await oracle.update();
      await gas.update();
      await inventory.update();
      risk.initialize();
      health.status = "running";
      health.lastError = null;
      break;
    } catch (err) {
      health.status = "init-error";
      health.lastError = toErrorInfo(err);
      const delay = Math.min(BASE_ERROR_DELAY_MS * 2 ** (attempt - 1), MAX_ERROR_DELAY_MS);
      logger.warn({ err, attempt, retryInMs: delay }, "initialization failed, retrying");
      await sleep(delay);
    }
  }

  logger.info("initialization complete, entering main loop");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down…");
    try {
      await executor.cancelAll();
    } catch (err) {
      logger.error({ err }, "failed to cancel orders during shutdown");
    }
    book.stop();
    await health.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  let consecutiveErrors = 0;
  while (!shuttingDown) {
    if (health.paused) {
      await sleep(config.timing.pollIntervalMs);
      continue;
    }

    try {
      await oracle.update();
      await gas.update();
      await book.refresh();
      await inventory.update();

      if (inventory.walletTokenBalance > 0n && config.nodeEnv === "production") {
        try {
          await venue.topUpCollateral(inventory.walletTokenBalance);
          await inventory.update();
        } catch (err) {
          health.status = "error";
          health.lastError = toErrorInfo(err);
          logger.error({ err }, "failed to top up collateral");
        }
      }

      logger.info(
        {
          oracle: oracle.currentPrice.toString(),
          bid: book.bestBid.toString(),
          ask: book.bestAsk.toString(),
          pos: inventory.netQuantity.toString(),
          collateralBalance: inventory.collateralBalance.toString(),
          orders: book.ownOrders.size,
        },
        "tick",
      );

      const ok = risk.check();
      if (!ok) {
        health.status = "error";
        health.lastError = risk.haltReason;
        consecutiveErrors++;
        try {
          await executor.cancelAll();
        } catch (err) {
          health.lastError = toErrorInfo(err);
          logger.error({ err }, "failed to cancel orders after risk halt");
        }
      } else {
        const desired = quoter.computeQuotes();
        await executor.reconcile(desired);
        health.status = "running";
        health.lastError = null;
        consecutiveErrors = 0;
      }
    } catch (err) {
      consecutiveErrors++;
      health.status = "error";
      health.lastError = toErrorInfo(err);
      logger.error({ err }, "tick error");
    }

    health.tickCount++;
    health.lastTickAt = Date.now();
    const delay =
      consecutiveErrors > 0
        ? Math.min(BASE_ERROR_DELAY_MS * 2 ** consecutiveErrors, MAX_ERROR_DELAY_MS)
        : config.timing.pollIntervalMs;
    await sleep(delay);
  }
}

main();
