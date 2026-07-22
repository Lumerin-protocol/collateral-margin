import type pino from "pino";
import type {
  CancelIntent,
  InstrumentAdapter,
  OrderIntent,
  ReduceIntent,
  VenueAdapter,
} from "./adapter.ts";
import type { NonceManager, TxOutcome } from "./nonceManager.ts";

/** One market's desired order changes for a cycle. */
export interface MarketIntents {
  instrument: InstrumentAdapter;
  cancels: CancelIntent[];
  reduces: ReduceIntent[];
  creates: OrderIntent[];
}

export type TxCoordinatorConfig = Record<string, never>;

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
  ordersReduced: number;
  /** True if the aggregate gate denied placements (creates were dropped). */
  gateDenied: boolean;
}

/**
 * Centralized ordered submission for the single-wallet portfolio process.
 *
 * Responsibilities:
 *   1. Aggregate pre-trade gate over ALL markets' creates (one canPlaceOrder).
 *   2. Group intents by venue — all futures expiries merge into one
 *      `updateOrders(cancels, reduces, creates)` (cancels → reduces → creates,
 *      one IM check).
 *   3. Submit each venue via a single `sendCall` (no multicall, no chunking).
 *   4. Isolate venue failures: a revert on one venue never blocks the other.
 */
export class TxCoordinator {
  private readonly nonce: NonceManager;
  private readonly logger: pino.Logger;

  constructor(nonce: NonceManager, _cfg: TxCoordinatorConfig, logger: pino.Logger) {
    this.nonce = nonce;
    this.logger = logger.child({ component: "tx-coordinator" });
  }

  async submit(all: MarketIntents[], opts: SubmitOptions): Promise<SubmitResult> {
    const result: SubmitResult = {
      receipts: [],
      errors: [],
      ordersPlaced: 0,
      ordersCancelled: 0,
      ordersReduced: 0,
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
          "aggregate canPlaceOrder denied; cancelling/reducing stale only",
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
      const encoder = markets[0]?.instrument;
      if (!encoder) continue;

      const cancels: CancelIntent[] = [];
      const reduces: ReduceIntent[] = [];
      const creates: OrderIntent[] = [];
      for (const m of markets) {
        cancels.push(...m.cancels);
        reduces.push(...(m.reduces ?? []));
        if (!allowCreates) continue;
        const expiry = instrumentExpirationAt(m.instrument);
        for (const c of m.creates) {
          creates.push(expiry !== undefined ? { ...c, expirationAt: c.expirationAt ?? expiry } : c);
        }
      }

      if (cancels.length === 0 && reduces.length === 0 && creates.length === 0) continue;

      const data = encoder.encodeUpdateOrders(cancels, reduces, creates);

      if (opts.dryRun) {
        this.logger.info(
          {
            venue: venue.kind,
            cancels: cancels.length,
            reduces: reduces.length,
            creates: creates.length,
          },
          "DRY RUN: would submit venue updateOrders",
        );
        result.ordersCancelled += cancels.length;
        result.ordersReduced += reduces.length;
        result.ordersPlaced += creates.length;
        continue;
      }

      try {
        const outcome = await this.nonce.submit(
          ({ nonce, maxFeePerGas }) =>
            venue.sendCall(data, { maxFeePerGas, nonce }),
          { maxFeePerGas: opts.maxFeePerGas, label: venue.kind },
        );
        result.receipts.push(outcome);
        result.ordersCancelled += cancels.length;
        result.ordersReduced += reduces.length;
        result.ordersPlaced += creates.length;
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
}

function instrumentExpirationAt(instrument: InstrumentAdapter): bigint | undefined {
  const expiry = (instrument as { expirationAt?: unknown }).expirationAt;
  return typeof expiry === "bigint" ? expiry : undefined;
}
