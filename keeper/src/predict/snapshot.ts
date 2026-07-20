import type { Address } from "viem";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { CollateralVaultAbi } from "collateral-margin-abi/CollateralVault.ts";
import { PortfolioMarginEngineAbi } from "collateral-margin-abi/PortfolioMarginEngine.ts";
import { HashPowerPerpsDEXAbi } from "derivatives-marketplace-abi/HashPowerPerpsDEX.ts";
import { FuturesAbi } from "futures-marketplace-abi/Futures.ts";
import type { AccountSnapshot, MMParams } from "./types.ts";

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
        address: config.perps.address,
        abi: HashPowerPerpsDEXAbi,
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
 *   1. Bulk multicall: balance, perp position/orderMargin/funding,
 *      futures orderMargin/activeDeliveryDates.
 *   2. Per-expiry multicall: hydrate each aggregate via `getUserPosition`.
 *
 * Round-trip 2 collapses to zero calls when the user has no futures
 * positions (the common case for perps-only users).
 */
export async function readAccountSnapshot(
  chain: Chain,
  config: Config,
  user: Address,
): Promise<AccountSnapshot> {
  const [
    balance,
    perpPosition,
    perpOrderMargin,
    perpFunding,
    futuresOrderMargin,
    activeDeliveryDates,
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
        abi: HashPowerPerpsDEXAbi,
        functionName: "getUserPosition" as const,
        args: [user] as const,
      },
      {
        address: config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getOrderMargin" as const,
        args: [user] as const,
      },
      {
        address: config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getPendingFunding" as const,
        args: [user] as const,
      },
      {
        address: config.futures.address,
        abi: FuturesAbi,
        functionName: "getFuturesOrderMargin" as const,
        args: [user] as const,
      },
      {
        address: config.futures.address,
        abi: FuturesAbi,
        functionName: "getActiveDeliveryDates" as const,
        args: [user] as const,
      },
    ] as const,
    allowFailure: false,
  });

  const deliveryAts = activeDeliveryDates as readonly bigint[];
  const futuresPositions: AccountSnapshot["futures"]["positions"] = [];
  if (deliveryAts.length > 0) {
    const positions = await chain.publicClient.multicall({
      contracts: deliveryAts.map((deliveryAt) => ({
        address: config.futures.address,
        abi: FuturesAbi,
        functionName: "getUserPosition" as const,
        args: [user, deliveryAt] as const,
      })),
      allowFailure: false,
    });
    for (let i = 0; i < deliveryAts.length; i++) {
      const pos = positions[i];
      const deliveryAt = deliveryAts[i];
      if (pos === undefined || deliveryAt === undefined) continue;
      if (pos.netQuantity === 0n) continue;
      futuresPositions.push({
        deliveryAt,
        netQuantity: pos.netQuantity,
        netEntryValue: pos.netEntryValue,
      });
    }
  }

  const funding = perpFunding as bigint;
  return {
    user,
    balance: balance as bigint,
    perp: {
      netQty: perpPosition.netQuantity,
      entryPrice: perpPosition.aggregatedEntryPrice,
      orderMargin: perpOrderMargin as bigint,
      // PME uses `max(0, pendingFunding)` — only what the user owes.
      fundingOwed: funding > 0n ? funding : 0n,
    },
    futures: {
      positions: futuresPositions,
      orderMargin: futuresOrderMargin as bigint,
    },
  };
}
