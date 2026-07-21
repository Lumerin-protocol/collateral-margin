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
  /**
   * Max cost units per on-chain tx before splitting a venue's work across
   * sequential `updateOrders` txs. One unit is the cheapest single call (see
   * `InstrumentAdapter.createCallWeight`). Cancels weigh 1 each. Default 50.
   */
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
 *   2. Group intents by venue — all futures expiries merge into one
 *      `updateOrders(cancels, creates)` (cancels first, one IM check).
 *   3. Submit each venue via `sendCall` (no multicall). Oversized work splits
 *      into sequential txs: cancel-only chunks first, then create-only chunks.
 *   4. Isolate venue failures: a revert on one venue never blocks the other.
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
      const encoder = markets[0]?.instrument;
      if (!encoder) continue;

      const cancels: CancelIntent[] = [];
      const creates: OrderIntent[] = [];
      for (const m of markets) {
        cancels.push(...m.cancels);
        if (!allowCreates) continue;
        const expiry = instrumentExpirationAt(m.instrument);
        for (const c of m.creates) {
          creates.push(expiry !== undefined ? { ...c, expirationAt: c.expirationAt ?? expiry } : c);
        }
      }

      if (cancels.length === 0 && creates.length === 0) continue;

      const payloads = this.encodeVenueUpdateOrders(encoder, cancels, creates);

      if (opts.dryRun) {
        this.logger.info(
          {
            venue: venue.kind,
            cancels: cancels.length,
            creates: creates.length,
            txs: payloads.length,
          },
          "DRY RUN: would submit venue updateOrders",
        );
        result.ordersCancelled += cancels.length;
        result.ordersPlaced += creates.length;
        continue;
      }

      try {
        for (let i = 0; i < payloads.length; i++) {
          const data = payloads[i];
          const outcome = await this.nonce.submit(
            ({ nonce, maxFeePerGas }) =>
              venue.sendCall(data, { maxFeePerGas, nonce }),
            { maxFeePerGas: opts.maxFeePerGas, label: `${venue.kind}#${i}` },
          );
          result.receipts.push(outcome);
        }
        result.ordersCancelled += cancels.length;
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

  /**
   * Encode one or more `updateOrders` payloads for a venue. Prefer a single
   * call (all cancels then all creates, one IM check). When over budget, split
   * into cancel-only chunks followed by create-only chunks so later creates
   * still see earlier cancels' freed margin across sequential txs.
   */
  private encodeVenueUpdateOrders(
    encoder: InstrumentAdapter,
    cancels: CancelIntent[],
    creates: OrderIntent[],
  ): `0x${string}`[] {
    let weight = cancels.length;
    for (const c of creates) weight += Math.max(1, encoder.createCallWeight(c));

    if (weight <= this.maxCallsPerTx) {
      return [encoder.encodeUpdateOrders(cancels, creates)];
    }

    const out: `0x${string}`[] = [];
    for (const slice of chunkArray(cancels, this.maxCallsPerTx)) {
      out.push(encoder.encodeUpdateOrders(slice, []));
    }

    let createBuf: OrderIntent[] = [];
    let createWeight = 0;
    for (const c of creates) {
      const w = Math.max(1, encoder.createCallWeight(c));
      if (createBuf.length > 0 && createWeight + w > this.maxCallsPerTx) {
        out.push(encoder.encodeUpdateOrders([], createBuf));
        createBuf = [];
        createWeight = 0;
      }
      createBuf.push(c);
      createWeight += w;
    }
    if (createBuf.length > 0) {
      out.push(encoder.encodeUpdateOrders([], createBuf));
    }
    return out;
  }
}

function instrumentExpirationAt(instrument: InstrumentAdapter): bigint | undefined {
  const expiry = (instrument as { expirationAt?: unknown }).expirationAt;
  return typeof expiry === "bigint" ? expiry : undefined;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
