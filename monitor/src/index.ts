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
 */
import type { MetricDatum } from "@aws-sdk/client-cloudwatch";
import { type Address, createPublicClient, erc20Abi, http, parseAbi } from "viem";
import { dim, gql, isUnset, log, metric, publishFailure, push, toUnits, utilizationPct } from "./lib.ts";

// Terraform sets and validates all of these (var.vault_env); nothing is optional here.
const { SUBGRAPH_URL, POINTS_SUBGRAPH_URL, ETH_RPC_URL, CW_NAMESPACE } = process.env as Record<string, string>;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS?.toLowerCase() as Address;
const FUTURES_ADDRESS = process.env.FUTURES_ADDRESS?.toLowerCase() as Address;
const PERPS_ADDRESS = process.env.PERPS_ADDRESS?.toLowerCase() as Address;

/** CollateralVault.BACKSTOP_ADDR: keyless ledger that inherits liquidated positions. */
const BACKSTOP: Address = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

const chain = createPublicClient({ transport: http(ETH_RPC_URL, { timeout: 30_000 }) });

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

export async function collect(): Promise<{ points: MetricDatum[]; summary: string }> {
  const vault = await readVault();
  const { block, decimals } = vault;
  const usdc = (raw: bigint) => toUnits(raw, decimals);

  // Chain reads, all pinned to the subgraph block.
  const at = { blockNumber: BigInt(block) };
  const usdcRaw = await chain.readContract({ ...at, address: vault.collateralToken, abi: erc20Abi, functionName: "balanceOf", args: [VAULT_ADDRESS] });
  // Goldsky leaves _meta.block.timestamp null; the age alarm needs the real one.
  const timestamp = vault.timestamp ?? Number((await chain.getBlock(at)).timestamp);
  const head = Number(await chain.getBlockNumber());
  const backstop = await readBackstop(at);

  // Derived figures.
  const gapRaw = vault.totalSupply - vault.insuranceDebt - usdcRaw;
  // A 1-unit gap must stay above the >0 alarm after float conversion.
  const gap = gapRaw > 0n ? Math.max(usdc(gapRaw), 1 / 10 ** decimals) : usdc(gapRaw);
  const age = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  const behind = Math.max(0, head - block);
  // Equity the vault would see if every backstop leg were closed at the mark
  // now. Negative means a loss is forming that BadDebt has not recorded yet.
  const equity = vault.backstopBalance + backstop.unrealizedPnl + backstop.pendingFunding;
  const futuresNet = backstop.futuresLegs.reduce((sum, leg) => sum + leg.net, 0n);

  const points: MetricDatum[] = [
    metric("InsuranceFundBalance", usdc(vault.insuranceFundBalance)),
    metric("InsuranceDebt", usdc(vault.insuranceDebt)),
    metric("InsuranceDebtCap", usdc(vault.insuranceDebtCap)),
    metric("InsuranceDebtUtilizationPct", utilizationPct(vault.insuranceDebt, vault.insuranceDebtCap)),
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
    metric("BackstopOpenLegs", backstop.futuresLegs.length + (backstop.perpsNet === 0n ? 0 : 1), "Count"),
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
    points.push(metric("BackstopFuturesNetQuantity", leg.net, "Count", dim("ExpirationAt", leg.expirationAt)));
  }
  for (const venue of vault.venues) {
    points.push(metric("TraderBadDebtTotal", usdc(venue.traderBadDebtTotal), "None", dim("Venue", venue.id)));
    points.push(metric("BackstopBadDebtTotal", usdc(venue.backstopBadDebtTotal), "None", dim("Venue", venue.id)));
  }
  points.push(metric("SubgraphBlocksBehind", behind, "Count", dim("Subgraph", "vault")));
  points.push(...(await pointsDrift(head)));

  const summary =
    `block=${block} head=${head} behind=${behind} age=${age}s debt=${vault.insuranceDebt} gap_raw=${gapRaw} ` +
    `halted=${vault.halted} backstop_equity=${equity}`;
  return { points, summary };
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** Vault state at the subgraph head, plus the venues' fee balances held in the vault. Raw token units. */
async function readVault() {
  const { _meta, vault, vaultVenues, futuresUser, perpsUser } = await gql(
    SUBGRAPH_URL,
    `query VaultDebt($futures: Bytes!, $perps: Bytes!) {
      _meta { block { number timestamp } hasIndexingErrors }
      vault(id: "0") {
        insuranceFundBalance insuranceDebt insuranceDebtCap timingDebt uncoveredLoss insuranceCapital
        traderBadDebtTotal backstopBalance backstopBadDebtTotal backstopUnwindBandBps backstopUnwindFeeBps
        totalSupply halted marginEngine decimals collateralToken
      }
      vaultVenues(first: 100) { id traderBadDebtTotal backstopBadDebtTotal }
      futuresUser: vaultUser(id: $futures) { balance }
      perpsUser: vaultUser(id: $perps) { balance }
    }`,
    { futures: FUTURES_ADDRESS, perps: PERPS_ADDRESS },
  );
  const big = (raw: string | null | undefined) => BigInt(raw ?? 0);
  return {
    block: Number(_meta.block.number),
    timestamp: _meta.block.timestamp === null ? null : Number(_meta.block.timestamp),
    indexingErrors: Boolean(_meta.hasIndexingErrors),
    decimals: Number(vault.decimals ?? 6),
    collateralToken: vault.collateralToken as Address,
    marginEngineUnset: isUnset(vault.marginEngine),
    halted: Boolean(vault.halted),
    totalSupply: big(vault.totalSupply),
    insuranceFundBalance: big(vault.insuranceFundBalance),
    insuranceDebt: big(vault.insuranceDebt),
    insuranceDebtCap: big(vault.insuranceDebtCap),
    timingDebt: big(vault.timingDebt),
    uncoveredLoss: big(vault.uncoveredLoss),
    insuranceCapital: big(vault.insuranceCapital),
    traderBadDebtTotal: big(vault.traderBadDebtTotal),
    backstopBalance: big(vault.backstopBalance),
    backstopBadDebtTotal: big(vault.backstopBadDebtTotal),
    backstopUnwindBandBps: Number(vault.backstopUnwindBandBps ?? 0),
    backstopUnwindFeeBps: Number(vault.backstopUnwindFeeBps ?? 0),
    futuresFeeBalance: big(futuresUser?.balance),
    perpsFeeBalance: big(perpsUser?.balance),
    venues: (vaultVenues as { id: string; traderBadDebtTotal: string; backstopBadDebtTotal: string }[]).map((venue) => ({
      id: venue.id,
      traderBadDebtTotal: big(venue.traderBadDebtTotal),
      backstopBadDebtTotal: big(venue.backstopBadDebtTotal),
    })),
  };
}

/** Unrealized PnL, pending funding and open legs of the backstop across both venues, raw units. */
async function readBackstop(at: { blockNumber: bigint }) {
  const abi = parseAbi([
    "struct RiskView { int256 netPositionDelta; int256 unrealizedPnl; int256 pendingFunding; uint256 buyOrderDelta; uint256 sellOrderDelta; uint256 buyOrderFillLoss; uint256 sellOrderFillLoss; }",
    "struct Position { int256 netQuantity; int256 netEntryValue; }",
    "function getRiskView(address user) view returns (RiskView)",
    "function getActiveExpirationDates(address user) view returns (uint256[])",
    "function getUserPosition(address user, uint256 expirationAt) view returns (Position)",
    "function getUserPosition(address user) view returns (Position)",
  ]);
  const futures = { ...at, abi, address: FUTURES_ADDRESS };
  const perps = { ...at, abi, address: PERPS_ADDRESS };

  const futuresRisk = await chain.readContract({ ...futures, functionName: "getRiskView", args: [BACKSTOP] });
  const expiries = await chain.readContract({ ...futures, functionName: "getActiveExpirationDates", args: [BACKSTOP] });
  const futuresLegs: { expirationAt: bigint; net: bigint }[] = [];
  for (const expirationAt of expiries) {
    const position = await chain.readContract({ ...futures, functionName: "getUserPosition", args: [BACKSTOP, expirationAt] });
    if (position.netQuantity !== 0n) futuresLegs.push({ expirationAt, net: position.netQuantity });
  }

  const perpsRisk = await chain.readContract({ ...perps, functionName: "getRiskView", args: [BACKSTOP] });
  const perpsPosition = await chain.readContract({ ...perps, functionName: "getUserPosition", args: [BACKSTOP] });

  return {
    unrealizedPnl: futuresRisk.unrealizedPnl + perpsRisk.unrealizedPnl,
    pendingFunding: perpsRisk.pendingFunding,
    futuresLegs,
    perpsNet: perpsPosition.netQuantity,
  };
}

/** Points-subgraph lag, best-effort: a points failure must not fail the vault debt check. */
async function pointsDrift(head: number): Promise<MetricDatum[]> {
  try {
    const { _meta } = await gql(POINTS_SUBGRAPH_URL, `{ _meta { block { number } hasIndexingErrors } }`);
    return [
      metric("SubgraphBlocksBehind", Math.max(0, head - Number(_meta.block.number)), "Count", dim("Subgraph", "points")),
      metric("SubgraphIndexingErrors", _meta.hasIndexingErrors ? 1 : 0, "Count", dim("Subgraph", "points")),
    ];
  } catch (error) {
    log(`points drift failed: ${error}`);
    return [];
  }
}
