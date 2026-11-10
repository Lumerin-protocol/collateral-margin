import { type Address, erc20Abi } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { CollateralVaultAbi } from "collateral-margin-abi/CollateralVault.ts";
import { PortfolioMarginEngineAbi } from "collateral-margin-abi/PortfolioMarginEngine.ts";
import { HashPowerPerpsDEXAbi } from "derivatives-marketplace-abi/HashPowerPerpsDEX.ts";
import { HashPowerFuturesAbi } from "../abi/HashPowerFutures.ts";
import {
  type AccountSnapshot,
  bookFillLoss,
  type MMParams,
  type RestingOrders,
  venueFillLoss,
} from "@hashpower/portfolio-margin";
import { PerpsPositionAbi } from "../venues/perpsPositionAbi.ts";

/**
 * Safety-net re-read interval for the predictor's cached `readMMParams`. A PME
 * `setShocks` is picked up at once from `ShocksUpdated`; this covers a missed log.
 */
export const MM_PARAMS_REFRESH_MS = 600_000;

/** Read the engine-wide constants (shocks only change on PME admin `setShocks`). */
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
 * Optional check of the off-chain fill-loss replica against the venues' own
 * `getRiskView` figures at the snapshot block. A mismatch means the keeper would
 * mis-predict liquidation prices, so it is logged loudly rather than thrown: the
 * on-chain liquidation path still re-checks every account.
 */
export interface FillLossCheck {
  params: MMParams;
  logger: pino.Logger;
}

type RiskView = {
  pendingFunding: bigint;
  buyOrderDelta: bigint;
  sellOrderDelta: bigint;
  buyOrderFillLoss: bigint;
  sellOrderFillLoss: bigint;
};

/**
 * Read everything needed to evaluate `mmSurplus(P)` for a single user as a
 * function of price. Both multicalls are pinned to one block, so positions,
 * orders and (when checked) the venues' reported fill loss describe one state:
 *
 *   1. Bulk multicall: balance, account debt, perps risk/aggregate/position,
 *      futures risk, futures active position expiries, and the tradable delivery window.
 *   2. Per-expiry multicall: hydrate each futures position via `getUserPosition`
 *      + `settlementPrice` + `getMarkRange`, and, when the futures risk view shows
 *      resting order delta, each window expiry's `getOrderAggregateAtExpiration` +
 *      `settlementPrice` + `getMarkRange`; the index (futures `getMarketPrice`) the
 *      marks were read at; and for a perps account its mark and `getPendingDrift`.
 *
 * Round-trip 2 is skipped when the user has no position or order on either venue.
 * The replica moves every mark with the index (`markAt`), so one snapshot still
 * answers at any price.
 *
 * `getRiskView` carries the per-side order delta but reports fill loss only at the
 * current mark, so the per-side quantity and price moments come from the
 * order-aggregate caches (perps `getOrderAggregate`, futures per expiry) and the
 * predictor bounds fill loss at whatever price it is evaluating. Futures books stay
 * per expiry because the venue bounds each expiry at its own price. Pending funding
 * also rides in `getRiskView`, replacing the separate `getPendingFunding` read.
 *
 * `settlePerpsFunding` returns the balance `liquidatePosition` checks: it settles
 * funding first, so a receiver is credited before the OverLiquidation guard
 * (CF-667). A payer's debit is already in `fundingOwed`.
 */
export async function readAccountSnapshot(
  chain: Chain,
  config: Config,
  user: Address,
  check?: FillLossCheck,
  settlePerpsFunding = false,
): Promise<AccountSnapshot> {
  // Uncached: a sweep re-reads right after its own liquidation tx, and viem's cached
  // block number would pin that read to the state before it.
  const blockNumber = await chain.publicClient.getBlockNumber({ cacheTime: 0 });
  const [
    balance,
    accountDebt,
    perpPosition,
    perpRisk,
    perpOrderAggregate,
    futuresRisk,
    activeExpirationAts,
    tradableExpirationAts,
  ] = await chain.publicClient.multicall({
    contracts: [
      {
        address: config.vault.address,
        abi: CollateralVaultAbi,
        functionName: "balanceOf" as const,
        args: [user] as const,
      },
      {
        address: config.vault.address,
        abi: CollateralVaultAbi,
        functionName: "accountDebt" as const,
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
        functionName: "getActiveExpirationDates" as const,
        args: [user] as const,
      },
      {
        address: config.futures.address,
        abi: HashPowerFuturesAbi,
        functionName: "getExpirationDates" as const,
      },
    ] as const,
    allowFailure: false,
    blockNumber,
  });

  const expirationAts = activeExpirationAts as readonly bigint[];
  const perpsHasPosition = perpPosition.netQuantity !== 0n;
  const perpsHasOrders = hasOrderDelta(perpRisk);
  const futuresHasOrders = hasOrderDelta(futuresRisk);
  const orderExpirationAts = futuresHasOrders
    ? (tradableExpirationAts as readonly bigint[])
    : [];
  // Marks follow the index, so they are read with the index they were read at, for the
  // venues the account trades. `getRiskView` already read each of them at this block for
  // such a venue, so the reads cannot revert where the snapshot itself did not.
  const perpsActive = perpsHasPosition || perpsHasOrders;
  const readIndex = perpsActive || expirationAts.length > 0 || futuresHasOrders;

  const futuresPositions: AccountSnapshot["futures"]["positions"] = [];
  const futuresOrders: AccountSnapshot["futures"]["orders"] = [];
  let index: bigint | undefined;
  let perpsMark: bigint | undefined;
  let perpsDrift: bigint | undefined;

  if (readIndex) {
    const positionCount = expirationAts.length;
    const orderCount = orderExpirationAts.length;
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
        ...expirationAts.map((expirationAt) => ({
          address: config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "getMarkRange" as const,
          args: [expirationAt] as const,
        })),
        ...orderExpirationAts.map((expirationAt) => ({
          address: config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "getOrderAggregateAtExpiration" as const,
          args: [user, expirationAt] as const,
        })),
        ...orderExpirationAts.map((expirationAt) => ({
          address: config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "settlementPrice" as const,
          args: [expirationAt] as const,
        })),
        ...orderExpirationAts.map((expirationAt) => ({
          address: config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "getMarkRange" as const,
          args: [expirationAt] as const,
        })),
        {
          address: config.futures.address,
          abi: HashPowerFuturesAbi,
          functionName: "getMarketPrice" as const,
        },
        ...(perpsActive
          ? [
              {
                address: config.perps.address,
                abi: HashPowerPerpsDEXAbi,
                functionName: "getMarketPrice" as const,
              },
            ]
          : []),
        ...(perpsHasPosition
          ? [
              {
                address: config.perps.address,
                abi: HashPowerPerpsDEXAbi,
                functionName: "getPendingDrift" as const,
                args: [user] as const,
              },
            ]
          : []),
      ],
      allowFailure: false,
      blockNumber,
    });

    for (let i = 0; i < positionCount; i++) {
      const pos = perExpiry[i] as
        | { netQuantity: bigint; netEntryValue: bigint }
        | undefined;
      const settlementPrice = perExpiry[positionCount + i] as
        | bigint
        | undefined;
      const range = perExpiry[positionCount * 2 + i] as
        | readonly [bigint, bigint]
        | undefined;
      const expirationAt = expirationAts[i];
      if (pos === undefined || expirationAt === undefined) continue;
      if (pos.netQuantity === 0n) continue;
      futuresPositions.push({
        expirationAt,
        netQuantity: pos.netQuantity,
        netEntryValue: pos.netEntryValue,
        settlementPrice: settlementPrice ?? 0n,
        low: range?.[0],
        high: range?.[1],
      });
    }

    const orderOffset = positionCount * 3;
    for (let i = 0; i < orderCount; i++) {
      const aggregate = perExpiry[orderOffset + i] as RestingOrders | undefined;
      const settlementPrice = perExpiry[orderOffset + orderCount + i] as
        | bigint
        | undefined;
      const range = perExpiry[orderOffset + orderCount * 2 + i] as
        | readonly [bigint, bigint]
        | undefined;
      const expirationAt = orderExpirationAts[i];
      if (aggregate === undefined || expirationAt === undefined) continue;
      if (aggregate.buyQty === 0n && aggregate.sellQty === 0n) continue;
      futuresOrders.push({
        ...moments(aggregate),
        expirationAt,
        settlementPrice: settlementPrice ?? 0n,
        low: range?.[0],
        high: range?.[1],
      });
    }

    let next = orderOffset + orderCount * 3;
    index = perExpiry[next++] as bigint;
    if (perpsActive) perpsMark = perExpiry[next++] as bigint;
    if (perpsHasPosition) perpsDrift = perExpiry[next] as bigint;
  }

  const funding = perpRisk.pendingFunding;
  const snapshot: AccountSnapshot = {
    user,
    balance:
      settlePerpsFunding && funding < 0n
        ? (balance as bigint) - funding
        : (balance as bigint),
    accountDebt: accountDebt as bigint,
    index,
    perp: {
      netQty: perpPosition.netQuantity,
      entryPrice:
        perpPosition.netQuantity === 0n
          ? 0n
          : (abs(perpPosition.netEntryValue) * 1_000_000n) /
            abs(perpPosition.netQuantity),
      orders: moments(perpOrderAggregate),
      // PME uses `max(0, pendingFunding)` — only what the user owes.
      fundingOwed: funding > 0n ? funding : 0n,
      mark: perpsMark,
      pendingDrift: perpsDrift,
    },
    futures: {
      positions: futuresPositions,
      orders: futuresOrders,
    },
  };

  if (check !== undefined && index !== undefined) {
    const perpsScale = 10n ** BigInt(check.params.perpQuantityDecimals);
    if (perpsHasOrders && perpsMark !== undefined) {
      const replica = venueFillLoss(
        snapshot.perp.orders,
        perpsMark,
        perpsScale,
      );
      warnOnFillLossDrift(
        check,
        { user, blockNumber, venue: "perps", mark: perpsMark },
        replica,
        perpRisk,
      );
    }
    if (futuresHasOrders) {
      let replica = 0n;
      for (const book of snapshot.futures.orders) {
        const pinned = book.settlementPrice;
        replica += bookFillLoss(
          book,
          pinned !== 0n ? pinned : (book.low ?? index),
          pinned !== 0n ? pinned : (book.high ?? index),
          1n,
        );
      }
      warnOnFillLossDrift(
        check,
        { user, blockNumber, venue: "futures", mark: index },
        replica,
        futuresRisk,
      );
    }
  }

  return snapshot;
}

function hasOrderDelta(risk: RiskView): boolean {
  return risk.buyOrderDelta !== 0n || risk.sellOrderDelta !== 0n;
}

/** The six moment fields of a venue's `RestingOrderAggregate`. */
function moments(aggregate: RestingOrders): RestingOrders {
  return {
    buyQty: aggregate.buyQty,
    sellQty: aggregate.sellQty,
    buyPQ: aggregate.buyPQ,
    buyP2Q: aggregate.buyP2Q,
    sellPQ: aggregate.sellPQ,
    sellP2Q: aggregate.sellP2Q,
  };
}

function warnOnFillLossDrift(
  check: FillLossCheck,
  context: {
    user: Address;
    blockNumber: bigint;
    venue: "perps" | "futures";
    mark: bigint;
  },
  replica: bigint,
  risk: RiskView,
): void {
  const reported = risk.buyOrderFillLoss + risk.sellOrderFillLoss;
  if (replica === reported) return;
  check.logger.warn(
    { ...context, replica, reported },
    "fill-loss replica disagrees with the venue's getRiskView; liquidation predictions for this account are off",
  );
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
