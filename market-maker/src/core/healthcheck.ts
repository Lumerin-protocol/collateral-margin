import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type pino from "pino";
import type Fraction from "fraction.js";
import type { OracleTracker } from "./oracleTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { CollateralTracker } from "./collateralTracker.ts";
import type { BookTracker } from "./bookTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type { ErrorInfo } from "./errors.ts";
import type { OwnOrder } from "./adapter.ts";

export interface ExecutorStats {
  ordersPlaced: number;
  ordersCancelled: number;
  reconcileCount: number;
}

export interface HealthCheckOptions {
  port: number;
  appName: string;
  /**
   * Full parsed config with secrets redacted (private keys, RPC API keys),
   * surfaced verbatim under `config` in /health output. Build via
   * `sanitiseConfig` from `core/config/base.ts`. Bigints are serialised to
   * strings by the /health JSON.stringify replacer.
   */
  configSummary: Record<string, unknown>;
  oracle: OracleTracker;
  inventory: InventoryManager;
  collateral: CollateralTracker;
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
 */
export class HealthCheck {
  private server: Server | null = null;
  private startedAt = Date.now();

  tickCount = 0;
  lastTickAt = 0;
  executorStats: ExecutorStats | null = null;
  walletAddress = "";
  status: "initializing" | "init-error" | "running" | "error" | "stopped" =
    "initializing";
  lastError: ErrorInfo | null = null;
  paused = false;

  onStop: (() => Promise<void>) | null = null;
  onStart: (() => Promise<void>) | null = null;

  private readonly opts: HealthCheckOptions;

  constructor(opts: HealthCheckOptions) {
    this.opts = opts;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.startedAt = Date.now();
      this.server = createServer((req, res) => {
        try {
          if (req.method === "POST" && req.url === "/stop")
            return this.handleStop(res);
          if (req.method === "POST" && req.url === "/start")
            return this.handleStart(res);
          if (req.method === "GET" && req.url === "/health")
            return this.handleHealth(res);
          res.writeHead(404);
          res.end();
        } catch (err) {
          this.opts.logger.error({ err }, "server error");
          res.writeHead(500);
          res.end();
        }
      });

      const logger = this.opts.logger;
      const port = this.opts.port;
      this.server.listen(port, () => {
        logger.info(
          { url: `http://localhost:${port}/health` },
          "health endpoint started",
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

  private handleHealth(res: ServerResponse): void {
    const { oracle, inventory, collateral, book, gas, risk } = this.opts;
    const body = JSON.stringify(
      {
        app: this.opts.appName,
        status: this.status,
        walletAddress: this.walletAddress,
        lastError: this.lastError,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        config: this.opts.configSummary,
        market: {
          oraclePrice: oracle.currentPrice.toString(),
          volatilityPerSecond: fractionToNumber(oracle.volatilityPerSecond),
          bestBid: book.bestBid.toString(),
          bestAsk: book.bestAsk.toString(),
          ownOrders: serializeOwnOrders(book.ownOrders),
        },
        inventory: {
          netPosition: inventory.netQuantity.toString(),
          inventorySkew: fractionToNumber(inventory.inventorySkew),
        },
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
        stats: {
          tickCount: this.tickCount,
          lastTickAt: this.lastTickAt,
          ordersPlaced: this.executorStats?.ordersPlaced ?? 0,
          ordersCancelled: this.executorStats?.ordersCancelled ?? 0,
          reconcileCount: this.executorStats?.reconcileCount ?? 0,
        },
      },
      bigIntReplacer,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
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

  private respondOk(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: this.status }));
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
}

function fractionToNumber(value: Fraction): number {
  // diagnostic only — never used in trading math.
  // Realized-vol Fractions can have 1000+ bit numerators/denominators (sqrt at
  // 48-bit precision over a 60-sample window), so a naive Number cast overflows
  // both sides to Infinity and JSON-serialises as `null`. Simplify first to
  // collapse the magnitude before the cast.
  const v = value.simplify(1e-12);
  return (Number(v.s) * Number(v.n)) / Number(v.d);
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

interface OwnOrdersView {
  count: number;
  bids: Array<{ price: bigint; quantity: bigint; orderIds: `0x${string}`[] }>;
  asks: Array<{ price: bigint; quantity: bigint; orderIds: `0x${string}`[] }>;
}

/**
 * Snapshot of resting MM orders, aggregated by (price, side) so that multiple
 * orders at the same price level are collapsed into one entry with the
 * individual `orderIds` listed as a nested array.
 *
 * Sorted top-of-book first (best bid = highest price, best ask = lowest price).
 * Bigints are stringified by `bigIntReplacer` when the payload is serialised.
 */
function serializeOwnOrders(
  orders: ReadonlyMap<`0x${string}`, OwnOrder>,
): OwnOrdersView {
  // Aggregate by price within each side.
  const bidMap = new Map<
    bigint,
    { quantity: bigint; orderIds: `0x${string}`[] }
  >();
  const askMap = new Map<
    bigint,
    { quantity: bigint; orderIds: `0x${string}`[] }
  >();
  for (const order of orders.values()) {
    const map = order.side === "buy" ? bidMap : askMap;
    const entry = map.get(order.price);
    if (entry) {
      entry.quantity += order.size;
      entry.orderIds.push(order.orderId);
    } else {
      map.set(order.price, { quantity: order.size, orderIds: [order.orderId] });
    }
  }

  const sortDesc = (a: [bigint, unknown], b: [bigint, unknown]) =>
    a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0;
  const sortAsc = (a: [bigint, unknown], b: [bigint, unknown]) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

  const bidEntries = [...bidMap.entries()].sort(sortDesc);
  const askEntries = [...askMap.entries()].sort(sortAsc);

  return {
    count: orders.size,
    bids: bidEntries.map(([price, v]) => ({
      price,
      quantity: v.quantity,
      orderIds: v.orderIds,
    })),
    asks: askEntries.map(([price, v]) => ({
      price,
      quantity: v.quantity,
      orderIds: v.orderIds,
    })),
  };
}
