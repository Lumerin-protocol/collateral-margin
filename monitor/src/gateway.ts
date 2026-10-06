/**
 * External reads for the vault monitor: the vault and points subgraphs, and the
 * chain. Everything here returns raw, un-scaled data — no metric names, units,
 * or layout decisions. That keeps the one place that talks to the outside
 * world isolated from the math in index.ts.
 */
import {
  type Address,
  createPublicClient,
  erc20Abi,
  http,
  parseAbi,
} from "viem";
import { gql, isUnset } from "./lib.ts";

// Terraform sets and validates these (var.vault_env); nothing is optional here.
const { VAULT_SUBGRAPH_URL, POINTS_SUBGRAPH_URL } = process.env as Record<
  string,
  string
>;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS?.toLowerCase() as Address;
const FUTURES_ADDRESS = process.env.FUTURES_ADDRESS?.toLowerCase() as Address;
const PERPS_ADDRESS = process.env.PERPS_ADDRESS?.toLowerCase() as Address;

/** CollateralVault.BACKSTOP_ADDR: keyless ledger that inherits liquidated positions. */
const BACKSTOP: Address = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";

/** Alchemy's subdomain per network; base mainnet is not just the network name. */
const ALCHEMY_SUBDOMAIN: Record<string, string> = {
  "base-sepolia": "base-sepolia",
  base: "base-mainnet",
};

/**
 * The Lambda is handed a finished ETH_RPC_URL by Terraform; a local run has the
 * Alchemy key and NETWORK instead, so compose the URL the same way the keeper
 * does. An explicit ETH_RPC_URL always wins.
 */
function resolveRpcUrl(): string {
  const explicit = process.env.ETH_RPC_URL;
  if (explicit) return explicit;

  const apiKey = process.env.ALCHEMY_API_KEY;
  const subdomain = ALCHEMY_SUBDOMAIN[process.env.NETWORK ?? ""];
  if (!apiKey || !subdomain) {
    throw new Error("set ETH_RPC_URL, or both ALCHEMY_API_KEY and NETWORK");
  }
  return `https://${subdomain}.g.alchemy.com/v2/${apiKey}`;
}

const chain = createPublicClient({
  transport: http(resolveRpcUrl(), { timeout: 30_000 }),
});

/** Vault state at the subgraph head, plus the venues' fee balances held in the vault. Raw token units. */
export interface VaultState {
  block: number;
  timestamp: number | null;
  indexingErrors: boolean;
  decimals: number;
  collateralToken: Address;
  marginEngineUnset: boolean;
  halted: boolean;
  totalSupply: bigint;
  insuranceFundBalance: bigint;
  insuranceDebt: bigint;
  insuranceDebtCap: bigint;
  timingDebt: bigint;
  uncoveredLoss: bigint;
  insuranceCapital: bigint;
  traderBadDebtTotal: bigint;
  backstopBalance: bigint;
  backstopBadDebtTotal: bigint;
  backstopUnwindBandBps: number;
  backstopUnwindFeeBps: number;
  futuresFeeBalance: bigint;
  perpsFeeBalance: bigint;
  venues: {
    id: string;
    traderBadDebtTotal: bigint;
    backstopBadDebtTotal: bigint;
  }[];
}

export async function readVault(): Promise<VaultState> {
  const { _meta, vault, vaultVenues, futuresUser, perpsUser } = await gql(
    VAULT_SUBGRAPH_URL,
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
    timestamp:
      _meta.block.timestamp === null ? null : Number(_meta.block.timestamp),
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
    venues: (
      vaultVenues as {
        id: string;
        traderBadDebtTotal: string;
        backstopBadDebtTotal: string;
      }[]
    ).map((venue) => ({
      id: venue.id,
      traderBadDebtTotal: big(venue.traderBadDebtTotal),
      backstopBadDebtTotal: big(venue.backstopBadDebtTotal),
    })),
  };
}

/** Vault balance and backstop state across both venues, read in two multicalls. Raw units. */
export interface ChainState {
  usdcRaw: bigint;
  unrealizedPnl: bigint;
  pendingFunding: bigint;
  futuresLegs: { expirationAt: bigint; net: bigint }[];
  perpsNet: bigint;
}

export async function readChainState(
  at: { blockNumber: bigint },
  collateralToken: Address,
): Promise<ChainState> {
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

  const [usdcRaw, futuresRisk, expiries, perpsRisk, perpsPosition] =
    await chain.multicall({
      ...at,
      multicallAddress: MULTICALL3,
      allowFailure: false,
      contracts: [
        {
          address: collateralToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [VAULT_ADDRESS],
        },
        {
          ...futures,
          functionName: "getRiskView",
          args: [BACKSTOP],
        },
        {
          ...futures,
          functionName: "getActiveExpirationDates",
          args: [BACKSTOP],
        },
        {
          ...perps,
          functionName: "getRiskView",
          args: [BACKSTOP],
        },
        {
          ...perps,
          functionName: "getUserPosition",
          args: [BACKSTOP],
        },
      ],
    });

  const positions = (await chain.multicall({
    ...at,
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: expiries.map((expirationAt) => ({
      ...futures,
      functionName: "getUserPosition",
      args: [BACKSTOP, expirationAt],
    })),
  })) as { netQuantity: bigint; netEntryValue: bigint }[];
  const futuresLegs = expiries.flatMap((expirationAt, index) => {
    const net = positions[index].netQuantity;
    return net === 0n ? [] : [{ expirationAt, net }];
  });

  return {
    usdcRaw,
    unrealizedPnl: futuresRisk.unrealizedPnl + perpsRisk.unrealizedPnl,
    pendingFunding: perpsRisk.pendingFunding,
    futuresLegs,
    perpsNet: perpsPosition.netQuantity,
  };
}

/** Block timestamp at a pinned height, for when the subgraph omits its own. */
export async function readBlockTimestamp(at: { blockNumber: bigint }) {
  const block = await chain.getBlock(at);
  return Number(block.timestamp);
}

export function readBlockNumber() {
  return chain.getBlockNumber();
}

/** Points-subgraph head, so the caller can measure its lag against the chain. */
export async function readPointsMeta(): Promise<{
  block: number;
  hasIndexingErrors: boolean;
}> {
  const { _meta } = await gql(
    POINTS_SUBGRAPH_URL,
    `{ _meta { block { number } hasIndexingErrors } }`,
  );
  return {
    block: Number(_meta.block.number),
    hasIndexingErrors: Boolean(_meta.hasIndexingErrors),
  };
}
