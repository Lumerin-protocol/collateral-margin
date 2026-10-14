/**
 * Insurance-fund debt and protocol-backstop monitor, plus order-book liquidity
 * and market-maker funds.
 *
 * One GraphQL query against the vault subgraph, then eth_calls pinned to the
 * subgraph's block: the vault's USDC balance for the backing check, and the
 * venues' backstop views (legs, unrealized PnL, pending funding) for the
 * backstop equity. Every read describes the same block, so indexer lag cannot
 * open a false gap.
 *
 * The market maker's /health/raw (reached inside the VPC through its internal
 * ALB) adds what the chain cannot show: quarantined markets, gas throttle,
 * paused placements, and its own resting orders.
 *
 * On any failure this publishes CheckSuccess=0 and no value metrics. Value
 * alarms treat missing data as ignore and keep their last state.
 *
 * All external reads live in ./gateway.ts; this file only derives metrics.
 */
import type { MetricDatum } from "@aws-sdk/client-cloudwatch";
import {
  type MarketMakerHealth,
  type MarketMakerState,
  readBlockNumber,
  readBlockTimestamp,
  readChainState,
  readMarketMaker,
  readMarketMakerHealth,
  readPointsMeta,
  readVault,
} from "./gateway.ts";
import {
  dim,
  log,
  metric,
  publishFailure,
  push,
  toUnits,
  utilizationPct,
} from "./lib.ts";

// Terraform sets and validates this (var.vault_env); nothing is optional here.
const { CW_NAMESPACE } = process.env as Record<string, string>;
/** Empty where the market maker service is not deployed. */
const MM_HEALTH_URL = process.env.MM_HEALTH_URL ?? "";

export async function handler(): Promise<{ statusCode: number; body: string }> {
  log(`vault monitor ${new Date().toISOString()}`);
  try {
    const { points, summary } = await collect();
    await push(CW_NAMESPACE, points);
    log(`ok ${summary}`);
    return { statusCode: 200, body: "ok" };
  } catch (error) {
    log(`check failed: ${error}`);
    await publishFailure(CW_NAMESPACE);
    return { statusCode: 500, body: String(error) };
  }
}

export async function collect(): Promise<{
  points: MetricDatum[];
  summary: string;
}> {
  const vault = await readVault();
  const { block, decimals } = vault;
  const usdc = (raw: bigint) => toUnits(raw, decimals);

  // Chain reads, all pinned to the subgraph block.
  const at = { blockNumber: BigInt(block) };
  const [
    { usdcRaw, ...backstop },
    timestamp,
    headBlock,
    pointsMeta,
    maker,
    makerHealth,
  ] = await Promise.all([
      readChainState(at, vault.collateralToken),
      // Goldsky leaves _meta.block.timestamp null; the age alarm needs the real one.
      vault.timestamp
        ? Promise.resolve(vault.timestamp)
        : readBlockTimestamp(at),
      readBlockNumber(),
      readPointsMeta().catch((error) => {
        // Best-effort: a points failure must not fail the vault debt check.
        log(`points drift failed: ${error}`);
        return null;
      }),
      // Best-effort for the same reason; MarketCheckSuccess=0 flags it.
      readMarketMaker(at, vault.marginEngine).catch((error) => {
        log(`market maker check failed: ${error?.shortMessage ?? error}`);
        return null;
      }),
      MM_HEALTH_URL
        ? readMarketMakerHealth(MM_HEALTH_URL).catch((error) => {
            log(`market maker health failed: ${error}`);
            return null;
          })
        : undefined,
    ]);
  const head = Number(headBlock);

  // Derived figures.
  const gapRaw = vault.totalSupply - vault.insuranceDebt - usdcRaw;
  // A 1-unit gap must stay above the >0 alarm after float conversion.
  const gap =
    gapRaw > 0n ? Math.max(usdc(gapRaw), 1 / 10 ** decimals) : usdc(gapRaw);
  const age = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  const behind = Math.max(0, head - block);
  // Equity the vault would see if every backstop leg were closed at the mark
  // now. Negative means a loss is forming that BadDebt has not recorded yet.
  const equity =
    vault.backstopBalance + backstop.unrealizedPnl + backstop.pendingFunding;
  const futuresNet = backstop.futuresLegs.reduce(
    (sum, leg) => sum + leg.net,
    0n,
  );

  const points: MetricDatum[] = [
    metric("InsuranceFundBalance", usdc(vault.insuranceFundBalance)),
    metric("InsuranceDebt", usdc(vault.insuranceDebt)),
    metric("InsuranceDebtCap", usdc(vault.insuranceDebtCap)),
    metric(
      "InsuranceDebtUtilizationPct",
      utilizationPct(vault.insuranceDebt, vault.insuranceDebtCap),
    ),
    metric("TimingDebt", usdc(vault.timingDebt)),
    metric("UncoveredLoss", usdc(vault.uncoveredLoss)),
    metric("InsuranceCapital", usdc(vault.insuranceCapital)),
    metric("TraderBadDebtTotal", usdc(vault.traderBadDebtTotal)),
    metric("BackstopBadDebtTotal", usdc(vault.backstopBadDebtTotal)),
    metric("BackstopBalance", usdc(vault.backstopBalance)),
    metric("BackstopUnrealizedPnl", usdc(backstop.unrealizedPnl)),
    metric("BackstopPendingFunding", usdc(backstop.pendingFunding)),
    metric("BackstopEquity", usdc(equity)),
    metric("BackstopUnwindBandBps", vault.backstopUnwindBandBps, "Count"),
    metric("BackstopUnwindFeeBps", vault.backstopUnwindFeeBps, "Count"),
    metric(
      "BackstopOpenLegs",
      backstop.futuresLegs.length + (backstop.perpsNet === 0n ? 0 : 1),
      "Count",
    ),
    // Raw contract units: futures counts whole contracts, perps is 1e6-scaled.
    metric("BackstopFuturesNetQuantity", futuresNet, "Count"),
    metric("BackstopPerpsNetQuantity", backstop.perpsNet, "Count"),
    metric("Halted", vault.halted ? 1 : 0, "Count"),
    metric("FuturesFeeBalance", usdc(vault.futuresFeeBalance)),
    metric("PerpsFeeBalance", usdc(vault.perpsFeeBalance)),
    metric("BackingGap", gap),
    metric("MarginEngineUnset", vault.marginEngineUnset ? 1 : 0, "Count"),
    metric("SubgraphDataAgeSeconds", age, "Seconds"),
    metric("SubgraphIndexingErrors", vault.indexingErrors ? 1 : 0, "Count"),
    metric("CheckSuccess", 1, "Count"),
  ];
  for (const leg of backstop.futuresLegs) {
    points.push(
      metric(
        "BackstopFuturesNetQuantity",
        leg.net,
        "Count",
        dim("ExpirationAt", leg.expirationAt),
      ),
    );
  }
  for (const venue of vault.venues) {
    points.push(
      metric(
        "TraderBadDebtTotal",
        usdc(venue.traderBadDebtTotal),
        "None",
        dim("Venue", venue.id),
      ),
    );
    points.push(
      metric(
        "BackstopBadDebtTotal",
        usdc(venue.backstopBadDebtTotal),
        "None",
        dim("Venue", venue.id),
      ),
    );
  }
  points.push(
    metric("SubgraphBlocksBehind", behind, "Count", dim("Subgraph", "vault")),
  );
  if (pointsMeta) {
    points.push(
      metric(
        "SubgraphBlocksBehind",
        Math.max(0, head - pointsMeta.block),
        "Count",
        dim("Subgraph", "points"),
      ),
      metric(
        "SubgraphIndexingErrors",
        pointsMeta.hasIndexingErrors ? 1 : 0,
        "Count",
        dim("Subgraph", "points"),
      ),
    );
  }

  const book = maker ? marketMakerMetrics(maker, decimals) : null;
  points.push(...(book?.points ?? []));
  points.push(metric("MarketCheckSuccess", book ? 1 : 0, "Count"));

  let healthSummary = "";
  if (makerHealth !== undefined) {
    const health = makerHealth ? healthMetrics(makerHealth) : null;
    points.push(...(health?.points ?? []));
    points.push(metric("MmHealthCheckSuccess", health ? 1 : 0, "Count"));
    healthSummary = ` ${health?.summary ?? "mm_health=failed"}`;
  }

  const summary =
    `block=${block} head=${head} behind=${behind} age=${age}s debt=${vault.insuranceDebt} gap_raw=${gapRaw} ` +
    `halted=${vault.halted} backstop_equity=${equity} ${book?.summary ?? "mm=failed"}${healthSummary}`;
  return { points, summary };
}

/**
 * Book liquidity and market-maker funds. A book with an empty side is what
 * traders see when the market maker stops quoting one way (position cap,
 * utilization gate, halt, or a dead process), so it is measured on-chain
 * rather than trusted from the market maker's own logs.
 */
function marketMakerMetrics(
  maker: MarketMakerState,
  decimals: number,
): { points: MetricDatum[]; summary: string } {
  const usdc = (raw: bigint) => toUnits(raw, decimals);
  const points: MetricDatum[] = [];
  let minSide = Number.POSITIVE_INFINITY;
  let futuresMaxNotional = 0;
  let perpsNotional = 0;
  let maxDrift: number | null = null;

  for (const book of maker.markets) {
    const market = dim("Market", book.market);
    const absNet = book.mmNet < 0n ? -book.mmNet : book.mmNet;
    const notional = usdc((absNet * book.markPrice) / book.quantityScale);
    minSide = Math.min(minSide, book.bids.length, book.asks.length);
    if (book.market === "perps") perpsNotional = notional;
    else futuresMaxNotional = Math.max(futuresMaxNotional, notional);

    points.push(
      metric("BookBidLevels", book.bids.length, "Count", market),
      metric("BookAskLevels", book.asks.length, "Count", market),
      metric("MmPositionNotional", notional, "None", market),
    );
    const [bid, ask] = [book.bids[0], book.asks[0]];
    if (bid !== undefined && ask !== undefined) {
      const mid = Number(bid + ask) / 2;
      // Quotes left resting while the market maker is not requoting keep the
      // book two-sided but walk away from the mark as the oracle moves.
      const mark = Number(book.markPrice);
      const drift = (Math.abs(mid - mark) / mark) * 10_000;
      maxDrift = Math.max(maxDrift ?? 0, drift);
      points.push(
        metric("BookSpreadBps", (Number(ask - bid) / mid) * 10_000, "None", market),
        metric("BookMidDriftBps", drift, "None", market),
      );
    }
  }

  const utilization = utilizationPct(maker.portfolioIM, maker.vaultBalance);
  points.push(
    metric("BookMinSideLevels", minSide, "Count"),
    metric("MmPerpsPositionNotional", perpsNotional),
    metric("MmFuturesMaxPositionNotional", futuresMaxNotional),
    metric("MmVaultBalance", usdc(maker.vaultBalance)),
    metric("MmPortfolioIM", usdc(maker.portfolioIM)),
    metric("MmUtilizationPct", utilization),
    metric("MmEthBalance", toUnits(maker.ethBalance, 18)),
  );
  if (maxDrift !== null) points.push(metric("BookMaxMidDriftBps", maxDrift));

  const summary = `book_min_side=${minSide} mm_util=${utilization.toFixed(1)}% mm_eth=${toUnits(maker.ethBalance, 18)}`;
  return { points, summary };
}

/**
 * The market maker's self-reported state. A market can sit quarantined behind
 * its circuit breaker, or the whole process can be gas-throttled or paused on
 * stale inputs, while its old orders keep the book looking healthy.
 */
function healthMetrics(
  health: MarketMakerHealth,
  now = Date.now(),
): { points: MetricDatum[]; summary: string } {
  const tickAge = health.lastTickAt
    ? Math.max(0, Math.floor((now - health.lastTickAt) / 1000))
    : health.uptimeSeconds;
  const quarantined = health.markets.filter(
    (market) => market.breaker === "quarantined",
  ).length;
  const minOwnOrders = Math.min(
    ...health.markets.map((market) => market.ownOrders),
    // No markets at all quotes nothing.
    ...(health.markets.length ? [] : [0]),
  );

  const points: MetricDatum[] = [
    metric("MmRunning", health.status === "running" ? 1 : 0, "Count"),
    metric("MmTickAgeSeconds", tickAge, "Seconds"),
    metric("MmThrottled", health.throttled ? 1 : 0, "Count"),
    metric("MmQuarantinedMarkets", quarantined, "Count"),
    metric("MmMarketCount", health.markets.length, "Count"),
    metric("MmMinOwnOrders", minOwnOrders, "Count"),
  ];
  if (health.pauseNew !== undefined) {
    points.push(metric("MmPausedNew", health.pauseNew ? 1 : 0, "Count"));
  }
  for (const market of health.markets) {
    points.push(
      metric("MmOwnOrders", market.ownOrders, "Count", dim("Market", market.market)),
    );
  }

  const summary = `mm_status=${health.status} quarantined=${quarantined} min_own_orders=${minOwnOrders} throttled=${health.throttled}`;
  return { points, summary };
}
