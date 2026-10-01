import type { Abi, Address } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
import { HashPowerFuturesAbi } from "../abi/HashPowerFutures.ts";
import { PerpsPositionAbi } from "../venues/perpsPositionAbi.ts";
import { sendLiquidate } from "../tx/liquidate.ts";
import { BACKSTOP_ADDR } from "../protocolAccounts.ts";

/** Local fragment until the pinned perps ABI carries `unwindBackstop(uint256)` / `BackstopUnwound`. */
const PERPS_UNWIND_ABI = [
  {
    type: "function",
    name: "unwindBackstop",
    stateMutability: "nonpayable",
    inputs: [{ name: "_qty", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "BackstopUnwound",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "filledQuantity", type: "int256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "TimeInForceNotFilled",
    inputs: [],
  },
  {
    type: "error",
    name: "PositionNotExists",
    inputs: [],
  },
] as const satisfies Abi;

export interface BackstopLegStats {
  venue: "futures" | "perps";
  /** Futures expiry, absent for perps. */
  expirationAt?: bigint;
  netQuantity: bigint;
}

export interface BackstopUnwinderStats {
  ticks: number;
  unwinds: number;
  unfilled: number;
  feeEarned: bigint;
  lastTickAt?: number;
  legs: readonly BackstopLegStats[];
}

/**
 * Permissionless reducer of the protocol backstop's exposure.
 *
 * Every tick it reads the backstop's net position on each venue (per active
 * expiry on futures) and, where non-zero, sends one `unwindBackstop` per leg.
 * The venue prices the fill inside the vault's band around the mark and pays
 * the caller the unwind fee, so the only decision made here is *how much* to
 * request: the whole leg by default, or the configured per-tx cap. A leg with
 * no liquidity inside the band reverts `TimeInForceNotFilled`, which
 * `sendLiquidate` surfaces as a skip rather than an error.
 *
 * Matured futures legs are left to the delivery coordinator: the venue rejects
 * them with `ExpirationDateNotAvailable`, and settlement is the correct exit.
 */
export class BackstopUnwinder {
  private timer: NodeJS.Timeout | undefined;
  private inflight = false;
  private readonly stats: BackstopUnwinderStats = {
    ticks: 0,
    unwinds: 0,
    unfilled: 0,
    feeEarned: 0n,
    legs: [],
  };

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly ethUsdFeed: EthUsdFeed | undefined;

  constructor(
    chain: Chain,
    config: Config,
    logger: pino.Logger,
    ethUsdFeed?: EthUsdFeed,
  ) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ component: "backstopUnwinder" });
    this.ethUsdFeed = ethUsdFeed;
  }

  async start(): Promise<void> {
    this.logger.info(
      {
        intervalMs: this.config.backstop.intervalMs,
        maxQtyFutures: this.config.backstop.maxQtyFutures.toString(),
        maxQtyPerps: this.config.backstop.maxQtyPerps.toString(),
        backstop: BACKSTOP_ADDR,
      },
      "backstop unwinder starting",
    );
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.backstop.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): BackstopUnwinderStats {
    return { ...this.stats, legs: [...this.stats.legs] };
  }

  /** One sweep over both venues. Public for tests and ad-hoc operations. */
  async tick(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      this.stats.ticks++;
      this.stats.lastTickAt = Date.now();
      const legs: BackstopLegStats[] = [];
      await this.tickFutures(legs);
      await this.tickPerps(legs);
      this.stats.legs = legs;
    } catch (err) {
      this.logger.error({ err }, "backstop unwind tick failed");
    } finally {
      this.inflight = false;
    }
  }

  private async tickFutures(legs: BackstopLegStats[]): Promise<void> {
    const address = this.config.futures.address;
    const expirationAts = (await this.chain.publicClient.readContract({
      address,
      abi: HashPowerFuturesAbi,
      functionName: "getActiveExpirationDates",
      args: [BACKSTOP_ADDR],
    })) as readonly bigint[];
    if (expirationAts.length === 0) return;

    const positions = (await this.chain.publicClient.multicall({
      contracts: expirationAts.map((expirationAt) => ({
        address,
        abi: HashPowerFuturesAbi,
        functionName: "getUserPosition" as const,
        args: [BACKSTOP_ADDR, expirationAt] as const,
      })),
      allowFailure: false,
    })) as readonly { netQuantity: bigint }[];

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    for (let i = 0; i < expirationAts.length; i++) {
      const expirationAt = expirationAts[i]!;
      const net = positions[i]?.netQuantity ?? 0n;
      if (net === 0n) continue;
      legs.push({ venue: "futures", expirationAt, netQuantity: net });
      if (expirationAt <= nowSec) {
        this.logger.debug(
          { expirationAt: expirationAt.toString(), net: net.toString() },
          "backstop futures leg matured — left to settlement",
        );
        continue;
      }
      const qty = capQty(abs(net), this.config.backstop.maxQtyFutures);
      await this.send({
        venue: "futures",
        address,
        abi: HashPowerFuturesAbi as Abi,
        args: [expirationAt, qty],
        label: { expirationAt: expirationAt.toString(), net: net.toString(), qty: qty.toString() },
      });
    }
  }

  private async tickPerps(legs: BackstopLegStats[]): Promise<void> {
    const address = this.config.perps.address;
    const position = (await this.chain.publicClient.readContract({
      address,
      abi: PerpsPositionAbi,
      functionName: "getUserPosition",
      args: [BACKSTOP_ADDR],
    })) as { netQuantity: bigint };
    const net = position.netQuantity;
    if (net === 0n) return;
    legs.push({ venue: "perps", netQuantity: net });

    const qty = capQty(abs(net), this.config.backstop.maxQtyPerps);
    await this.send({
      venue: "perps",
      address,
      abi: PERPS_UNWIND_ABI as Abi,
      args: [qty],
      label: { net: net.toString(), qty: qty.toString() },
    });
  }

  private async send(opts: {
    venue: "futures" | "perps";
    address: Address;
    abi: Abi;
    args: readonly unknown[];
    label: Record<string, string>;
  }): Promise<void> {
    const logger = this.logger.child({ venue: opts.venue, ...opts.label });
    const result = await sendLiquidate({
      chain: this.chain,
      config: this.config,
      logger,
      address: opts.address,
      abi: opts.abi,
      functionName: "unwindBackstop",
      args: opts.args,
      feeEventName: "BackstopUnwound",
      mapSkip: (errorName) =>
        errorName === "TimeInForceNotFilled" ? "unfilled" : "notLiquidatable",
      ethUsdFeed: this.ethUsdFeed,
    });
    if ("skipped" in result) {
      if (result.skipped === "unfilled") {
        this.stats.unfilled++;
        logger.debug("backstop unwind: no liquidity inside the band");
      } else {
        logger.info({ skipped: result.skipped }, "backstop unwind skipped");
      }
      return;
    }
    this.stats.unwinds++;
    this.stats.feeEarned += result.feeEarned;
    logger.info({ feeEarned: result.feeEarned.toString() }, "backstop unwind confirmed");
  }
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function capQty(absNet: bigint, cap: bigint): bigint {
  return cap > 0n && absNet > cap ? cap : absNet;
}
