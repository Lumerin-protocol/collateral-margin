/**
 * # Historical price source
 *
 * Backfills the OracleTracker's rolling window at startup so realized
 * volatility is meaningful from the first quote, instead of waiting
 * `windowSize × pollInterval` for the window to populate from live polls.
 *
 * Both perps and futures consume the Hashprice USD aggregator on chain. The
 * `hashprice-oracle` subgraph indexes every aggregator update as a
 * `HashpriceUsd` time-series entity, so a single shared source serves both
 * apps.
 *
 * Log returns `ln(p_i / p_{i-1})` are scale-invariant, so we deliberately
 * skip rebasing subgraph prices to token decimals — the rolling window only
 * needs the *ratios*, and avoiding the rebase keeps this module independent
 * of the venue adapters.
 */

import type pino from "pino";

export interface PricePoint {
  /** Unix timestamp in seconds. */
  timestampSec: number;
  /** Raw price as stored by the source (units irrelevant — log returns are scale-free). */
  price: bigint;
}

export interface HistoricalPriceSource {
  /**
   * Returns up to `maxPoints` price samples within the last `lookbackSec`
   * seconds, oldest first. Implementations should silently truncate if the
   * source has fewer matching points; callers tolerate short results.
   */
  fetch(opts: { lookbackSec: number; maxPoints: number }): Promise<PricePoint[]>;
}

/**
 * Hashprice-oracle subgraph implementation.
 *
 * Queries the `HashpriceUsd` time-series entity, which is written every time
 * either the BTC/USD Chainlink feed or the on-chain hashprice contract emits
 * a fresh answer (see `indexer/src/hashprice.ts → deriveHashpriceUsd`).
 *
 * The Graph's GraphQL API speaks plain JSON over HTTP; we use Node's global
 * `fetch` (>=22) so the MM keeps a single runtime dependency surface.
 */
export class HashpriceOracleSubgraphSource implements HistoricalPriceSource {
  private readonly url: string;
  private readonly logger: pino.Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { url: string; logger: pino.Logger; fetchImpl?: typeof fetch }) {
    this.url = opts.url;
    this.logger = opts.logger.child({ component: "hashprice-subgraph" });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetch(opts: { lookbackSec: number; maxPoints: number }): Promise<PricePoint[]> {
    const sinceSec = Math.floor(Date.now() / 1000) - Math.max(0, Math.floor(opts.lookbackSec));
    // The Graph's `Timestamp` scalar is **microseconds since Unix epoch**, not
    // seconds. Both the `where: { timestamp_gte: ... }` filter and the returned
    // field use µs. We rescale at the boundary so the rest of the codebase
    // stays in seconds.
    const sinceMicros = BigInt(sinceSec) * 1_000_000n;
    // The Graph hosted-service caps `first` at 1000 per query; clamp so a
    // misconfigured `windowSize × multiplier` doesn't get rejected at the
    // gateway.
    const first = Math.min(Math.max(1, Math.floor(opts.maxPoints)), 1000);
    // Newest-first lets us hit small `first` values without paginating; we
    // reverse below to return oldest-first as the OracleTracker expects.
    //
    // `Timestamp` (i64) variables must be sent as JSON **strings** — passing a
    // number gets rejected with `Invalid value provided for argument "since":
    // Int(Number(...))`. Verified against the goldsky gateway with
    // introspection + a probe.
    const query = `
      query HashpriceHistory($since: Timestamp!, $first: Int!) {
        hashpriceUsds(
          where: { timestamp_gte: $since }
          orderBy: timestamp
          orderDirection: desc
          first: $first
        ) {
          timestamp
          price
        }
      }
    `;
    const body = JSON.stringify({
      query,
      variables: { since: sinceMicros.toString(), first },
    });

    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(
        `hashprice-subgraph: ${res.status} ${res.statusText} from ${this.url}`,
      );
    }
    const json = (await res.json()) as {
      data?: { hashpriceUsds?: Array<{ timestamp: string | number; price: string }> };
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `hashprice-subgraph: GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const rows = json.data?.hashpriceUsds ?? [];
    const points: PricePoint[] = rows.map((r) => ({
      // Timestamp is microseconds (see the `since` rescale above); convert
      // back to seconds for downstream math. Number() is safe here: i64 µs
      // up to year 2262 stays well within Number.MAX_SAFE_INTEGER once
      // divided by 1e6.
      timestampSec: Number(BigInt(r.timestamp) / 1_000_000n),
      price: BigInt(r.price),
    }));
    // Subgraph returned newest-first; flip so callers can push in chronological order.
    points.reverse();

    this.logger.debug(
      { url: this.url, requested: first, got: points.length, sinceSec },
      "fetched hashprice history",
    );
    return points;
  }
}
