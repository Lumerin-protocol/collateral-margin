import pino from "pino";
import { loadDotenvFiles } from "../../core/env.ts";
import { configBigint } from "../../core/config/base.ts";
import { createNetworkClients } from "../../core/client.ts";
import { WalletRegistry } from "../../core/wallet.ts";
import { OracleTracker } from "../../core/oracleTracker.ts";
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
import { createFuturesVenue } from "../../adapters/futures/index.ts";
import { loadFuturesConfig } from "./config.ts";

async function main(): Promise<void> {
  loadDotenvFiles(import.meta.dirname);
  const config = loadFuturesConfig();
  const logger = pino({ level: config.logLevel, serializers: { err: serializeError } });
  logger.info({ venue: "futures", address: config.venue.address, dryRun: config.dryRun }, "starting futures mm");

  const network = createNetworkClients(config.network.name, config.network.rpcUrl);
  const wallets = new WalletRegistry(config.wallets, network.chain, network.transport);
  const wallet = wallets.get(config.venue.wallet);

  const venue = await createFuturesVenue({
    network,
    wallet,
    address: config.venue.address,
    logger,
  });
  const instrument = await venue.getInstrument();

  // Futures' OwnOrderSource is cache-backed (no on-chain "list my orders"),
  // so we explicitly seed the cache before the book tracker resyncs. Perps
  // is stateless and skips this step.
  await instrument.ownOrders.bootstrap();

  const oracle = new OracleTracker(instrument, logger);
  const gas = new GasTracker(
    network.publicClient,
    {
      ethPriceFeedAddress: config.network.ethPriceFeed === "" ? undefined : config.network.ethPriceFeed,
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
  const collateral = new CollateralTracker(
    venue.account,
    {
      autoDeposit: config.collateral.autoDeposit,
      autoDepositMinAmount: configBigint(config.collateral.autoDepositMinAmount, "collateral.autoDepositMinAmount"),
    },
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

  const baseQuantity = configBigint(config.sizing.baseQuantity, "sizing.baseQuantity");
  const quoter = new Quoter(
    instrument,
    {
      pricing: {
        strategy: "reservation-price",
        riskAversion: config.pricing.riskAversion,
        marginCallTimeSeconds: config.pricing.marginCallTimeSeconds,
        minSpreadBps: config.pricing.minSpreadBps,
        volatilityMultiplier: config.pricing.volatilityMultiplier,
        gasPenaltyBps: config.risk.gasPenaltyBps,
      },
      sizing: {
        strategy: "geometric-taper",
        baseQuantity,
        numLevelsPerSide: config.sizing.numLevelsPerSide,
        taperRatio: config.sizing.taperRatio,
      },
      maxSkewTicks: config.pricing.maxSkewTicks,
      levelSpacingTicks: config.timing.levelSpacingTicks,
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
    appName: "futures-mm",
    configSummary: summariseConfig(config),
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

function summariseConfig(c: ReturnType<typeof loadFuturesConfig>): Record<string, unknown> {
  return {
    nodeEnv: c.nodeEnv,
    commitHash: c.commitHash,
    logLevel: c.logLevel,
    dryRun: c.dryRun,
    network: c.network.name,
    venue: { kind: c.venue.kind, address: c.venue.address },
    pricing: c.pricing,
    sizing: c.sizing,
    risk: c.risk,
    gas: c.gas,
    timing: c.timing,
  };
}

main();
