import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type pino from "pino";
import type { OracleTracker } from "./oracleTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { BookTracker } from "./bookTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type Fraction from "fraction.js";
import type { RiskManager } from "./riskManager.ts";
import type { MakerConfig } from "./config.ts";
import type { ErrorInfo } from "./errors.ts";

export interface ExecutorStats {
  ordersPlaced: number;
  ordersCancelled: number;
  reconcileCount: number;
}

export interface HealthCheckOptions {
  port: number;
  config: MakerConfig;
  oracle: OracleTracker;
  inventory: InventoryManager;
  book: BookTracker;
  gas: GasTracker;
  risk: RiskManager;
  logger: pino.Logger;
}

/**
 * HTTP endpoint exposing health, status, and runtime config.
 *
 *  GET /health  → JSON snapshot of all trackers and config (sanitised)
 *  POST /stop   → pause the main loop, cancel resting orders (via onStop)
 *  POST /start  → resume the main loop (via onStart)
 *
 * The bot's main loop checks `paused` and skips ticks while true.
 */
export class HealthCheck {
  private server: Server | null = null;
  private startedAt = Date.now();

  tickCount = 0;
  lastTickAt = 0;
  executorStats: ExecutorStats | null = null;
  walletAddress = "";
  status: "initializing" | "init-error" | "running" | "error" | "stopped" = "initializing";
  lastError: ErrorInfo | null = null;
  paused = false;

  onStop: (() => Promise<void>) | null = null;
  onStart: (() => Promise<void>) | null = null;

  private readonly port: number;
  private readonly config: MakerConfig;
  private readonly oracle: OracleTracker;
  private readonly inventory: InventoryManager;
  private readonly book: BookTracker;
  private readonly gas: GasTracker;
  private readonly risk: RiskManager;
  private readonly logger: pino.Logger;

  constructor(opts: HealthCheckOptions) {
    this.port = opts.port;
    this.config = opts.config;
    this.oracle = opts.oracle;
    this.inventory = opts.inventory;
    this.book = opts.book;
    this.gas = opts.gas;
    this.risk = opts.risk;
    this.logger = opts.logger;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.startedAt = Date.now();
      this.server = createServer((req, res) => {
        try {
          if (req.method === "POST" && req.url === "/stop") return this.handleStop(res);
          if (req.method === "POST" && req.url === "/start") return this.handleStart(res);
          if (req.method === "GET" && req.url === "/health") return this.handleHealth(res);
          res.writeHead(404);
          res.end();
        } catch (err) {
          this.logger.error({ err }, "server error");
          res.writeHead(500);
          res.end();
        }
      });

      const logger = this.logger;
      this.server.listen(this.port, () => {
        logger.info({ url: `http://localhost:${this.port}/health` }, "health endpoint started");
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleHealth(res: ServerResponse): void {
    const body = JSON.stringify({
      status: this.status,
      walletAddress: this.walletAddress,
      lastError: this.lastError,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      config: {
        nodeEnv: this.config.nodeEnv,
        commitHash: this.config.commitHash,
        logLevel: this.config.logLevel,
        dryRun: this.config.dryRun,
        network: this.config.network.name,
        venue: { kind: this.config.venue.kind, address: this.config.venue.address },
        pricing: this.config.pricing,
        sizing: this.config.sizing,
        risk: this.config.risk,
        gas: this.config.gas,
        timing: this.config.timing,
      },
      market: {
        oraclePrice: this.oracle.currentPrice.toString(),
        volatility: fractionToNumber(this.oracle.volatility),
        bestBid: this.book.bestBid.toString(),
        bestAsk: this.book.bestAsk.toString(),
        ownOrders: this.book.ownOrders.size,
      },
      inventory: {
        netPosition: this.inventory.netQuantity.toString(),
        collateralBalance: this.inventory.collateralBalance.toString(),
        nativeBalance: this.inventory.nativeBalance.toString(),
        walletTokenBalance: this.inventory.walletTokenBalance.toString(),
        inventorySkew: fractionToNumber(this.inventory.inventorySkew),
        utilizationPct: this.inventory.utilizationPct,
      },
      gas: {
        gasGwei: (Number(this.gas.currentGasPrice) / 1e9).toFixed(2),
        gasSpiking: this.gas.isGasSpiking,
        gasSpikePct: fractionToNumber(this.gas.gasSpikePct).toFixed(0),
      },
      risk: {
        throttled: this.risk.throttled,
        throttleReason: this.risk.throttleReason,
        cumulativeGasCostUsd: this.risk.cumulativeGasCostUsd.toString(),
      },
      stats: {
        tickCount: this.tickCount,
        lastTickAt: this.lastTickAt,
        ordersPlaced: this.executorStats?.ordersPlaced ?? 0,
        ordersCancelled: this.executorStats?.ordersCancelled ?? 0,
        reconcileCount: this.executorStats?.reconcileCount ?? 0,
      },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }

  private handleStop(res: ServerResponse): void {
    if (this.paused) return this.respondOk(res);
    this.paused = true;
    this.status = "stopped";
    this.lastError = null;

    if (!this.onStop) return this.respondOk(res);
    this.onStop()
      .then(() => this.respondOk(res))
      .catch((err) => {
        this.logger.error({ err }, "onStop callback failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "stop callback failed" }));
      });
  }

  private handleStart(res: ServerResponse): void {
    if (!this.paused) return this.respondOk(res);
    this.paused = false;
    this.status = "running";
    this.lastError = null;

    if (!this.onStart) return this.respondOk(res);
    this.onStart()
      .then(() => this.respondOk(res))
      .catch((err) => {
        this.logger.error({ err }, "onStart callback failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "start callback failed" }));
      });
  }

  private respondOk(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: this.status }));
  }
}

function fractionToNumber(value: Fraction): number {
  // diagnostic only — never used in trading math
  return (Number(value.s) * Number(value.n)) / Number(value.d);
}
