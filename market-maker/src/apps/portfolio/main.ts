import pino from "pino";
import { loadDotenvFiles } from "../../core/env.ts";
import { createNetworkClients } from "../../core/client.ts";
import { WalletRegistry } from "../../core/wallet.ts";
import { OracleTracker } from "../../core/oracleTracker.ts";
import { HashpriceOracleSubgraphSource } from "../../core/historicalPriceSource.ts";
import { GasTracker } from "../../core/gasTracker.ts";
import { InventoryManager } from "../../core/inventoryManager.ts";
import { CollateralTracker } from "../../core/collateralTracker.ts";
import { PortfolioCollateralAccount } from "../../core/portfolioCollateral.ts";
import { RiskManager } from "../../core/riskManager.ts";
import { BookTracker } from "../../core/bookTracker.ts";
import { Quoter, type QuoterConfig } from "../../core/quoter.ts";
import { OrderExecutor } from "../../core/orderExecutor.ts";
import { MarketRuntime } from "../../core/marketRuntime.ts";
import { NonceManager } from "../../core/nonceManager.ts";
import { TxCoordinator } from "../../core/txCoordinator.ts";
import { PortfolioHealthCheck } from "../../core/portfolioHealth.ts";
import { runPortfolioLoop, type RollFn } from "../../core/portfolioRunner.ts";
import { serializeError } from "../../core/errSerializer.ts";
import { sanitiseConfig } from "../../core/config/base.ts";
import { createPerpsVenue } from "../../adapters/perps/index.ts";
import { FuturesVenueAdapter } from "../../adapters/futures/index.ts";
import type { InstrumentAdapter, VenueAdapter, WalletContext } from "../../core/adapter.ts";
import type { NetworkClients } from "../../core/client.ts";
import {
  loadPortfolioConfig,
  type ParsedFuturesVenue,
  type ParsedPerpsVenue,
  type ParsedVenue,
  type PortfolioMakerConfig,
} from "./config.ts";
import { expirySizeScale } from "../../core/sizing/expiryDecay.ts";
import { QUANTITY_SCALE } from "../../core/math.ts";

/** Shared context passed to every market factory. */
interface BuildContext {
  config: PortfolioMakerConfig;
  gas: GasTracker;
  risk: RiskManager;
  logger: pino.Logger;
  historyUrl?: string;
}

function buildOracle(instrument: InstrumentAdapter, ctx: BuildContext): OracleTracker {
  const history = ctx.historyUrl
    ? new HashpriceOracleSubgraphSource({ url: ctx.historyUrl, logger: ctx.logger })
    : undefined;
  return new OracleTracker(instrument, ctx.logger, {
    windowSize: ctx.config.oracle.windowSize,
    precisionBits: ctx.config.oracle.precisionBits,
    historyLookbackMultiplier: ctx.config.oracle.historyLookbackMultiplier,
    history,
    pollIntervalMs: ctx.config.timing.pollIntervalMs,
  });
}

function quoterPricing(venue: ParsedVenue, gasPenaltyBps: number): QuoterConfig["pricing"] {
  if (venue.kind === "perps") {
    const p = (venue as ParsedPerpsVenue).pricing;
    return {
      strategy: "effective-spread",
      minSpreadBps: p.minSpreadBps,
      volatilityMultiplier: p.volatilityMultiplier,
      inventorySkewGamma: p.inventorySkewGamma,
      gasPenaltyBps,
    };
  }
  const p = (venue as ParsedFuturesVenue).pricing;
  return {
    strategy: "reservation-price",
    riskAversion: p.riskAversion,
    marginCallTimeSeconds: p.marginCallTimeSec,
    minSpreadBps: p.minSpreadBps,
    volatilityMultiplier: p.volatilityMultiplier,
    gasPenaltyBps,
  };
}

function quoterSizing(venue: ParsedVenue): QuoterConfig["sizing"] {
  const s = venue.sizing;
  return {
    strategy: "geometric-taper",
    baseQuantity: s.baseQuantity,
    numLevelsPerSide: s.numLevelsPerSide,
    taperRatio: s.taperRatio,
  };
}

/**
 * Apply nearest-first expiry size decay to all futures markets in `markets`.
 * Index 0 keeps full size; index i gets `expirySizeDecay^i`.
 */
function syncFuturesExpirySizeScales(
  markets: MarketRuntime[],
  futuresCfg: ParsedFuturesVenue,
): void {
  const decay = futuresCfg.sizing.expirySizeDecay ?? 0.6;
  const futures = markets
    .filter((m) => m.id.startsWith("futures:"))
    .sort((a, b) => {
      const ea = (a.instrument as { expirationAt?: bigint }).expirationAt ?? 0n;
      const eb = (b.instrument as { expirationAt?: bigint }).expirationAt ?? 0n;
      return ea < eb ? -1 : ea > eb ? 1 : 0;
    });
  for (let i = 0; i < futures.length; i++) {
    futures[i].quoter.setSizeScale(expirySizeScale(i, decay));
  }
}

/** Build a fully-wired (but not-yet-started) market for an instrument. */
function buildMarket(
  instrument: InstrumentAdapter,
  venue: ParsedVenue,
  ctx: BuildContext,
  opts: { expiryIndex?: number } = {},
): MarketRuntime {
  const { config, gas, risk, logger } = ctx;
  const oracle = buildOracle(instrument, ctx);
  const inventory = new InventoryManager(
    instrument,
    { maxPositionSize: venue.maxPositionSize },
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
      pricing: quoterPricing(venue, config.risk.gasPenaltyBps),
      sizing: quoterSizing(venue),
      maxSkewTicks: venue.pricing.maxSkewTicks,
      levelSpacingTicks: config.timing.levelSpacingTicks,
      volHorizonSec: config.timing.pollIntervalMs / 1000,
    },
    oracle,
    gas,
    inventory,
    risk,
    logger,
  );
  if (venue.kind === "futures" && opts.expiryIndex !== undefined) {
    quoter.setSizeScale(
      expirySizeScale(opts.expiryIndex, venue.sizing.expirySizeDecay ?? 0.6),
    );
  }
  const executor = new OrderExecutor(
    instrument,
    {
      requoteCooldownMs: config.timing.requoteCooldownMs,
      urgentRequoteThresholdTicks: config.risk.urgentRequoteThresholdTicks,
      staleBandAllowance: config.timing.staleBandAllowance,
      staleSizeAllowance: config.timing.staleSizeAllowance,
      quantityScale: venue.kind === "futures" ? 1n : QUANTITY_SCALE,
      dryRun: config.dryRun,
    },
    quoter,
    book,
    gas,
    risk,
    oracle,
    logger,
  );
  return new MarketRuntime({
    instrument,
    oracle,
    book,
    inventory,
    quoter,
    executor,
    breaker: config.circuitBreaker,
    logger,
  });
}

async function main(): Promise<void> {
  loadDotenvFiles(import.meta.dirname);
  const config = loadPortfolioConfig();
  const logger = pino({ level: config.logLevel, serializers: { err: serializeError } });
  logger.info(
    { venues: config.venues.map((v) => v.kind), dryRun: config.dryRun },
    "starting portfolio mm",
  );

  const network: NetworkClients = createNetworkClients(config.network.name, config.network.rpcUrl);
  const wallets = new WalletRegistry(config.wallets, network.chain, network.transport);
  const wallet: WalletContext = wallets.get(config.wallet);

  // ── Venues ────────────────────────────────────────────────────────────
  const venueAdapters: VenueAdapter[] = [];
  let futuresVenue: FuturesVenueAdapter | null = null;
  let futuresCfg: ParsedFuturesVenue | null = null;

  for (const v of config.venues) {
    if (v.kind === "perps") {
      venueAdapters.push(
        await createPerpsVenue({
          network,
          wallet,
          address: v.address,
          readBatchSize: config.readBatchSize,
          cancelBatchSize: config.writeBatchSize,
          createBatchSize: config.writeBatchSize,
          logger,
        }),
      );
    } else {
      const fv = new FuturesVenueAdapter({
        network,
        wallet,
        address: v.address,
        readBatchSize: config.readBatchSize,
        writeBatchSize: config.writeBatchSize,
        marketSelection: v.marketSelection,
        logger,
      });
      futuresVenue = fv;
      futuresCfg = v;
      venueAdapters.push(fv);
    }
  }

  // ── Shared portfolio layer ──────────────────────────────────────────────
  const gas = new GasTracker(
    network.publicClient,
    {
      ethPriceFeedAddress:
        config.network.ethPriceFeed === "" ? undefined : config.network.ethPriceFeed,
      gasSpikeThresholdPct: config.risk.gasSpikeThresholdPct,
      gasCapMultiplier: config.gas.gasCapMultiplier,
    },
    logger,
  );
  const collateralAccount = new PortfolioCollateralAccount(
    venueAdapters.map((v) => v.account),
    network.publicClient,
  );
  const collateral = new CollateralTracker(
    collateralAccount,
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
    null,
    collateral,
    gas,
    // RiskManager keeps an oracle ref for future use but never reads it;
    // supply a throwaway so the portfolio (no single price source) type-checks.
    undefined as unknown as OracleTracker,
    logger,
  );

  const ctx: BuildContext = { config, gas, risk, logger, historyUrl: config.oracle.history?.subgraphUrl };

  // ── Build initial market set ────────────────────────────────────────────
  const markets: MarketRuntime[] = [];
  for (let i = 0; i < config.venues.length; i++) {
    const vCfg = config.venues[i];
    const adapter = venueAdapters[i];
    const instruments = await adapter.listInstruments(); // futures: nearest-first
    for (let j = 0; j < instruments.length; j++) {
      markets.push(
        buildMarket(instruments[j], vCfg, ctx, {
          expiryIndex: vCfg.kind === "futures" ? j : undefined,
        }),
      );
    }
  }
  if (futuresCfg) syncFuturesExpirySizeScales(markets, futuresCfg);
  logger.info({ count: markets.length }, "built initial markets");

  // ── Centralized submission ───────────────────────────────────────────────
  const nonce = new NonceManager(
    network.publicClient,
    wallet.walletClient,
    wallet.account,
    network.chain,
    {
      confirmationTimeoutMs: config.txCoordinator.confirmationTimeoutMs,
      maxReplacements: config.txCoordinator.maxReplacements,
      replacementFeeBumpPct: config.txCoordinator.replacementFeeBumpPct,
      maxNonceResyncs: config.txCoordinator.maxNonceResyncs,
    },
    logger,
  );
  const coordinator = new TxCoordinator(
    nonce,
    {},
    logger,
  );

  const health = new PortfolioHealthCheck({
    port: config.health.port,
    appName: "portfolio-mm",
    configSummary: sanitiseConfig(config),
    collateral,
    gas,
    risk,
    logger,
  });
  health.walletAddress = wallet.account.address;

  // ── Roll: reconcile futures expiries against the live venue selection ────
  const onRoll: RollFn | undefined =
    futuresVenue && futuresCfg
      ? async (current) => {
          const { active, added, dropped } = await futuresVenue.resolveMarkets();
          const indexById = new Map(active.map((inst, idx) => [inst.id, idx]));
          // Survivors keep their MarketRuntime; refresh size scales for the new
          // nearest-first ranking before new markets are spliced in.
          const surviving = current.filter((m) => !dropped.some((d) => d.id === m.id));
          for (const m of surviving) {
            const idx = indexById.get(m.id);
            if (idx !== undefined) {
              m.quoter.setSizeScale(
                expirySizeScale(idx, futuresCfg.sizing.expirySizeDecay ?? 0.6),
              );
            }
          }
          return {
            add: added.map((inst) =>
              buildMarket(inst, futuresCfg, ctx, {
                expiryIndex: indexById.get(inst.id) ?? 0,
              }),
            ),
            removeIds: dropped.map((inst) => inst.id),
          };
        }
      : undefined;

  await runPortfolioLoop({
    pollIntervalMs: config.timing.pollIntervalMs,
    rollCheckIntervalMs: config.rollCheckIntervalMs,
    sharedStalenessGraceMs: config.sharedStalenessGraceMs,
    cancelOrdersOnShutdown: config.cancelOrdersOnShutdown,
    dryRun: config.dryRun,
    markets,
    gas,
    collateral,
    risk,
    coordinator,
    health,
    logger,
    onRoll,
  });
}

main();
