import type pino from "pino";
import type {
  CancelIntent,
  InstrumentAdapter,
  OrderIntent,
  VenueAdapter,
} from "./adapter.ts";
import type { NonceManager, TxOutcome } from "./nonceManager.ts";

/** One market's desired order changes for a cycle. */
export interface MarketIntents {
  instrument: InstrumentAdapter;
  cancels: CancelIntent[];
  creates: OrderIntent[];
}

export interface TxCoordinatorConfig {
  /** Max encoded calls per on-chain tx before chunking. Default 50. */
  maxCallsPerTx?: number;
}

export interface SubmitOptions {
  maxFeePerGas: bigint;
  dryRun: boolean;
  /**
   * Portfolio pre-trade gate. Returns whether `additionalIM` (summed across
   * every market's creates) still fits under the wallet's IM budget. This is
   * the single aggregate `engine.canPlaceOrder` check — never per market.
   */
  canPlace: (additionalIM: bigint) => Promise<boolean>;
}

export interface SubmitResult {
  receipts: TxOutcome[];
  /** Non-fatal per-venue errors; other venues still submitted. */
  errors: Error[];
  ordersPlaced: number;
  ordersCancelled: number;
  /** True if the aggregate gate denied placements (creates were dropped). */
  gateDenied: boolean;
}

/**
 * Centralized ordered submission for the single-wallet portfolio process.
 *
 * Responsibilities:
 *   1. Aggregate pre-trade gate over ALL markets' creates (one canPlaceOrder).
 *   2. Group intents by venue — expiries on the same Futures contract merge
 *      into one `Futures.multicall`; perps is its own contract (≥2 txs total).
 *   3. Cancels-before-creates within each venue batch (free margin first).
 *   4. Submit each venue independently via the shared NonceManager: a revert or
 *      timeout on one venue is recorded and never blocks the other.
 */
export class TxCoordinator {
  private readonly nonce: NonceManager;
  private readonly maxCallsPerTx: number;
  private readonly logger: pino.Logger;

  constructor(nonce: NonceManager, cfg: TxCoordinatorConfig, logger: pino.Logger) {
    this.nonce = nonce;
    this.maxCallsPerTx = cfg.maxCallsPerTx ?? 50;
    this.logger = logger.child({ component: "tx-coordinator" });
  }

  async submit(all: MarketIntents[], opts: SubmitOptions): Promise<SubmitResult> {
    const result: SubmitResult = {
      receipts: [],
      errors: [],
      ordersPlaced: 0,
      ordersCancelled: 0,
      gateDenied: false,
    };

    // 1. Aggregate pre-trade gate across every market's creates.
    let additionalIM = 0n;
    let totalCreates = 0;
    for (const m of all) {
      totalCreates += m.creates.length;
      for (const c of m.creates) additionalIM += m.instrument.estimateOrderMargin(c);
    }
    let allowCreates = true;
    if (totalCreates > 0 && additionalIM > 0n) {
      allowCreates = await opts.canPlace(additionalIM);
      if (!allowCreates) {
        result.gateDenied = true;
        this.logger.warn(
          { additionalIM: additionalIM.toString(), wouldPlace: totalCreates },
          "aggregate canPlaceOrder denied; cancelling stale only",
        );
      }
    }

    // 2. Group by venue (identity). Expiries share their futures venue.
    const byVenue = new Map<VenueAdapter, MarketIntents[]>();
    for (const m of all) {
      const venue = m.instrument.venue;
      const list = byVenue.get(venue);
      if (list) list.push(m);
      else byVenue.set(venue, [m]);
    }

    // 3. Build + submit per venue, isolated.
    for (const [venue, markets] of byVenue) {
      const calls: `0x${string}`[] = [];
      let cancelCount = 0;
      let placeCount = 0;

      // Cancels first (all markets), then creates (all markets).
      for (const m of markets) {
        for (const c of m.cancels) {
          calls.push(m.instrument.encodeCancel(c));
          cancelCount++;
        }
      }
      if (allowCreates) {
        for (const m of markets) {
          for (const c of m.creates) {
            calls.push(m.instrument.encodeCreate(c));
            placeCount++;
          }
        }
      }

      if (calls.length === 0) continue;

      if (opts.dryRun) {
        this.logger.info(
          { venue: venue.kind, cancels: cancelCount, creates: placeCount, calls: calls.length },
          "DRY RUN: would submit venue batch",
        );
        result.ordersCancelled += cancelCount;
        result.ordersPlaced += placeCount;
        continue;
      }

      try {
        const chunks = this.chunk(calls);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const outcome = await this.nonce.submit(
            ({ nonce, maxFeePerGas }) => venue.multicall(chunk, { maxFeePerGas, nonce }),
            { maxFeePerGas: opts.maxFeePerGas, label: `${venue.kind}#${i}` },
          );
          result.receipts.push(outcome);
        }
        result.ordersCancelled += cancelCount;
        result.ordersPlaced += placeCount;
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        result.errors.push(wrapped);
        this.logger.error(
          { err: wrapped, venue: venue.kind },
          "venue submission failed — other venues unaffected",
        );
      }
    }

    return result;
  }

  private chunk(calls: `0x${string}`[]): `0x${string}`[][] {
    const out: `0x${string}`[][] = [];
    for (let i = 0; i < calls.length; i += this.maxCallsPerTx) {
      out.push(calls.slice(i, i + this.maxCallsPerTx));
    }
    return out;
  }
}
