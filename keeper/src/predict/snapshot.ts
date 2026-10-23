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
  type MMParams,
  type RestingOrders,
  venueFillLoss,
} from "@hashpower/portfolio-margin";
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
 *   1. Bulk multicall: balance, perps risk/aggregate/position, futures risk,
 *      futures active position expiries, and the tradable delivery window.
 *   2. Per-expiry multicall: hydrate each futures position via `getUserPosition`
 *      + `settlementPrice`, and, when the futures risk view shows resting order
 *      delta, each window expiry's `getOrderAggregateAtExpiration` +
 *      `settlementPrice`. With a `check`, the mark of every venue with orders.
 *
 * Round-trip 2 is skipped when the user has no futures positions or orders and no
 * check needs a mark.
 *
 * `getRiskView` carries the per-side order delta but reports fill loss only at the
 * current mark, so the per-side quantity and price moments come from the
 * order-aggregate caches (perps `getOrderAggregate`, futures per expiry) and the
 * predictor bounds fill loss at whatever price it is evaluating. Futures books stay
 * per expiry because the venue bounds each expiry at its own price. Pending funding
 * also rides in `getRiskView`, replacing the separate `getPendingFunding` read.
 */
export async function readAccountSnapshot(
  chain: Chain,
  config: Config,
  user: Address,
  check?: FillLossCheck,
): Promise<AccountSnapshot> {
  // Uncached: a sweep re-reads right after its own liquidation tx, and viem's cached
  // block number would pin that read to the state before it.
  const blockNumber = await chain.publicClient.getBlockNumber({ cacheTime: 0 });
  const [
    balance,
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
  const perpsHasOrders = hasOrderDelta(perpRisk);
  const futuresHasOrders = hasOrderDelta(futuresRisk);
  const orderExpirationAts = futuresHasOrders ? (tradableExpirationAts as readonly bigint[]) : [];
  // `getRiskView` already read each of these marks at this block for a venue with
  // orders, so the reads cannot revert where the snapshot itself did not.
  const readPerpsMark = check !== undefined && perpsHasOrders;
  const readFuturesMark = check !== undefined && futuresHasOrders;

  const futuresPositions: AccountSnapshot["futures"]["positions"] = [];
  const futuresOrders: AccountSnapshot["futures"]["orders"] = [];
  let perpsMark: bigint | undefined;
  let futuresMark: bigint | undefined;

  if (expirationAts.length > 0 || orderExpirationAts.length > 0 || readPerpsMark || readFuturesMark) {
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
        ...(readPerpsMark
          ? [
              {
                address: config.perps.address,
                abi: HashPowerPerpsDEXAbi,
                functionName: "getMarketPrice" as const,
              },
            ]
          : []),
        ...(readFuturesMark
          ? [
              {
                address: config.futures.address,
                abi: HashPowerFuturesAbi,
                functionName: "getMarketPrice" as const,
              },
            ]
          : []),
      ],
      allowFailure: false,
      blockNumber,
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

    const orderOffset = expirationAts.length * 2;
    const orderCount = orderExpirationAts.length;
    for (let i = 0; i < orderCount; i++) {
      const aggregate = perExpiry[orderOffset + i] as RestingOrders | undefined;
      const settlementPrice = perExpiry[orderOffset + orderCount + i] as bigint | undefined;
      const expirationAt = orderExpirationAts[i];
      if (aggregate === undefined || expirationAt === undefined) continue;
      if (aggregate.buyQty === 0n && aggregate.sellQty === 0n) continue;
      futuresOrders.push({
        ...moments(aggregate),
        expirationAt,
        settlementPrice: settlementPrice ?? 0n,
      });
    }

    let markIndex = orderOffset + orderCount * 2;
    if (readPerpsMark) perpsMark = perExpiry[markIndex++] as bigint;
    if (readFuturesMark) futuresMark = perExpiry[markIndex] as bigint;
  }

  const funding = perpRisk.pendingFunding;
  const snapshot: AccountSnapshot = {
    user,
    balance: balance as bigint,
    perp: {
      netQty: perpPosition.netQuantity,
      entryPrice:
        perpPosition.netQuantity === 0n
          ? 0n
          : (abs(perpPosition.netEntryValue) * 1_000_000n) / abs(perpPosition.netQuantity),
      orders: moments(perpOrderAggregate),
      // PME uses `max(0, pendingFunding)` — only what the user owes.
      fundingOwed: funding > 0n ? funding : 0n,
    },
    futures: {
      positions: futuresPositions,
      orders: futuresOrders,
    },
  };

  if (check !== undefined) {
    const perpsScale = 10n ** BigInt(check.params.perpQuantityDecimals);
    if (perpsMark !== undefined) {
      const replica = venueFillLoss(snapshot.perp.orders, perpsMark, perpsScale);
      warnOnFillLossDrift(check, { user, blockNumber, venue: "perps", mark: perpsMark }, replica, perpRisk);
    }
    if (futuresMark !== undefined) {
      let replica = 0n;
      for (const book of snapshot.futures.orders) {
        replica += venueFillLoss(book, book.settlementPrice !== 0n ? book.settlementPrice : futuresMark, 1n);
      }
      warnOnFillLossDrift(check, { user, blockNumber, venue: "futures", mark: futuresMark }, replica, futuresRisk);
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
  context: { user: Address; blockNumber: bigint; venue: "perps" | "futures"; mark: bigint },
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
