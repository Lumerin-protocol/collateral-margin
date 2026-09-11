export type BreakerState = "active" | "degraded" | "quarantined";

export interface CircuitBreakerConfig {
  /** Consecutive errors before a market is quarantined. Default 3. */
  quarantineThreshold?: number;
  /** Base backoff once quarantined (ms). Default 5s. */
  baseBackoffMs?: number;
  /** Backoff ceiling (ms). Default 3min. */
  maxBackoffMs?: number;
}

/**
 * Per-market fault isolation. Tracks consecutive failures and, past a
 * threshold, quarantines the market with exponential backoff so a persistently
 * failing expiry stops consuming cycles while its healthy siblings keep
 * quoting. A single success clears it back to `active`.
 */
export class CircuitBreaker {
  state: BreakerState = "active";
  consecutiveErrors = 0;
  lastError: unknown = null;

  private nextRetryAt = 0;
  private readonly threshold: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(cfg: CircuitBreakerConfig = {}) {
    this.threshold = cfg.quarantineThreshold ?? 3;
    this.baseBackoffMs = cfg.baseBackoffMs ?? 5_000;
    this.maxBackoffMs = cfg.maxBackoffMs ?? 180_000;
  }

  recordSuccess(): void {
    this.state = "active";
    this.consecutiveErrors = 0;
    this.lastError = null;
    this.nextRetryAt = 0;
  }

  recordError(err: unknown, now: number = Date.now()): void {
    this.consecutiveErrors++;
    this.lastError = err;
    if (this.consecutiveErrors >= this.threshold) {
      this.state = "quarantined";
      this.nextRetryAt = now + this.backoff();
    } else {
      this.state = "degraded";
    }
  }

  /** Whether the guarded work may run this cycle. */
  canAttempt(now: number = Date.now()): boolean {
    if (this.state !== "quarantined") return true;
    return now >= this.nextRetryAt;
  }

  private backoff(): number {
    const over = this.consecutiveErrors - this.threshold;
    const ms = this.baseBackoffMs * 2 ** Math.max(0, over);
    return Math.min(ms, this.maxBackoffMs);
  }
}
