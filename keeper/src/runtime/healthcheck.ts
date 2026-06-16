import { createServer, type Server } from "node:http";
import type { Address } from "viem";
import type pino from "pino";
import type { Config } from "../config.ts";
import type { CoordinatorExecutor } from "../coordinator/executor.ts";
import type { CoordinatorQueue } from "../coordinator/queue.ts";
import type { ParticipantTracker } from "../discovery/tracker.ts";
import type { PriceFeed } from "../oracle/priceFeed.ts";
import type { PredictedThresholds, PredictiveCoordinator } from "../predict/coordinator.ts";

/**
 * Health and metrics surface for the keeper.
 *
 *   GET /health   liveness probe (200 ok / 503 degraded). Body holds the
 *                 full snapshot — counters AND per-user address lists
 *                 (`trackedUsers`, `predictedUsers`, `predictorInflight`,
 *                 `underwater`) — so a single `curl :3000/health | jq`
 *                 tells ops everything the keeper currently knows.
 *   GET /metrics  Prometheus-text exposition of keeper-internal counters.
 *                 Address lists are reduced to their `length` (gauge)
 *                 here so we don't blow up Prometheus cardinality.
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
  private readonly signerAddress: Address;
  private readonly tracker: ParticipantTracker;
  private readonly executor: CoordinatorExecutor;
  private readonly queue: CoordinatorQueue;
  private readonly predictor: PredictiveCoordinator | undefined;
  private readonly priceFeed: PriceFeed | undefined;
  private readonly logger: pino.Logger;

  constructor(
    config: Config,
    signerAddress: Address,
    tracker: ParticipantTracker,
    executor: CoordinatorExecutor,
    queue: CoordinatorQueue,
    logger: pino.Logger,
    predictor?: PredictiveCoordinator,
    priceFeed?: PriceFeed,
  ) {
    this.config = config;
    this.signerAddress = signerAddress;
    this.tracker = tracker;
    this.executor = executor;
    this.queue = queue;
    this.predictor = predictor;
    this.priceFeed = priceFeed;
    this.logger = logger.child({ component: "healthcheck" });
  }

  /**
   * Static identity of this keeper instance: network, signer, contract
   * addresses, and operating-mode flags. Returned as strings so it can be
   * rendered as Prometheus labels (`keeper_info{…} 1`) and as a JSON block
   * on `/health` for ops dashboards.
   */
  info(): Record<string, string> {
    return {
      version: this.config.version,
      network: this.config.chain.network,
      discoveryMode: this.config.chain.discoveryMode,
      dryRun: String(this.config.keeper.dryRun),
      signer: this.signerAddress,
      vault: this.config.vault.address,
      perps: this.config.perps.address,
      futures: this.config.futures.address,
      pme: this.config.pme.address,
      hashpriceUsdcFeed: this.config.oracle.hashpriceUsdcAddress,
      btcUsdcFeed: this.config.oracle.btcUsdcFeedAddress,
    };
  }

  /**
   * Snapshot of every observable counter the keeper exposes.
   *
   * - `trackedUsers`: every address the keeper monitors, full list.
   * - `underwater`: queue contents (`mmSurplus < 0`), head-first.
   * - `predictedThresholds`: one row per user the predictor is watching,
   *   with `liq` / `warn` / `crit` price levels combined so consumers
   *   see all triggers for a user in one place. Being listed here means
   *   "we've solved future thresholds for this user", not "this user is
   *   currently in warn/critical state" — current state is on-chain
   *   `imUtilization`, owned by the alert path.
   * - `predictorInflight`: users with an in-flight predictive rebuild.
   *
   * Predictor-derived arrays are empty when the predictor isn't wired.
   */
  snapshot(): Record<
    string,
    | number
    | string
    | readonly Address[]
    | readonly UnderwaterEntry[]
    | readonly PredictedThresholds[]
    | null
  > {
    // Surface the head of the queue — the single most diagnostic number
    // for a liquidator (how underwater is the worst account right now,
    // and which one is it). `mmDeficit` is `|mmSurplus|` because the
    // queue only ever holds underwater accounts (`mmSurplus < 0`).
    const head = this.queue.peek();
    return {
      executorRunning: this.executor.isRunning() ? 1 : 0,
      trackedUsers: this.tracker.list(),
      inflight: this.executor.inflightCount(),
      queueDepth: this.queue.size(),
      queueHeadMmDeficit: head === undefined ? 0 : (-head.mmSurplus).toString(),
      queueHeadUser: head?.user ?? null,
      underwater: this.queue.snapshot().map((h) => ({
        user: h.user,
        mmDeficit: (-h.mmSurplus).toString(),
      })),
      predictedThresholds: this.predictor?.thresholds() ?? [],
      predictorInflight: this.predictor?.inflightUsers() ?? [],
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
            info: this.info(),
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
   * Minimal Prometheus exposition. Each metric uses a `keeper_` prefix to
   * namespace it from system metrics. Address-list snapshot fields are
   * collapsed to their `length` (preserves the previous count semantics —
   * `keeper_predicted_users` etc. — without exploding label cardinality).
   * Identity strings (`network`, addresses, …) ride on a single
   * `keeper_info{…} 1` info-style metric.
   */
  private renderPrometheus(): string {
    const snap = this.snapshot();
    const lines: string[] = [];

    const labels = Object.entries(this.info())
      .map(([k, v]) => `${snakeCase(k)}="${escapeLabel(v)}"`)
      .join(",");
    lines.push(`# HELP keeper_info Static identity of this keeper instance.`);
    lines.push(`# TYPE keeper_info gauge`);
    lines.push(`keeper_info{${labels}} 1`);

    for (const [k, v] of Object.entries(snap)) {
      if (k === "currentPrice") {
        if (v === null) continue;
        lines.push(`# HELP keeper_oracle_price_token Latest oracle price in token decimals.`);
        lines.push(`# TYPE keeper_oracle_price_token gauge`);
        lines.push(`keeper_oracle_price_token ${v}`);
        continue;
      }
      // Skip unknown values (queue empty, feed not primed, etc).
      if (v === null) continue;
      const metric = `keeper_${snakeCase(k)}`;
      // Arrays: emit length so existing dashboards (`keeper_tracked_users`,
      // `keeper_predicted_users`, …) keep working as count gauges. The
      // full address list lives in `/health` only.
      if (Array.isArray(v)) {
        lines.push(`# TYPE ${metric} gauge`);
        lines.push(`${metric} ${v.length}`);
        continue;
      }
      // String values that aren't pure integers are address-shaped or
      // similar identifiers — emit as a labelled info gauge.
      if (typeof v === "string" && !/^-?\d+$/.test(v)) {
        lines.push(`# TYPE ${metric}_info gauge`);
        lines.push(`${metric}_info{value="${escapeLabel(v)}"} 1`);
        continue;
      }
      lines.push(`# TYPE ${metric} gauge`);
      lines.push(`${metric} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Single underwater-account entry returned by `snapshot().underwater`. */
interface UnderwaterEntry {
  user: Address;
  /** `|mmSurplus|` as a decimal string — bigints don't round-trip JSON. */
  mmDeficit: string;
}

function snakeCase(camel: string): string {
  return camel.replace(/([A-Z])/g, "_$1").toLowerCase();
}

/** Escape backslashes, double quotes and newlines per the Prometheus text spec. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
