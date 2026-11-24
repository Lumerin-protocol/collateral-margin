/**
 * Bitcoin difficulty retarget projection and the accounts its index step would hit (N62).
 *
 * HashpriceBTC applies a retarget in one block, so the index steps by the whole
 * adjustment: hashprice is reward over difficulty, and moves by 1 / (1 + change) - 1.
 */

/** Blocks per difficulty epoch. */
export const EPOCH_BLOCKS = 2016;
/** Bitcoin's target timespan: 2,016 blocks at 600 s, measured over the epoch's 2,015 intervals. */
const TARGET_TIMESPAN = EPOCH_BLOCKS * 600;
/** Bitcoin bounds one adjustment to a factor of four either way. */
const MAX_FACTOR = 4;

export interface EpochTip {
  height: number;
  time: number;
  /** Header time of the epoch's first block, `height - height % 2016`. */
  epochStartTime: number;
}

/** Fractions, not percent. */
export interface RetargetProjection {
  blocksLeft: number;
  difficultyChange: number;
  indexStep: number;
}

/** Null on the epoch's first block, which has no interval to average. */
export function projectRetarget({ height, time, epochStartTime }: EpochTip): RetargetProjection | null {
  const mined = height % EPOCH_BLOCKS;
  if (mined === 0) return null;
  const timespan = ((time - epochStartTime) / mined) * (EPOCH_BLOCKS - 1);
  const bounded = Math.min(Math.max(timespan, TARGET_TIMESPAN / MAX_FACTOR), TARGET_TIMESPAN * MAX_FACTOR);
  return {
    blocksLeft: EPOCH_BLOCKS - mined,
    difficultyChange: TARGET_TIMESPAN / bounded - 1,
    indexStep: bounded / TARGET_TIMESPAN - 1,
  };
}

/** USDC units. Exposures are signed (net) or per side (orders), at each market's mark. */
export interface AccountExposure {
  balance: number;
  maintenance: number;
  netExposure: number;
  buyOrderExposure: number;
  sellOrderExposure: number;
  unrealizedPnl: number;
  fundingOwed: number;
}

/**
 * Accounts whose cushion above maintenance is smaller than the step's loss, and the
 * equity that would go negative once the backstop unwinds them. Resting orders on the
 * losing side count as filled at the old price, as the margin engine's worst leg does:
 * a taker fills stale quotes into the step.
 */
export function retargetRisk(
  accounts: readonly AccountExposure[],
  indexStep: number,
  unwindBps: number,
): { atRisk: number; potentialBadDebt: number } {
  let atRisk = 0;
  let potentialBadDebt = 0;
  for (const account of accounts) {
    const exposure =
      indexStep < 0
        ? Math.max(0, account.netExposure + account.buyOrderExposure)
        : Math.max(0, account.sellOrderExposure - account.netExposure);
    if (exposure === 0) continue;
    const loss = exposure * Math.abs(indexStep);
    if (loss > account.balance - account.maintenance) atRisk++;
    const unwindCost = exposure * (1 + indexStep) * (unwindBps / 10_000);
    const equityAfter = account.balance + account.unrealizedPnl - account.fundingOwed - loss - unwindCost;
    if (equityAfter < 0) potentialBadDebt -= equityAfter;
  }
  return { atRisk, potentialBadDebt };
}
