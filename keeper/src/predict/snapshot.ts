import { type Address, erc20Abi } from "viem";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { CollateralVaultAbi } from "collateral-margin-abi/CollateralVault.ts";
import { PortfolioMarginEngineAbi } from "collateral-margin-abi/PortfolioMarginEngine.ts";
import { HashPowerPerpsDEXAbi } from "derivatives-marketplace-abi/HashPowerPerpsDEX.ts";
import { HashPowerFuturesAbi } from "../abi/HashPowerFutures.ts";
import type { AccountSnapshot, MMParams } from "@hashpower/portfolio-margin";
import { PerpsPositionAbi } from "../venues/perpsPositionAbi.ts";

/**
 * Read the engine-wide constants once. They only change on PME admin
 * transactions (`setShocks`), so the predictor caches them for the lifetime
 * of the process — there's no periodic re-read; an admin `setShocks` requires
 * a keeper restart to pick up.
 */
export async function readMMParams(
  chain: Chain,
  config: Config,
): Promise<MMParams> {
  // Token decimals come from the vault's collateral token — the venues no
  // longer expose `decimals()` (the PME caches it from the same source).
  const collateralToken = await chain.publicClient.readContract({
    address: config.vault.address,
    abi: CollateralVaultAbi,
    functionName: "collateralToken",
  });

  const reads = await chain.publicClient.multicall({
    contracts: [
      {
        address: config.pme.address,
        abi: PortfolioMarginEngineAbi,
        functionName: "imSpotShock" as const,
      },
      {
        address: config.pme.address,
        abi: PortfolioMarginEngineAbi,
        functionName: "mmSpotShock" as const,
      },
      {
        address: collateralToken,
        abi: erc20Abi,
        functionName: "decimals" as const,
      },
      {
        address: config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "QUANTITY_DECIMALS" as const,
      },
    ],
    allowFailure: false,
  });

  return {
    imSpotShock: reads[0] as bigint,
    mmSpotShock: reads[1] as bigint,
    tokenDecimals: reads[2] as number,
    perpQuantityDecimals: reads[3] as number,
  };
}

/**
 * Read everything needed to evaluate `mmSurplus(P)` for a single user as a
 * function of price. Two RPC round-trips:
 *
 *   1. Bulk multicall: balance, both venues' `getRiskView` / `getOrderAggregate`,
 *      the perp position, futures activeExpirationAts.
 *   2. Per-expiry multicall: hydrate each aggregate via `getUserPosition`, plus
 *      its `settlementPrice` — an expiry that has settled but not yet been swept
 *      out of the active set is marked at that pinned price and carries no delta,
 *      so the predictor cannot treat it like a live leg.
 *
 * Round-trip 2 collapses to zero calls when the user has no futures
 * positions (the common case for perps-only users).
 *
 * `getRiskView` carries the per-side order delta but reports fill loss only at the
 * current mark, and the clamp makes that non-invertible once it reads zero — so the
 * per-side limit-price totals come from `getOrderAggregate` and the predictor derives
 * fill loss at whatever price it is evaluating. Pending funding also rides in
 * `getRiskView`, replacing the separate `getPendingFunding` read.
 */
export async function readAccountSnapshot(
  chain: Chain,
  config: Config,
  user: Address,
): Promise<AccountSnapshot> {
  const [
    balance,
    perpPosition,
    perpRisk,
    perpOrderAggregate,
    futuresRisk,
    futuresOrderAggregate,
    activeExpirationAts,
  ] = await chain.publicClient.multicall({
    contracts: [
      {
        address: config.vault.address,
        abi: CollateralVaultAbi,
        functionName: "balanceOf" as const,
        args: [user] as const,
      },
      {
        address: config.perps.address,
        abi: PerpsPositionAbi,
        functionName: "getUserPosition" as const,
        args: [user] as const,
      },
      {
        address: config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getRiskView" as const,
        args: [user] as const,
      },
      {
        address: config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getOrderAggregate" as const,
        args: [user] as const,
      },
      {
        address: config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getRiskView" as const,
        args: [user] as const,
      },
      {
        address: config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getOrderAggregate" as const,
        args: [user] as const,
      },
      {
        address: config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getActiveExpirationDates" as const,
        args: [user] as const,
      },
    ] as const,
    allowFailure: false,
  });

  const expirationAts = activeExpirationAts as readonly bigint[];
  const futuresPositions: AccountSnapshot["futures"]["positions"] = [];
  if (expirationAts.length > 0) {
    const perExpiry = await chain.publicClient.multicall({
      contracts: [
        ...expirationAts.map((expirationAt) => ({
          address: config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "getUserPosition" as const,
          args: [user, expirationAt] as const,
        })),
        ...expirationAts.map((expirationAt) => ({
          address: config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "settlementPrice" as const,
          args: [expirationAt] as const,
        })),
      ],
      allowFailure: false,
    });
    for (let i = 0; i < expirationAts.length; i++) {
      const pos = perExpiry[i] as { netQuantity: bigint; netEntryValue: bigint } | undefined;
      const settlementPrice = perExpiry[expirationAts.length + i] as bigint | undefined;
      const expirationAt = expirationAts[i];
      if (pos === undefined || expirationAt === undefined) continue;
      if (pos.netQuantity === 0n) continue;
      futuresPositions.push({
        expirationAt,
        netQuantity: pos.netQuantity,
        netEntryValue: pos.netEntryValue,
        settlementPrice: settlementPrice ?? 0n,
      });
    }
  }

  const funding = perpRisk.pendingFunding;
  return {
    user,
    balance: balance as bigint,
    perp: {
      netQty: perpPosition.netQuantity,
      entryPrice:
        perpPosition.netQuantity === 0n
          ? 0n
          : (abs(perpPosition.netEntryValue) * 1_000_000n) / abs(perpPosition.netQuantity),
      orders: restingOrders(perpRisk, perpOrderAggregate),
      // PME uses `max(0, pendingFunding)` — only what the user owes.
      fundingOwed: funding > 0n ? funding : 0n,
    },
    futures: {
      positions: futuresPositions,
      orders: restingOrders(futuresRisk, futuresOrderAggregate),
    },
  };
}

/** Pair a venue's risk deltas with its cached order aggregate. */
function restingOrders(
  risk: { buyOrderDelta: bigint; sellOrderDelta: bigint },
  aggregate: { buyValue: bigint; sellValue: bigint },
): AccountSnapshot["perp"]["orders"] {
  return {
    buyDelta: risk.buyOrderDelta,
    sellDelta: risk.sellOrderDelta,
    buyValue: aggregate.buyValue,
    sellValue: aggregate.sellValue,
  };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
