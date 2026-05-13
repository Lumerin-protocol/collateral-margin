import type { Address, Hex } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Venue, VenuePosition } from "../venues/types.ts";
import type { Config } from "../config.ts";
import type { AccountHealth } from "../pme/health.ts";
import { readAccountHealthBatch } from "../pme/health.ts";

/** What happened at the end of a single `Planner.run(user)` call. */
export type PlanOutcome =
  | { kind: "healthy"; mmSurplus: bigint }
  | {
      kind: "liquidated";
      mmSurplus: bigint;
      feeEarned: bigint;
      positionsClosed: number;
      ordersClosed: number;
    }
  | { kind: "badDebt"; mmSurplus: bigint; feeEarned: bigint }
  | { kind: "stalled"; reason: string; mmSurplus: bigint };

/** Internal step result — captured for telemetry / tests. */
interface StepReport {
  kind: "ordersLeg" | "positionLeg";
  venue: Venue["name"];
  feeEarned: bigint;
  ordersClosed?: number;
  positionId?: Hex;
  skipped?: string;
}

/**
 * Per-account coordinated liquidation plan.
 *
 * Algorithm (mirrors the Mermaid flowchart in the unified-margin-keeper plan):
 *
 *   1. Snapshot orders + positions across ALL venues for `user`, plus
 *      `readAccountHealthBatch([user])`.
 *   2. If `mmSurplus >= 0`: account is healthy — emit `done`.
 *   3. Else: call `liquidateOrders` on every venue that has open orders.
 *      Re-snapshot health.
 *   4. If still unhealthy: pick the most-underwater single position across
 *      all venues (max `unrealizedLoss`, tiebreak on `notional`) and call
 *      `liquidatePosition` on that venue. The on-chain `OrdersStillOpen`
 *      revert is treated as a recoverable race — re-run step 3 then retry.
 *      Re-snapshot health.
 *   5. Repeat step 4 until healthy OR no positions remain. If no positions
 *      remain and the account is still unhealthy, emit a `BadDebt` log and
 *      a critical alert (the insurance fund must absorb the residual).
 *
 * The planner is purely orchestration — venues encapsulate calldata,
 * Multicall3 batching, gas estimation, and the unprofitable / not-liquidatable
 * skip predicates.
 */
export class Planner {
  /**
   * Hard cap on the position-leg loop. Each iteration closes at least one
   * position OR retries an `ordersLeg` after an `OrdersStillOpen` race —
   * looping forever shouldn't be possible, but this is a defense-in-depth
   * cap so a venue bug can't pin the executor on one user. Set generously:
   * 16 iterations × ~50 positions per venue ≈ 800 closures, far above any
   * realistic single-user portfolio.
   */
  private static readonly MAX_POSITION_ITERATIONS = 16;

  // Explicit fields — Node's TypeScript strip-only mode does not support
  // parameter properties (the `private readonly chain: Chain` shortcut).
  private readonly chain: Chain;
  private readonly config: Config;
  private readonly venues: readonly Venue[];
  private readonly logger: pino.Logger;

  constructor(
    chain: Chain,
    config: Config,
    venues: readonly Venue[],
    logger: pino.Logger,
  ) {
    this.chain = chain;
    this.config = config;
    this.venues = venues;
    this.logger = logger;
  }

  async run(user: Address): Promise<PlanOutcome> {
    const log = this.logger.child({ user });
    const reports: StepReport[] = [];
    let totalFee = 0n;
    let ordersClosed = 0;
    let positionsClosed = 0;

    // Step 1+2: initial snapshot. Cheap exit if the account is already healthy
    // — this is the common case for re-evaluation triggers.
    let health = await this.readHealth(user);
    if (health.mmSurplus >= 0n) {
      log.debug({ mmSurplus: health.mmSurplus }, "Account healthy on entry — no plan to run");
      return { kind: "healthy", mmSurplus: health.mmSurplus };
    }

    log.info(
      { mmSurplus: health.mmSurplus },
      "Planner.run: account underwater, running coordinated plan",
    );

    // Step 3: orders-leg across every venue. Each venue's `liquidateOrders`
    // is permissionless and natively handles "no open orders" via the
    // `notLiquidatable` skip — we don't need a per-venue read first.
    const ordersLegReports = await this.runOrdersLeg(user, log);
    reports.push(...ordersLegReports);
    for (const r of ordersLegReports) {
      totalFee += r.feeEarned;
      ordersClosed += r.ordersClosed ?? 0;
    }

    health = await this.readHealth(user);
    if (health.mmSurplus >= 0n) {
      log.info(
        { mmSurplus: health.mmSurplus, totalFee, ordersClosed },
        "Account healthy after orders-leg — done",
      );
      return {
        kind: "liquidated",
        mmSurplus: health.mmSurplus,
        feeEarned: totalFee,
        positionsClosed: 0,
        ordersClosed,
      };
    }

    // Step 4–5: position loop, one position at a time, picking the worst
    // across all venues. We re-snapshot health after every closure since
    // closing one position can flip the account healthy or change the
    // ranking of the remaining positions.
    for (let iter = 0; iter < Planner.MAX_POSITION_ITERATIONS; iter++) {
      const ranked = await this.rankPositions(user);
      if (ranked.length === 0) {
        // No positions left to close but still unhealthy → bad debt.
        log.error(
          { mmSurplus: health.mmSurplus, totalFee, positionsClosed, ordersClosed },
          "BadDebt: no positions remain but account still under MM",
        );
        return { kind: "badDebt", mmSurplus: health.mmSurplus, feeEarned: totalFee };
      }

      const worst = ranked[0];
      log.info(
        {
          venue: worst.venue.name,
          marketLabel: worst.venue.marketLabel(worst.position.marketId),
          unrealizedLoss: worst.position.unrealizedLoss,
          notional: worst.position.notional,
        },
        "Position-leg: liquidating worst position",
      );
      const result = await worst.venue.liquidatePosition(user, worst.position.id);

      if ("feeEarned" in result) {
        positionsClosed++;
        totalFee += result.feeEarned;
        reports.push({
          kind: "positionLeg",
          venue: worst.venue.name,
          feeEarned: result.feeEarned,
          positionId: worst.position.id,
        });
      } else if (result.skipped === "ordersStillOpen") {
        // A new order appeared between the orders-leg and now (race with the
        // matching engine, e.g. a fill leaving residual margin obligations).
        // Re-run the orders-leg and retry on the next iteration.
        log.warn(
          { venue: worst.venue.name },
          "Position-leg hit OrdersStillOpen — replaying orders-leg and retrying",
        );
        const replay = await this.runOrdersLeg(user, log);
        reports.push(...replay);
        for (const r of replay) {
          totalFee += r.feeEarned;
          ordersClosed += r.ordersClosed ?? 0;
        }
      } else {
        // Either `notLiquidatable` (this position is no longer liquidatable
        // — likely already-closed; loop to re-rank), or `unprofitable` (gas
        // cost exceeds reward — bail rather than burn money).
        reports.push({
          kind: "positionLeg",
          venue: worst.venue.name,
          feeEarned: 0n,
          positionId: worst.position.id,
          skipped: result.skipped,
        });
        if (result.skipped === "unprofitable") {
          log.warn(
            { mmSurplus: health.mmSurplus, totalFee, positionsClosed },
            "Position-leg unprofitable — stalling",
          );
          return { kind: "stalled", reason: "unprofitable", mmSurplus: health.mmSurplus };
        }
        // notLiquidatable → loop and re-rank from a fresh snapshot.
      }

      health = await this.readHealth(user);
      if (health.mmSurplus >= 0n) {
        log.info(
          { mmSurplus: health.mmSurplus, totalFee, positionsClosed, ordersClosed },
          "Account healthy after position-leg — done",
        );
        return {
          kind: "liquidated",
          mmSurplus: health.mmSurplus,
          feeEarned: totalFee,
          positionsClosed,
          ordersClosed,
        };
      }
    }

    // Iteration cap hit. We've been making progress (iteration only counts
    // up after a meaningful step) but couldn't bring the account healthy in
    // the budget. Surface as `stalled` so the executor re-queues for a
    // future sweep rather than exploding.
    log.warn(
      {
        mmSurplus: health.mmSurplus,
        totalFee,
        positionsClosed,
        ordersClosed,
        iterCap: Planner.MAX_POSITION_ITERATIONS,
      },
      "Planner.run: hit iteration cap, re-queueing",
    );
    return { kind: "stalled", reason: "iterationCap", mmSurplus: health.mmSurplus };
  }

  /**
   * Fans out `liquidateOrders(user)` across every venue. Each venue handles
   * the "no orders" case internally and returns `{ skipped: "notLiquidatable" }`
   * — we collapse that to a zero-fee no-op.
   */
  private async runOrdersLeg(user: Address, log: pino.Logger): Promise<StepReport[]> {
    const reports: StepReport[] = [];
    for (const venue of this.venues) {
      // Read first so we can both (a) report `ordersClosed` count for
      // telemetry and (b) skip the call entirely when there are zero open
      // orders — saves the `simulateContract` round-trip in the common case.
      const openOrders = await venue.readOpenOrders(user);
      if (openOrders.length === 0) {
        reports.push({ kind: "ordersLeg", venue: venue.name, feeEarned: 0n, ordersClosed: 0 });
        continue;
      }
      const ids = openOrders.map((o) => o.id);
      const result = await venue.liquidateOrders(user, ids);
      if ("feeEarned" in result) {
        log.info(
          { venue: venue.name, count: openOrders.length, feeEarned: result.feeEarned },
          "Orders-leg: liquidated open orders",
        );
        reports.push({
          kind: "ordersLeg",
          venue: venue.name,
          feeEarned: result.feeEarned,
          ordersClosed: openOrders.length,
        });
      } else {
        // Race: orders cleared between read and call. Treat as a no-op.
        reports.push({
          kind: "ordersLeg",
          venue: venue.name,
          feeEarned: 0n,
          ordersClosed: 0,
          skipped: result.skipped,
        });
      }
    }
    return reports;
  }

  /**
   * Returns every (venue, position) pair across all venues, sorted
   * most-underwater first. Primary key is `unrealizedLoss` DESC; tiebreak is
   * `notional` DESC (closing the bigger position frees more margin).
   */
  private async rankPositions(
    user: Address,
  ): Promise<Array<{ venue: Venue; position: VenuePosition }>> {
    const all: Array<{ venue: Venue; position: VenuePosition }> = [];
    for (const venue of this.venues) {
      const positions = await venue.readPositions(user);
      for (const p of positions) all.push({ venue, position: p });
    }
    all.sort((a, b) => {
      if (a.position.unrealizedLoss !== b.position.unrealizedLoss) {
        return a.position.unrealizedLoss < b.position.unrealizedLoss ? 1 : -1;
      }
      if (a.position.notional !== b.position.notional) {
        return a.position.notional < b.position.notional ? 1 : -1;
      }
      return 0;
    });
    return all;
  }

  private async readHealth(user: Address): Promise<AccountHealth> {
    const [h] = await readAccountHealthBatch(this.chain, this.config, [user]);
    if (h === undefined) {
      throw new Error(`readAccountHealthBatch returned no entry for ${user}`);
    }
    return h;
  }
}
