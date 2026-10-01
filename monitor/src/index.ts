/**
 * Insurance-fund debt and protocol-backstop monitor.
 *
 * One GraphQL query against the vault subgraph, then eth_calls pinned to the
 * subgraph's block: the vault's USDC balance for the backing check, and the
 * venues' backstop views (legs, unrealized PnL, pending funding) for the
 * backstop equity. Every read describes the same block, so indexer lag cannot
 * open a false gap.
 *
 * On any failure this publishes CheckSuccess=0 and no value metrics. Value
 * alarms treat missing data as ignore and keep their last state.
 *
 * All external reads live in ./gateway.ts; this file only derives metrics.
 */
import type { MetricDatum } from "@aws-sdk/client-cloudwatch";
import {
  readBlockNumber,
  readBlockTimestamp,
  readChainState,
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
  const [{ usdcRaw, ...backstop }, timestamp, headBlock, pointsMeta] =
    await Promise.all([
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

  const summary =
    `block=${block} head=${head} behind=${behind} age=${age}s debt=${vault.insuranceDebt} gap_raw=${gapRaw} ` +
    `halted=${vault.halted} backstop_equity=${equity}`;
  return { points, summary };
}
