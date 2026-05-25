import type pino from "pino";
import type { Address } from "viem";
import type { Chain } from "../chain.ts";
import { AggregatorV3Abi } from "./abi.ts";

/**
 * Cached reader for a Chainlink ETH/USD `AggregatorProxy`. The keeper only
 * uses this for cosmetic logging — converting `gasUsed * effectiveGasPrice`
 * (wei) into a USD number that's readable in a dashboard at 4 a.m. without
 * doing wei-math in your head.
 *
 * Periodic refresh rather than event-subscribed because:
 *   - Latency doesn't matter for log enrichment. A 1-minute stale price
 *     is fine when the underlying use case is "roughly how much did this
 *     tx cost?".
 *   - One `latestRoundData` read per refresh, no `watchContractEvent` to
 *     unwatch — keeps the surface area trivially testable and avoids
 *     having ANOTHER subscription on the RPC.
 *
 * Lifecycle is opt-in: built only when `config.oracle.ethUsdcFeedAddress`
 * is set, otherwise consumers receive `undefined` and silently skip USD
 * enrichment. Failures are non-fatal — a downed feed never blocks a tx
 * log or crashes the keeper; the next refresh just tries again.
 */
export class EthUsdFeed {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Last read price as raw oracle units (USD per ETH, scaled by `decimals`). */
  private price: bigint | undefined;
  /** Oracle decimals (typically 8 for Chainlink USD pairs). Set on first read. */
  private decimals: number | undefined;
  /** Wall-clock ms of the most recent successful read. */
  private updatedAtMs: number | undefined;

  private readonly chain: Chain;
  private readonly address: Address;
  private readonly logger: pino.Logger;
  private readonly refreshIntervalMs: number;

  constructor(
    chain: Chain,
    address: Address,
    logger: pino.Logger,
    refreshIntervalMs: number,
  ) {
    this.chain = chain;
    this.address = address;
    this.logger = logger.child({ component: "ethUsdFeed" });
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Primes the cache via one eager read so the first tx log after boot
   * has a price (avoids "first tx is the only one missing gasCostUsd"),
   * then schedules periodic refreshes. Idempotent.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    // Don't keep the event loop alive for a logging-only refresh — the
    // keeper's other timers / subscriptions are what pin the process.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Convert a wei amount to USD using the most-recent price.
   * Returns `undefined` when the feed hasn't successfully read yet,
   * letting callers cleanly skip the USD log field.
   *
   * Floating-point at the boundary is deliberate: we're producing a
   * log string ("$0.0023"), not doing accounting. bigint USD would
   * either lose precision (round to cents) or surface confusing
   * units (`123456` micro-USD).
   */
  weiToUsd(weiAmount: bigint): number | undefined {
    if (this.price === undefined || this.decimals === undefined) return undefined;
    // usd = wei * priceUsdPerEth / 1e18 / 10^decimals
    // Do the integer scaling in bigint to avoid wei overflow, then
    // promote to number for the final fractional value.
    const denom = 10n ** (18n + BigInt(this.decimals));
    // Multiply numerator by 1e8 for ~8 decimal places of fractional USD,
    // then divide by 1e8 in float. Keeps gasCostUsd resolvable down to
    // micro-cents — relevant on cheap L2s where tx cost is well below $0.01.
    const scaled = (weiAmount * this.price * 100_000_000n) / denom;
    return Number(scaled) / 100_000_000;
  }

  /** Latest known price in raw oracle units; `undefined` until first successful read. */
  current(): bigint | undefined {
    return this.price;
  }

  /** Most-recent successful read time (ms-since-epoch); `undefined` until first read. */
  updatedAt(): number | undefined {
    return this.updatedAtMs;
  }

  /**
   * Single read of `latestRoundData` + (first call only) `decimals`.
   * Public so tests can drive a deterministic refresh, and so any
   * caller that needs a guaranteed-fresh price (e.g. an integration
   * test) can force one without waiting for the next interval tick.
   */
  async refresh(): Promise<void> {
    try {
      if (this.decimals === undefined) {
        this.decimals = (await this.chain.publicClient.readContract({
          address: this.address,
          abi: AggregatorV3Abi,
          functionName: "decimals",
        })) as number;
      }
      const data = (await this.chain.publicClient.readContract({
        address: this.address,
        abi: AggregatorV3Abi,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const answer = data[1];
      if (answer <= 0n) {
        this.logger.warn({ answer }, "ETH/USD feed returned non-positive answer — keeping previous");
        return;
      }
      this.price = answer;
      this.updatedAtMs = Date.now();
    } catch (err) {
      // RPC blip or stale node — keep the previous price (it's only
      // used for logging enrichment) and try again next tick.
      this.logger.warn({ err }, "ETH/USD feed refresh failed — keeping previous price");
    }
  }
}
