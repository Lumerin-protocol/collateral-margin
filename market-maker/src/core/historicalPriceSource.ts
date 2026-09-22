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
 * Prices come back in whatever fixed-point scale the subgraph stores, which
 * is the aggregator's own decimals — not the token decimals that live oracle
 * reads are rebased to. Ratios *within* this series are unaffected, so the
 * raw scale is kept here and the module stays independent of the venue
 * adapters. The series is not interchangeable with live samples, though:
 * `OracleTracker.initialize` rebases it onto the live scale before pushing,
 * because a window holding both scales at once produces a log return the
 * size of the decimal difference at the join.
 */

import type pino from "pino";

export interface PricePoint {
  /** Unix timestamp in seconds. */
  timestampSec: number;
  /** Price in the series' declared fixed-point scale; consumers rebase it. */
  price: bigint;
}

/** A historical series together with the feed and scale it describes. */
export interface HistoricalPriceSeries {
  /** Aggregator the source indexed, for cross-checking against the live oracle. */
  address: `0x${string}`;
  /** Fixed-point decimals every `points[].price` is expressed in. */
  decimals: number;
  /** Samples, oldest first. */
  points: PricePoint[];
}

export interface HistoricalPriceSource {
  /**
   * Returns the newest `maxPoints` samples that are no older than
   * `maxAgeSec`, oldest first. Implementations should silently truncate if
   * the source has fewer matching points; callers tolerate short results.
   *
   * Implementations must report the feed and scale the samples belong to
   * rather than leaving the caller to infer them — see `HistoricalPriceSeries`.
   */
  fetch(opts: { maxAgeSec: number; maxPoints: number }): Promise<HistoricalPriceSeries>;
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

  async fetch(opts: { maxAgeSec: number; maxPoints: number }): Promise<HistoricalPriceSeries> {
    const sinceSec = Math.floor(Date.now() / 1000) - Math.max(0, Math.floor(opts.maxAgeSec));
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
    // `hashpriceMeta` carries the aggregator the subgraph indexed and the
    // decimals it stores `price` in. Both are needed to line the series up
    // with live oracle reads, so they travel with it in one round trip.
    const query = `
      query HashpriceHistory($since: Timestamp!, $first: Int!) {
        hashpriceMetas(first: 1) {
          hashpriceUsdAddress
          hashpriceUsdDecimals
        }
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
      data?: {
        hashpriceMetas?: Array<{ hashpriceUsdAddress: string; hashpriceUsdDecimals: string | number }>;
        hashpriceUsds?: Array<{ timestamp: string | number; price: string }>;
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `hashprice-subgraph: GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const meta = json.data?.hashpriceMetas?.[0];
    if (!meta) {
      // Without the meta row the series cannot declare its feed or scale, and
      // guessing either is what this whole path exists to avoid.
      throw new Error(`hashprice-subgraph: no HashpriceMeta row at ${this.url}`);
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

    const address = meta.hashpriceUsdAddress.toLowerCase() as `0x${string}`;
    const decimals = Number(meta.hashpriceUsdDecimals);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new Error(
        `hashprice-subgraph: invalid hashpriceUsdDecimals "${meta.hashpriceUsdDecimals}"`,
      );
    }

    this.logger.debug(
      { url: this.url, requested: first, got: points.length, sinceSec, address, decimals },
      "fetched hashprice history",
    );
    return { address, decimals, points };
  }
}
