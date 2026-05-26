import pino from "pino";
import { loadDotenvFiles } from "../../core/env.ts";
import { createNetworkClients } from "../../core/client.ts";
import { WalletRegistry } from "../../core/wallet.ts";
import { OracleTracker } from "../../core/oracleTracker.ts";
import { HashpriceOracleSubgraphSource } from "../../core/historicalPriceSource.ts";
import { GasTracker } from "../../core/gasTracker.ts";
import { InventoryManager } from "../../core/inventoryManager.ts";
import { CollateralTracker } from "../../core/collateralTracker.ts";
import { RiskManager } from "../../core/riskManager.ts";
import { BookTracker } from "../../core/bookTracker.ts";
import { Quoter } from "../../core/quoter.ts";
import { OrderExecutor } from "../../core/orderExecutor.ts";
import { HealthCheck } from "../../core/healthcheck.ts";
import { runMakerLoop } from "../../core/runner.ts";
import { serializeError } from "../../core/errSerializer.ts";
import { createPerpsVenue } from "../../adapters/perps/index.ts";
import { sanitiseConfig } from "../../core/config/base.ts";
import { loadPerpsConfig } from "./config.ts";

async function main(): Promise<void> {
  loadDotenvFiles(import.meta.dirname);
  const config = loadPerpsConfig();
  const logger = pino({
    level: config.logLevel,
    serializers: { err: serializeError },
  });
  logger.info(
    { venue: "perps", address: config.venue.address, dryRun: config.dryRun },
    "starting perps mm",
  );

  const network = createNetworkClients(
    config.network.name,
    config.network.rpcUrl,
  );
  const wallets = new WalletRegistry(
    config.wallets,
    network.chain,
    network.transport,
  );
  const wallet = wallets.get(config.venue.wallet);

  const venue = await createPerpsVenue({
    network,
    wallet,
    address: config.venue.address,
    readBatchSize: config.readBatchSize,
    cancelBatchSize: config.cancelBatchSize,
    createBatchSize: config.createBatchSize,
    logger,
  });
  const instrument = await venue.getInstrument();

  const history = config.oracle.history
    ? new HashpriceOracleSubgraphSource({
        url: config.oracle.history.subgraphUrl,
        logger,
      })
    : undefined;
  const oracle = new OracleTracker(instrument, logger, {
    windowSize: config.oracle.windowSize,
    precisionBits: config.oracle.precisionBits,
    historyLookbackMultiplier: config.oracle.historyLookbackMultiplier,
    history,
    pollIntervalMs: config.timing.pollIntervalMs,
  });
  const gas = new GasTracker(
    network.publicClient,
    {
      ethPriceFeedAddress:
        config.network.ethPriceFeed === ""
          ? undefined
          : config.network.ethPriceFeed,
      gasSpikeThresholdPct: config.risk.gasSpikeThresholdPct,
      gasCapMultiplier: config.gas.gasCapMultiplier,
    },
    logger,
  );
  const inventory = new InventoryManager(
    instrument,
    { maxPositionSize: config.risk.maxPositionSize },
    logger,
  );
  const collateral = new CollateralTracker(
    venue.account,
    {
      autoDeposit: config.collateral.autoDeposit,
      autoDepositMinAmount: config.collateral.autoDepositMinAmount,
      maxCollateralAmount: config.collateral.maxCollateralAmount,
    },
    logger,
  );
  const risk = new RiskManager(
    {
      maxPositionSize: config.risk.maxPositionSize,
      maxUtilizationPct: config.risk.maxUtilizationPct,
      minCollateralBalance: config.risk.minCollateralBalance,
      maxDailyLossUsd: config.risk.maxDailyLossUsd,
      maxGasBudgetPerHourUsd: config.risk.maxGasBudgetPerHourUsd,
      maxGasBudgetPerDayUsd: config.risk.maxGasBudgetPerDayUsd,
    },
    inventory,
    collateral,
    gas,
    oracle,
    logger,
  );
  const book = new BookTracker(
    instrument,
    { resyncIntervalMs: config.timing.resyncIntervalMs, snapshotDepth: 200 },
    logger,
  );

  const quoter = new Quoter(
    instrument,
    {
      pricing: {
        strategy: "effective-spread",
        minSpreadBps: config.pricing.minSpreadBps,
        volatilityMultiplier: config.pricing.volatilityMultiplier,
        inventorySkewGamma: config.pricing.inventorySkewGamma,
        gasPenaltyBps: config.risk.gasPenaltyBps,
      },
      sizing: {
        strategy: "linear",
        baseQuantity: config.sizing.baseQuantity,
        numLevelsPerSide: config.sizing.numLevelsPerSide,
      },
      maxSkewTicks: config.pricing.maxSkewTicks,
      levelSpacingTicks: config.timing.levelSpacingTicks,
      volHorizonSec: config.timing.pollIntervalMs / 1000,
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
    appName: "perps-mm",
    configSummary: sanitiseConfig(config),
    oracle,
    inventory,
    collateral,
    book,
    gas,
    risk,
    logger,
  });

  await runMakerLoop({
    pollIntervalMs: config.timing.pollIntervalMs,
    cancelOrdersOnShutdown: config.cancelOrdersOnShutdown,
    instrument,
    oracle,
    gas,
    book,
    inventory,
    collateral,
    risk,
    quoter,
    executor,
    health,
    logger,
  });
}

main();
