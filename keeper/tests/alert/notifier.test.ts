import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Address } from "viem";
import type pino from "pino";
import { Notifier, type Alert, type WebhookPoster } from "../../src/alert/notifier.ts";
import type { Config } from "../../src/config.ts";

const USER_A = "0x000000000000000000000000000000000000000a" as Address;
const USER_B = "0x000000000000000000000000000000000000000b" as Address;

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

function makeConfig(opts: { webhookUrl?: string; dedupeMs?: number } = {}): Config {
  return {
    alerts: {
      webhookUrl: opts.webhookUrl,
      dedupeMs: opts.dedupeMs ?? 60_000,
      imWarnUtilization: 0.85,
      imCriticalUtilization: 0.95,
    },
  } as Config;
}

function makeAlert(opts: {
  user: Address;
  severity: Alert["severity"];
  mmSurplus: bigint;
  marketLabel?: string;
  imUtil?: number;
  reason?: string;
}): Alert {
  return {
    severity: opts.severity,
    user: opts.user,
    health: {
      user: opts.user,
      balance: 1000n,
      imRequired: 100n,
      mmRequired: 1000n - opts.mmSurplus,
      mmSurplus: opts.mmSurplus,
      imUtilization: opts.imUtil ?? 0.9,
    },
    market: opts.marketLabel
      ? {
          venue: "futures",
          marketId: keccak256(toHex(opts.marketLabel)),
          marketLabel: opts.marketLabel,
        }
      : undefined,
    reason: opts.reason ?? "im threshold breached",
  };
}

/**
 * In-memory poster that records every payload. Lets tests assert on the
 * exact JSON sent without standing up an HTTP server.
 */
function makeRecordingPoster(): { poster: WebhookPoster; sent: Array<{ url: string; payload: unknown }> } {
  const sent: Array<{ url: string; payload: unknown }> = [];
  const poster: WebhookPoster = async (url, payload) => {
    sent.push({ url, payload });
  };
  return { poster, sent };
}

describe("Notifier: dedupe", () => {
  it("suppresses a same-severity alert within dedupeMs", async () => {
    const t = { now: 1_000_000 };
    const { poster, sent } = makeRecordingPoster();
    const n = new Notifier(makeConfig({ webhookUrl: "https://hooks/x", dedupeMs: 60_000 }), silentLogger, {
      poster,
      now: () => t.now,
    });
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -10n }));
    await n.drain();
    assert.equal(sent.length, 1, "first alert sends");

    t.now += 30_000; // still inside dedupe window
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -20n }));
    await n.drain();
    assert.equal(sent.length, 1, "duplicate within window dropped");

    t.now += 60_000; // window expired
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -30n }));
    await n.drain();
    assert.equal(sent.length, 2, "send again after window");
  });

  it("treats different markets for the same user as independent dedupe keys", async () => {
    const { poster, sent } = makeRecordingPoster();
    const n = new Notifier(makeConfig({ webhookUrl: "https://hooks/x" }), silentLogger, { poster });
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -10n, marketLabel: "futures 2025-08" }));
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -10n, marketLabel: "futures 2025-09" }));
    await n.drain();
    assert.equal(sent.length, 2, "per-market alerts don't dedupe each other");
  });

  it("severity promotion (warn → critical) bypasses the dedupe window", async () => {
    const t = { now: 1_000_000 };
    const { poster, sent } = makeRecordingPoster();
    const n = new Notifier(makeConfig({ webhookUrl: "https://hooks/x", dedupeMs: 60_000 }), silentLogger, {
      poster,
      now: () => t.now,
    });
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -10n }));
    await n.drain();
    t.now += 1_000; // well within dedupe window for warn
    n.enqueue(makeAlert({ user: USER_A, severity: "critical", mmSurplus: -100n }));
    await n.drain();
    assert.equal(sent.length, 2, "promotion to critical fires immediately");
  });

  it("dedupes critical-after-critical within the dedupe window (no spurious paging)", async () => {
    const t = { now: 1_000_000 };
    const { poster, sent } = makeRecordingPoster();
    const n = new Notifier(makeConfig({ webhookUrl: "https://hooks/x", dedupeMs: 60_000 }), silentLogger, {
      poster,
      now: () => t.now,
    });
    // First critical sends.
    n.enqueue(makeAlert({ user: USER_A, severity: "critical", mmSurplus: -100n }));
    await n.drain();
    assert.equal(sent.length, 1);
    // Second critical inside the window: dedupe (no warn-→-critical promotion path).
    t.now += 1_000;
    n.enqueue(makeAlert({ user: USER_A, severity: "critical", mmSurplus: -200n }));
    await n.drain();
    assert.equal(sent.length, 1, "critical re-fire inside window is suppressed");
  });
});

describe("Notifier: drain ordering", () => {
  it("drains in insertion order — caller controls priority via enqueue order", async () => {
    const { poster, sent } = makeRecordingPoster();
    const n = new Notifier(makeConfig({ webhookUrl: "https://hooks/x" }), silentLogger, { poster });
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -1n }));
    n.enqueue(makeAlert({ user: USER_B, severity: "critical", mmSurplus: -10n }));
    n.enqueue(makeAlert({ user: USER_A, severity: "critical", mmSurplus: -100n, marketLabel: "futures 2025-08" }));
    await n.drain();
    assert.equal(sent.length, 3);
    const order = sent.map((s) => (s.payload as { user: Address; severity: string }));
    assert.equal(order[0]?.user, USER_A);
    assert.equal(order[0]?.severity, "warn");
    assert.equal(order[1]?.user, USER_B);
    assert.equal(order[1]?.severity, "critical");
    assert.equal(order[2]?.user, USER_A);
    assert.equal(order[2]?.severity, "critical");
  });
});

describe("Notifier: webhook handling", () => {
  it("drops the buffer when no webhookUrl is configured (and warns)", async () => {
    const { poster, sent } = makeRecordingPoster();
    const n = new Notifier(makeConfig({ webhookUrl: undefined }), silentLogger, { poster });
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -10n }));
    assert.equal(n.pendingCount(), 1);
    await n.drain();
    assert.equal(sent.length, 0, "no posts attempted");
    assert.equal(n.pendingCount(), 0, "buffer cleared so memory doesn't grow");
  });

  it("re-buffers the failed alert at the head of the queue on POST failure", async () => {
    let attempts = 0;
    const poster: WebhookPoster = async () => {
      attempts++;
      if (attempts === 1) throw new Error("network down");
    };
    const n = new Notifier(makeConfig({ webhookUrl: "https://hooks/x" }), silentLogger, { poster });
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -10n }));
    await n.drain();
    assert.equal(n.pendingCount(), 1, "failed alert re-queued");
    await n.drain();
    assert.equal(n.pendingCount(), 0, "second drain succeeds");
    assert.equal(attempts, 2);
  });

  it("serialises bigints in the payload as decimal strings (JSON-safe)", async () => {
    const { poster, sent } = makeRecordingPoster();
    const n = new Notifier(makeConfig({ webhookUrl: "https://hooks/x" }), silentLogger, { poster });
    n.enqueue(makeAlert({ user: USER_A, severity: "warn", mmSurplus: -123n }));
    await n.drain();
    const payload = sent[0]?.payload as { health: Record<string, unknown> };
    assert.equal(typeof payload.health.balance, "string", "bigint rendered as string");
    assert.equal(payload.health.mmSurplus, "-123");
    // Round-trips through JSON.stringify without throwing TypeError.
    JSON.stringify(payload);
  });
});
