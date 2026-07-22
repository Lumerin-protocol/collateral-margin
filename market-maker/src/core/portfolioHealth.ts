import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type pino from "pino";
import type Fraction from "fraction.js";
import type { CollateralTracker } from "./collateralTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type { MarketRuntime } from "./marketRuntime.ts";
import type { ErrorInfo } from "./errors.ts";
import {
  formatAgeMs,
  formatDurationSec,
  formatEthAmount,
  formatPrice,
  formatTimestampMs,
  formatUsdcAmount,
} from "./healthFormat.ts";

export interface PortfolioHealthOptions {
  port: number;
  appName: string;
  configSummary: Record<string, unknown>;
  collateral: CollateralTracker;
  gas: GasTracker;
  risk: RiskManager;
  logger: pino.Logger;
}

/**
 * Portfolio-aware health server.
 *
 *   GET /health      → human-readable strings ("1500 USDC", "44m 35s", …)
 *   GET /health/raw  → machine-readable base units (previous /health shape)
 *   POST /stop|/start → pause / resume the tick loop
 */
export class PortfolioHealthCheck {
  private server: Server | null = null;
  private startedAt = Date.now();

  tickCount = 0;
  lastTickAt = 0;
  walletAddress = "";
  status: "initializing" | "init-error" | "running" | "error" | "stopped" = "initializing";
  lastError: ErrorInfo | null = null;
  paused = false;

  /** Live market set provider, wired by the runner. */
  markets: () => MarketRuntime[] = () => [];
  onStop: (() => Promise<void>) | null = null;
  onStart: (() => Promise<void>) | null = null;

  private readonly opts: PortfolioHealthOptions;

  constructor(opts: PortfolioHealthOptions) {
    this.opts = opts;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.startedAt = Date.now();
      this.server = createServer((req, res) => {
        try {
          if (req.method === "POST" && req.url === "/stop") return this.handleStop(res);
          if (req.method === "POST" && req.url === "/start") return this.handleStart(res);
          if (req.method === "GET" && req.url === "/health") return this.handleHealthHuman(res);
          if (req.method === "GET" && req.url === "/health/raw") return this.handleHealthRaw(res);
          res.writeHead(404);
          res.end();
        } catch (err) {
          this.opts.logger.error({ err }, "server error");
          res.writeHead(500);
          res.end();
        }
      });
      const { logger, port } = this.opts;
      this.server.listen(port, () => {
        logger.info(
          {
            human: `http://localhost:${port}/health`,
            raw: `http://localhost:${port}/health/raw`,
          },
          "health endpoints started",
        );
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

  /** Ops-facing: wallet vs vault USDC called out; amounts/durations as labeled strings. */
  private handleHealthHuman(res: ServerResponse): void {
    const { collateral, gas, risk } = this.opts;
    const uptimeSec = Math.floor((Date.now() - this.startedAt) / 1000);
    const body = JSON.stringify(
      {
        app: this.opts.appName,
        status: this.status,
        walletAddress: this.walletAddress,
        lastError: this.lastError,
        uptime: formatDurationSec(uptimeSec),
        lastTickAt: formatTimestampMs(this.lastTickAt),
        lastTickAge: formatAgeMs(this.lastTickAt),
        collateral: {
          walletUsdc: formatUsdcAmount(collateral.walletTokenBalance),
          vaultUsdc: formatUsdcAmount(collateral.vaultBalance),
          portfolioImUsdc: formatUsdcAmount(collateral.portfolioIM),
          portfolioMmUsdc: formatUsdcAmount(collateral.portfolioMM),
          venueOrderMarginUsdc: formatUsdcAmount(collateral.venueOrderMargin),
          venueUnrealizedPnlUsdc: formatUsdcAmount(collateral.venueUnrealizedPnl),
          ethBalance: formatEthAmount(collateral.nativeBalance),
          utilization: `${collateral.utilizationPct}%`,
        },
        gas: {
          gasPrice: `${(Number(gas.currentGasPrice) / 1e9).toFixed(4)} gwei`,
          gasSpiking: gas.isGasSpiking,
          gasSpike: `${fractionToNumber(gas.gasSpikePct).toFixed(0)}%`,
        },
        risk: {
          throttled: risk.throttled,
          throttleReason: risk.throttleReason,
          cumulativeGasCostUsdc: formatUsdcAmount(risk.cumulativeGasCostUsd),
        },
        markets: this.markets().map((m) => {
          const s = m.healthState();
          return {
            id: s.id,
            breaker: s.breaker,
            consecutiveErrors: s.consecutiveErrors,
            lastError: s.lastError,
            oraclePrice: formatPrice(BigInt(s.oraclePrice)),
            bestBid: s.bestBid === "0" ? "none" : formatPrice(BigInt(s.bestBid)),
            bestAsk: s.bestAsk === "0" ? "none" : formatPrice(BigInt(s.bestAsk)),
            netPosition: s.netPosition,
            ownOrders: s.ownOrders,
          };
        }),
        stats: {
          tickCount: this.tickCount,
        },
      },
      bigIntReplacer,
    );
    this.respondJson(res, body);
  }

  /** Machine-readable: previous /health payload (base units as decimal strings). */
  private handleHealthRaw(res: ServerResponse): void {
    const { collateral, gas, risk } = this.opts;
    const body = JSON.stringify(
      {
        app: this.opts.appName,
        status: this.status,
        walletAddress: this.walletAddress,
        lastError: this.lastError,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        config: this.opts.configSummary,
        collateral: {
          vaultBalance: collateral.vaultBalance.toString(),
          portfolioIM: collateral.portfolioIM.toString(),
          portfolioMM: collateral.portfolioMM.toString(),
          venueOrderMargin: collateral.venueOrderMargin.toString(),
          venueUnrealizedPnl: collateral.venueUnrealizedPnl.toString(),
          walletTokenBalance: collateral.walletTokenBalance.toString(),
          nativeBalance: collateral.nativeBalance.toString(),
          utilizationPct: collateral.utilizationPct,
        },
        gas: {
          gasGwei: (Number(gas.currentGasPrice) / 1e9).toFixed(2),
          gasSpiking: gas.isGasSpiking,
          gasSpikePct: fractionToNumber(gas.gasSpikePct).toFixed(0),
        },
        risk: {
          throttled: risk.throttled,
          throttleReason: risk.throttleReason,
          cumulativeGasCostUsd: risk.cumulativeGasCostUsd.toString(),
        },
        markets: this.markets().map((m) => m.healthState()),
        stats: { tickCount: this.tickCount, lastTickAt: this.lastTickAt },
      },
      bigIntReplacer,
    );
    this.respondJson(res, body);
  }

  private handleStop(res: ServerResponse): void {
    if (this.paused) {
      this.respondOk(res);
      return;
    }
    this.paused = true;
    this.status = "stopped";
    this.lastError = null;
    if (!this.onStop) {
      this.respondOk(res);
      return;
    }
    this.onStop()
      .then(() => this.respondOk(res))
      .catch((err) => {
        this.opts.logger.error({ err }, "onStop callback failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "stop callback failed" }));
      });
  }

  private handleStart(res: ServerResponse): void {
    if (!this.paused) {
      this.respondOk(res);
      return;
    }
    this.paused = false;
    this.status = "running";
    this.lastError = null;
    if (!this.onStart) {
      this.respondOk(res);
      return;
    }
    this.onStart()
      .then(() => this.respondOk(res))
      .catch((err) => {
        this.opts.logger.error({ err }, "onStart callback failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "start callback failed" }));
      });
  }

  private respondOk(res: ServerResponse): void {
    this.respondJson(res, JSON.stringify({ ok: true, status: this.status }));
  }

  private respondJson(res: ServerResponse, body: string): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }
}

function fractionToNumber(value: Fraction): number {
  const v = value.simplify(1e-12);
  return (Number(v.s) * Number(v.n)) / Number(v.d);
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
