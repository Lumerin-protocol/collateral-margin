import { createServer, type Server } from "node:http";
import type pino from "pino";
import type { Config } from "../config.ts";
import type { CoordinatorExecutor } from "../coordinator/executor.ts";
import type { CoordinatorQueue } from "../coordinator/queue.ts";
import type { ParticipantTracker } from "../discovery/tracker.ts";
import type { PriceFeed } from "../oracle/priceFeed.ts";
import type { PredictiveCoordinator } from "../predict/coordinator.ts";

/**
 * Health and metrics surface for the keeper.
 *
 *   GET /health   liveness probe (200 ok / 503 degraded). Body holds the
 *                 same metrics as /metrics for convenience.
 *   GET /metrics  Prometheus-text exposition of keeper-internal counters.
 *
 * Health flips to 503 when the executor isn't running (event watcher
 * silently dropped, executor stopped) so the orchestrator (k8s, ECS)
 * restarts the pod. Metrics are exposed unconditionally — useful even
 * when the keeper is degraded.
 *
 * Predictor metrics are optional so this module remains usable for the
 * legacy boot path that doesn't have one.
 */
export class Healthcheck {
  private server: Server | undefined;

  private readonly config: Config;
  private readonly tracker: ParticipantTracker;
  private readonly executor: CoordinatorExecutor;
  private readonly queue: CoordinatorQueue;
  private readonly predictor: PredictiveCoordinator | undefined;
  private readonly priceFeed: PriceFeed | undefined;
  private readonly logger: pino.Logger;

  constructor(
    config: Config,
    tracker: ParticipantTracker,
    executor: CoordinatorExecutor,
    queue: CoordinatorQueue,
    logger: pino.Logger,
    predictor?: PredictiveCoordinator,
    priceFeed?: PriceFeed,
  ) {
    this.config = config;
    this.tracker = tracker;
    this.executor = executor;
    this.queue = queue;
    this.predictor = predictor;
    this.priceFeed = priceFeed;
    this.logger = logger.child({ component: "healthcheck" });
  }

  /** Snapshot of every observable counter the keeper exposes. */
  snapshot(): Record<string, number | string | null> {
    return {
      executorRunning: this.executor.isRunning() ? 1 : 0,
      trackedUsers: this.tracker.size(),
      inflight: this.executor.inflightCount(),
      queueDepth: this.queue.size(),
      predictedUsers: this.predictor?.size() ?? 0,
      predictedWarnUsers: this.predictor?.warnSize() ?? 0,
      predictedCritUsers: this.predictor?.critSize() ?? 0,
      predictorInflight: this.predictor?.inflight() ?? 0,
      currentPrice: this.priceFeed?.current()?.toString() ?? null,
    };
  }

  start(): void {
    this.server = createServer((req, res) => {
      if (req.url === "/health") {
        const ok = this.executor.isRunning();
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: ok ? "ok" : "degraded",
            ...this.snapshot(),
          }),
        );
        return;
      }
      if (req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(this.renderPrometheus());
        return;
      }
      res.writeHead(404).end();
    });

    this.server.listen(this.config.runtime.healthPort, () => {
      this.logger.info({ port: this.config.runtime.healthPort }, "healthcheck listening");
    });
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    const srv = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  /**
   * Minimal Prometheus exposition. Skips the `currentPrice` line when the
   * feed hasn't primed yet (Prometheus rejects non-numeric values). Each
   * metric uses a `keeper_` prefix to namespace it from system metrics.
   */
  private renderPrometheus(): string {
    const snap = this.snapshot();
    const lines: string[] = [];
    for (const [k, v] of Object.entries(snap)) {
      if (k === "currentPrice") {
        if (v === null) continue;
        lines.push(`# HELP keeper_oracle_price_token Latest oracle price in token decimals.`);
        lines.push(`# TYPE keeper_oracle_price_token gauge`);
        lines.push(`keeper_oracle_price_token ${v}`);
        continue;
      }
      const metric = `keeper_${snakeCase(k)}`;
      lines.push(`# TYPE ${metric} gauge`);
      lines.push(`${metric} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function snakeCase(camel: string): string {
  return camel.replace(/([A-Z])/g, "_$1").toLowerCase();
}
