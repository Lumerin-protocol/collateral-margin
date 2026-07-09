import { HashPowerPerpsDEXAbi } from "derivatives-marketplace-abi/HashPowerPerpsDEX.ts";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { AggregatorV3Abi } from "./abi.ts";

/**
 * A single tick of the hashprice oracle, in token decimals (USDC = 6).
 * `at` is the wall-clock receipt timestamp (set when we read the value, not
 * the Chainlink `updatedAt`) — used by consumers to discard ticks they've
 * already processed.
 */
export interface PriceUpdate {
  /** Previous price (in token decimals). `undefined` on the first tick. */
  prev: bigint | undefined;
  /** New price (in token decimals). */
  next: bigint;
  /** Receipt time in ms-since-epoch. */
  at: number;
}

export type PriceListener = (update: PriceUpdate) => void;

/**
 * Watches the BTC/USDC Chainlink feed for `AnswerUpdated` events and, on
 * each event, re-reads the current `HashpriceUSD` answer. Emits a
 * `PriceUpdate` to every subscribed listener.
 *
 * Why this split:
 *   - `HashpriceUSD = HashpriceBTC × BTC/USD / scale`. BTC/USD moves on
 *     Chainlink's deviation/heartbeat triggers (often, sub-minute on
 *     volatile days); HashpriceBTC moves only when a BTC block is mined
 *     and `submitBlock` is called (~10 min cadence).
 *   - BTC/USD is therefore the dominant driver of HashpriceUSD changes.
 *     Subscribing to one feed and reading the aggregated value gives us
 *     fresh `HashpriceUSD` values without polling either upstream.
 *   - The slower HashpriceBTC drift falls to the periodic safety-net sweep.
 *
 * The feed also handles the upstream-decimals → token-decimals rebase: the
 * aggregator answer is `oracle.decimals()` (typically 8 for HashpriceUSD);
 * we rescale to the perps/futures token decimals (USDC = 6) so consumers
 * compare apples to apples with `getMarketPrice()`.
 *
 * The oracle quotes the price of `ORACLE_UNIT_HPS_DAY` (100 TH/s over a day), but the
 * venues denominate one contract in `contractSizeHpsDay` (default 1e15 = 1 PH/s over a
 * day). We read that contract-size multiplier from the perps venue once at `start()` and
 * apply `contractSizeHpsDay / ORACLE_UNIT_HPS_DAY` so the streamed price matches on-chain
 * `getMarketPrice()`. Both venues are assumed to share the same contract size.
 *
 * Lifecycle:
 *   - `start()`: read decimals, prime `current` via one `latestRoundData`,
 *     then attach the watcher. Returns once the first read has resolved.
 *   - `stop()`: detach the watcher. Idempotent.
 *   - `current()`: latest known price; `undefined` until first read.
 *   - `onUpdate(listener)`: subscribe; returns an unsubscribe fn.
 */
export class PriceFeed {
  private listeners: Set<PriceListener> = new Set();
  private currentPrice: bigint | undefined;
  private unwatch: (() => void) | undefined;
  /** 10^(oracleDecimals - tokenDecimals). Set during `start()`. */
  private rescaleDivisor: bigint = 1n;
  /** Contract size in hashes/s·day (`contractSizeHpsDay`). Set during `start()`. */
  private contractSizeHpsDay: bigint = 1n;
  /** Oracle quote basis in hashes/s·day (`ORACLE_UNIT_HPS_DAY`). Set during `start()`. */
  private oracleUnitHpsDay: bigint = 1n;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;
  /** Token decimals of the collateral / venue answer (USDC = 6). */
  private readonly tokenDecimals: number;

  constructor(
    chain: Chain,
    config: Config,
    logger: pino.Logger,
    tokenDecimals: number,
  ) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ component: "priceFeed" });
    this.tokenDecimals = tokenDecimals;
  }

  async start(): Promise<void> {
    if (this.unwatch !== undefined) {
      this.logger.warn("PriceFeed.start: already running");
      return;
    }

    const oracleDecimals = (await this.chain.publicClient.readContract({
      address: this.config.oracle.hashpriceUsdcAddress,
      abi: AggregatorV3Abi,
      functionName: "decimals",
    })) as number;

    if (oracleDecimals < this.tokenDecimals) {
      throw new Error(
        `PriceFeed: oracle decimals (${oracleDecimals}) < token decimals (${this.tokenDecimals})`,
      );
    }
    this.rescaleDivisor = 10n ** BigInt(oracleDecimals - this.tokenDecimals);

    // Rebase from the oracle's quote basis (100 TH/s/day) to one contract unit
    // (contractSizeHpsDay/day), matching `getMarketPrice()` on-chain.
    const [contractSizeHpsDay, oracleUnitHpsDay] = await Promise.all([
      this.chain.publicClient.readContract({
        address: this.config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "CONTRACT_SIZE_HPS_DAY",
      }) as Promise<bigint>,
      this.chain.publicClient.readContract({
        address: this.config.perps.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "ORACLE_UNIT_HPS_DAY",
      }) as Promise<bigint>,
    ]);
    if (contractSizeHpsDay <= 0n || oracleUnitHpsDay <= 0n) {
      throw new Error(
        `PriceFeed: invalid contract size (contractSizeHpsDay=${contractSizeHpsDay}, ORACLE_UNIT_HPS_DAY=${oracleUnitHpsDay})`,
      );
    }
    this.contractSizeHpsDay = contractSizeHpsDay;
    this.oracleUnitHpsDay = oracleUnitHpsDay;

    await this.refresh("start");

    // We watch BTC/USDC (not HashpriceUSD) because HashpriceUSD is a pure
    // composite view and emits no events of its own. Any BTC/USDC tick
    // potentially shifts HashpriceUSD, so we re-read on every event.
    this.unwatch = this.chain.publicClient.watchContractEvent({
      address: this.config.oracle.btcUsdcFeedAddress,
      abi: AggregatorV3Abi,
      eventName: "AnswerUpdated",
      onLogs: () => {
        // Fire-and-forget: refresh runs in the background and dispatches to
        // listeners. If a refresh is already in flight, the next event will
        // overlap — that's fine, listeners only react to monotonic changes.
        void this.refresh("event");
      },
    });

    this.logger.info(
      {
        hashpriceUsdc: this.config.oracle.hashpriceUsdcAddress,
        btcUsdcFeed: this.config.oracle.btcUsdcFeedAddress,
        oracleDecimals,
        tokenDecimals: this.tokenDecimals,
        contractSizeHpsDay: this.contractSizeHpsDay,
        oracleUnitHpsDay: this.oracleUnitHpsDay,
        currentPrice: this.currentPrice,
      },
      "PriceFeed started",
    );
  }

  stop(): void {
    if (this.unwatch !== undefined) {
      try {
        this.unwatch();
      } catch (err) {
        this.logger.warn({ err }, "PriceFeed.stop: unwatch threw");
      }
      this.unwatch = undefined;
    }
  }

  current(): bigint | undefined {
    return this.currentPrice;
  }

  onUpdate(listener: PriceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Re-read `latestRoundData`, rescale to token decimals, dispatch if the
   * value actually changed. Public for tests and for the runtime layer to
   * force a refresh after restart / on RPC reconnect.
   */
  async refresh(source: "start" | "event" | "manual"): Promise<void> {
    let answer: bigint;
    try {
      const data = (await this.chain.publicClient.readContract({
        address: this.config.oracle.hashpriceUsdcAddress,
        abi: AggregatorV3Abi,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      answer = data[1];
    } catch (err) {
      this.logger.error({ err, source }, "PriceFeed.refresh: read failed");
      return;
    }

    if (answer <= 0n) {
      this.logger.warn({ answer, source }, "PriceFeed.refresh: non-positive answer, skipping");
      return;
    }

    // Mirror on-chain `getMarketPrice()`: rebase decimals first, then apply the
    // contract-size multiplier (contractSizeHpsDay / ORACLE_UNIT_HPS_DAY).
    const next = ((answer / this.rescaleDivisor) * this.contractSizeHpsDay) / this.oracleUnitHpsDay;
    const prev = this.currentPrice;
    if (prev === next) return;

    this.currentPrice = next;
    const update: PriceUpdate = { prev, next, at: Date.now() };
    this.logger.debug({ prev, next, source }, "PriceFeed update");

    for (const l of this.listeners) {
      try {
        l(update);
      } catch (err) {
        this.logger.error({ err, source }, "PriceFeed listener threw");
      }
    }
  }
}
