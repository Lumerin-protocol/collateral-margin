/**
 * Shared "raw oracle" helper.
 *
 * Both venue contracts (`Futures.getMarketPrice`, `HashPowerPerpsDEX.getMarketPrice`)
 * pre-round the oracle answer to the nearest tick before returning it. That
 * collapses the MM's reservation price onto a tick boundary, which forces a
 * 2-tick floor on the symmetric bid/ask layout.
 *
 * `RawOracleReader` reads the underlying Chainlink aggregator directly and
 * applies the same `10^(oracle.decimals − token.decimals)` rebase the venue does,
 * but skips the tick rounding. The MM gets a unit-precision mid that lands
 * between ticks ~99% of the time, so `roundDownToTick(r) → bidMid` and
 * `roundUpToTick(r) → askMid` produce a 1-tick spread without any extra
 * pricing-strategy plumbing.
 *
 * The two venues differ only in *how* the (oracle address, scaling divisor)
 * tuple is discovered. Each adapter supplies that as a `resolve()` callback;
 * the reader caches the result for the lifetime of the process (both change
 * only on `setOracle`-style admin txs).
 */

import type { PublicClient } from "viem";

/** Chainlink AggregatorV3Interface — read-only slice we need for the raw mid. */
export const chainlinkAggregatorAbi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { internalType: "uint80", name: "roundId", type: "uint80" },
      { internalType: "int256", name: "answer", type: "int256" },
      { internalType: "uint256", name: "startedAt", type: "uint256" },
      { internalType: "uint256", name: "updatedAt", type: "uint256" },
      { internalType: "uint80", name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface RawOracleConfig {
  oracle: `0x${string}`;
  /** 10^(oracle.decimals − token.decimals); used to rebase the answer to token decimals. */
  divisor: bigint;
}

export class RawOracleReader {
  private readonly publicClient: PublicClient;
  private readonly resolve: () => Promise<RawOracleConfig>;
  private readonly label: string;
  private cache: RawOracleConfig | null = null;

  constructor(opts: {
    publicClient: PublicClient;
    /** Discover (oracle, divisor) on first read; called at most once unless reset. */
    resolve: () => Promise<RawOracleConfig>;
    /** Used in error messages, e.g. "futures" / "perps". */
    label: string;
  }) {
    this.publicClient = opts.publicClient;
    this.resolve = opts.resolve;
    this.label = opts.label;
  }

  /** Latest oracle answer, rebased to token decimals (no tick rounding). */
  async read(): Promise<bigint> {
    if (this.cache === null) {
      this.cache = await this.resolve();
    }
    const data = await this.publicClient.readContract({
      address: this.cache.oracle,
      abi: chainlinkAggregatorAbi,
      functionName: "latestRoundData",
    });
    const answer = data[1];
    if (answer <= 0n) {
      throw new Error(`${this.label}: oracle returned non-positive answer (${answer.toString()})`);
    }
    // Mirror the venue's `getMarketPrice()` decimal rebase (no unit factor).
    return answer / this.cache.divisor;
  }

  /** Drop cached (oracle, divisor) — next `read()` will re-resolve. */
  invalidate(): void {
    this.cache = null;
  }
}
