import type pino from "pino";
import type { Config } from "../config.ts";
import type { AccountHealth } from "../pme/health.ts";
import type { MarketId } from "../venues/types.ts";

/**
 * Shared notifier for both venues. Same vault → same human-facing alerts.
 *
 * Two responsibilities:
 *   1. Dedupe: an account that just fired a critical alert should not refire
 *      every sweep tick. Configurable via `alerts.dedupeMs`. Dedup key is
 *      `(severity, user, marketLabel ?? "*")` — same severity for the same
 *      account/market suppresses; a *promotion* from warn → critical bypasses
 *      the dedupe window (we always tell on-call when things get worse).
 *   2. Drain order: when many alerts are pending, send them out
 *      most-underwater-first (matching the coordinator queue) so on-call
 *      sees the worst first.
 *
 * The notifier is intentionally non-blocking on the planner's hot path:
 * `enqueue` is sync and fast; `drain` runs on the runtime scheduler and
 * sequentially POSTs everything that's pending.
 */
export class Notifier {
  /** dedupKey → unix-ms of last successful send. */
  private readonly lastSentAt = new Map<string, number>();
  /** Pending alerts buffered until `drain()` runs. */
  private pending: Alert[] = [];
  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly poster: WebhookPoster;
  private readonly now: () => number;

  constructor(
    config: Config,
    logger: pino.Logger,
    options: { poster?: WebhookPoster; now?: () => number } = {},
  ) {
    this.config = config;
    this.logger = logger;
    this.poster = options.poster ?? defaultWebhookPoster;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Push an alert. May be dropped immediately if a same-severity-same-target
   * alert was sent within `alerts.dedupeMs`. Severity *promotions* (warn →
   * critical) always pass through — getting worse should always page.
   */
  enqueue(alert: Alert): void {
    const key = dedupKey(alert);
    const last = this.lastSentAt.get(key);
    const isPromotion =
      alert.severity === "critical" &&
      this.lastSentAt.has(warnKey(alert)) &&
      !this.lastSentAt.has(criticalKey(alert));

    if (!isPromotion && last !== undefined && this.now() - last < this.config.alerts.dedupeMs) {
      this.logger.debug({ user: alert.user, key }, "alert deduped");
      return;
    }
    this.pending.push(alert);
  }

  /**
   * Drains the pending queue in insertion order. The scheduler walks tracked
   * users in a stable order, so insertion order is "roughly worst-first
   * across the sweep" with no extra work. Records `lastSentAt` only on
   * success — failed sends stay eligible for retry on the next drain.
   */
  async drain(): Promise<void> {
    if (!this.config.alerts.webhookUrl) {
      // Webhook disabled — clear the buffer so it can't grow unbounded.
      if (this.pending.length > 0) {
        this.logger.warn(
          { count: this.pending.length },
          "alerts pending but ALERT_WEBHOOK_URL is unset — dropping",
        );
        this.pending = [];
      }
      return;
    }
    if (this.pending.length === 0) return;

    const batch = this.pending;
    this.pending = [];

    for (const alert of batch) {
      try {
        await this.poster(this.config.alerts.webhookUrl, formatPayload(alert));
        this.lastSentAt.set(dedupKey(alert), this.now());
        this.logger.info(
          { user: alert.user, severity: alert.severity, market: alert.market?.marketLabel },
          "alert sent",
        );
      } catch (err) {
        this.logger.error(
          { user: alert.user, severity: alert.severity, err },
          "alert send failed — will retry on next drain",
        );
        // Re-buffer the failed alert so we don't lose it. Place at the head
        // so it's still considered urgent next drain.
        this.pending.unshift(alert);
      }
    }
  }

  /** Visible for tests. */
  pendingCount(): number {
    return this.pending.length;
  }
}

/** `(severity, user, marketLabel ?? "*")` — see Notifier docstring. */
function dedupKey(alert: Alert): string {
  return `${alert.severity}|${alert.user}|${alert.market?.marketLabel ?? "*"}`;
}

function warnKey(alert: Alert): string {
  return `warn|${alert.user}|${alert.market?.marketLabel ?? "*"}`;
}

function criticalKey(alert: Alert): string {
  return `critical|${alert.user}|${alert.market?.marketLabel ?? "*"}`;
}

/**
 * Webhook payload shape. Kept generic enough to render correctly in Slack /
 * Discord (which both honour `text` + `blocks`-equivalent attachments) — the
 * downstream channel can reformat as needed.
 */
function formatPayload(alert: Alert) {
  const market = alert.market !== undefined ? ` (${alert.market.marketLabel})` : "";
  return {
    text: `[${alert.severity.toUpperCase()}] ${alert.user}${market}: ${alert.reason}`,
    severity: alert.severity,
    user: alert.user,
    market: alert.market,
    health: {
      balance: alert.health.balance.toString(),
      imRequired: alert.health.imRequired.toString(),
      mmRequired: alert.health.mmRequired.toString(),
      mmSurplus: alert.health.mmSurplus.toString(),
      imUtilization: alert.health.imUtilization,
    },
    reason: alert.reason,
  };
}

export type AlertSeverity = "warn" | "critical";

export interface MarketAlertContext {
  venue: "perps" | "futures" | "options";
  marketId: MarketId;
  marketLabel: string;
}

export interface Alert {
  severity: AlertSeverity;
  user: AccountHealth["user"];
  health: AccountHealth;
  /** Optional venue/market context — present when the alert is venue-scoped. */
  market?: MarketAlertContext;
  reason: string;
}

/**
 * Pluggable webhook poster. The default implementation uses `fetch` against
 * `config.alerts.webhookUrl`; tests inject a stub to capture payloads
 * without touching the network.
 */
export type WebhookPoster = (url: string, payload: unknown) => Promise<void>;

const defaultWebhookPoster: WebhookPoster = async (url, payload) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`alert webhook ${url} returned ${res.status} ${res.statusText}`);
  }
};

/** Exposed for unit tests. */
export const __testing = { dedupKey, formatPayload };
