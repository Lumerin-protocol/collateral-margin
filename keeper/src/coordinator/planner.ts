import type { Address } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Venue } from "../venues/types.ts";
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
  positionsClosed?: number;
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
 *   4. If still unhealthy: pick the most-underwater venue (max summed
 *      `unrealizedLoss` across its positions) and call `reduceToTarget(user)`
 *      — ONE batched tx that closes the venue's worst-first positions down to
 *      the IM buffer (futures: a lot subset; perps: a partial `closeQty`). The
 *      on-chain `OrdersStillOpen` revert is treated as a recoverable race —
 *      re-run step 3 then retry. Re-snapshot health.
 *   5. Repeat step 4 until healthy OR no venue can close any more (all
 *      positions gone, or every venue reports `nothingToClose`). If positions
 *      are gone and the account is still unhealthy, emit a `BadDebt` log and a
 *      critical alert (the insurance fund must absorb the residual).
 *
 * The planner is purely orchestration — venues encapsulate calldata,
 * Multicall3 batching, gas estimation, and the unprofitable / not-liquidatable
 * skip predicates.
 */
export class Planner {
  /**
   * Hard cap on the position-leg loop. Each iteration issues ONE gas-bounded
   * `reduceToTarget` chunk (Futures closes up to `maxLotsPerLiquidationTx`
   * lots; Perps closes any quantity in one tx) OR retries an `ordersLeg` after
   * an `OrdersStillOpen` race. With chunking, a large book drains across
   * SUCCESSIVE iterations, so this must be generous enough to cover
   * `ceil(largestBook / chunkSize)` per venue plus a few order replays.
   * 64 iterations × ~50 lots per Futures chunk ≈ 3,200 lot closures — far
   * above any realistic single-user portfolio — while still being a firm
   * defense-in-depth cap so a venue bug can't pin the executor on one user.
   */
  private static readonly MAX_POSITION_ITERATIONS = 64;

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

    // Step 4–5: position loop. Each iteration picks the most-underwater venue
    // and issues ONE batched `reduceToTarget` that closes it down to the IM
    // buffer, then re-snapshots health. Venues that report `nothingToClose`
    // (their leg is already at/above IM but the portfolio is still under MM)
    // are parked in `exhausted` so we don't spin on them.
    const exhausted = new Set<Venue["name"]>();
    for (let iter = 0; iter < Planner.MAX_POSITION_ITERATIONS; iter++) {
      const rankedVenues = await this.rankVenuesByLoss(user);
      const actionable = rankedVenues.filter((v) => !exhausted.has(v.venue.name));

      if (rankedVenues.length === 0) {
        // No positions left to close anywhere but still unhealthy → bad debt.
        log.error(
          { mmSurplus: health.mmSurplus, totalFee, positionsClosed, ordersClosed },
          "BadDebt: no positions remain but account still under MM",
        );
        return { kind: "badDebt", mmSurplus: health.mmSurplus, feeEarned: totalFee };
      }
      if (actionable.length === 0) {
        // Every venue with positions reported `nothingToClose` — the account
        // is under MM on-chain but no venue's off-chain sizing found a close
        // (a snapshot/price race). Re-queue rather than force a full close.
        log.warn(
          { mmSurplus: health.mmSurplus, totalFee, positionsClosed, ordersClosed },
          "Position-leg: all venues report nothingToClose — stalling",
        );
        return { kind: "stalled", reason: "nothingToClose", mmSurplus: health.mmSurplus };
      }

      const worst = actionable[0];
      log.info(
        {
          venue: worst.venue.name,
          unrealizedLoss: worst.totalLoss,
          positionCount: worst.positionCount,
        },
        "Position-leg: reducing worst venue down to the IM buffer",
      );
      const result = await worst.venue.reduceToTarget(user);

      if ("feeEarned" in result) {
        positionsClosed += result.positionsClosed;
        totalFee += result.feeEarned;
        reports.push({
          kind: "positionLeg",
          venue: worst.venue.name,
          feeEarned: result.feeEarned,
          positionsClosed: result.positionsClosed,
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
        // `nothingToClose` (park the venue) or `notLiquidatable` (stale
        // snapshot / `OverLiquidation` race — re-rank from a fresh snapshot).
        reports.push({
          kind: "positionLeg",
          venue: worst.venue.name,
          feeEarned: 0n,
          skipped: result.skipped,
        });
        if (result.skipped === "nothingToClose") exhausted.add(worst.venue.name);
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
   * Fans out `liquidateOrders(user, ids)` across every venue. Each venue handles
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
   * Ranks venues that hold at least one position for `user`, most-underwater
   * first. Per venue we sum `unrealizedLoss` across its positions (primary key
   * DESC); tiebreak is summed `notional` DESC (the bigger book frees more
   * margin when reduced). Venues with no positions are omitted — the position
   * leg only ever calls `reduceToTarget` on venues that have something to close.
   */
  private async rankVenuesByLoss(
    user: Address,
  ): Promise<Array<{ venue: Venue; totalLoss: bigint; totalNotional: bigint; positionCount: number }>> {
    const ranked: Array<{
      venue: Venue;
      totalLoss: bigint;
      totalNotional: bigint;
      positionCount: number;
    }> = [];
    for (const venue of this.venues) {
      const positions = await venue.readPositions(user);
      if (positions.length === 0) continue;
      let totalLoss = 0n;
      let totalNotional = 0n;
      for (const p of positions) {
        totalLoss += p.unrealizedLoss;
        totalNotional += p.notional;
      }
      ranked.push({ venue, totalLoss, totalNotional, positionCount: positions.length });
    }
    ranked.sort((a, b) => {
      if (a.totalLoss !== b.totalLoss) return a.totalLoss < b.totalLoss ? 1 : -1;
      if (a.totalNotional !== b.totalNotional) return a.totalNotional < b.totalNotional ? 1 : -1;
      return 0;
    });
    return ranked;
  }

  private async readHealth(user: Address): Promise<AccountHealth> {
    const [h] = await readAccountHealthBatch(this.chain, this.config, [user]);
    if (h === undefined) {
      throw new Error(`readAccountHealthBatch returned no entry for ${user}`);
    }
    return h;
  }
}
