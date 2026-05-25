import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAddress, type Address } from "viem";
import type pino from "pino";
import type { Config } from "../config.ts";
import type { ParticipantTracker } from "./tracker.ts";

/**
 * Optional Goldsky webhook ingester. Listens for indexed entity changes
 * (vault deposits, perps/futures order/position events) on a local HTTP port
 * and feeds them into the ParticipantTracker.
 *
 * Used in addition to (or instead of) RPC event subscriptions, controlled by
 * `chain.discoveryMode`:
 *   - "events"  — RPC only (default, simplest deployment)
 *   - "webhook" — Goldsky only (lowest RPC cost)
 *   - "both"    — both, deduped by the tracker's per-address Set
 *
 * Goldsky's payload shape is configurable per-pipe; we accept the most
 * flexible form below — a JSON document with a top-level `data` array
 * whose entries each carry a `user` / `participant` / `to` / `from` /
 * `seller` / `buyer` field. Anything else is ignored.
 *
 * Auth: when `WEBHOOK_SECRET` is configured, the request must carry a
 * matching `Authorization: Bearer <secret>` header. Without a configured
 * secret the endpoint is open — fine for local dev, do not deploy.
 */
export class WebhookIngester {
  private readonly config: Config;
  private readonly tracker: ParticipantTracker;
  private readonly logger: pino.Logger;
  private server: Server | undefined;

  constructor(config: Config, tracker: ParticipantTracker, logger: pino.Logger) {
    this.config = config;
    this.tracker = tracker;
    this.logger = logger.child({ component: "webhook" });
  }

  async start(): Promise<void> {
    if (this.config.chain.discoveryMode === "events") {
      this.logger.info("discoveryMode=events — webhook ingester disabled");
      return;
    }
    const port = this.config.triggers.webhookPort;
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error({ err }, "request handler threw");
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(port, () => {
        this.server!.off("error", onError);
        this.logger.info({ port }, "webhook ingester listening");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    const srv = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    this.logger.info("webhook ingester stopped");
  }

  /**
   * Visible for tests — handles a single parsed payload as if it had come in
   * over HTTP. Returns the number of users newly added to the tracker.
   */
  ingest(payload: unknown): number {
    const candidates = extractAddresses(payload);
    let added = 0;
    for (const addr of candidates) {
      if (this.tracker.add(addr)) added++;
    }
    return added;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      res.end();
      return;
    }

    if (!this.checkAuth(req)) {
      res.statusCode = 401;
      res.end();
      return;
    }

    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }

    const added = this.ingest(payload);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ added }));
  }

  private checkAuth(req: IncomingMessage): boolean {
    const expected = this.config.triggers.webhookSecret;
    if (expected === undefined || expected === "") return true;
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m === null) return false;
    return m[1] === expected;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      // Defense against pathological clients — Goldsky payloads are tiny.
      if (data.length > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Pulls every plausible address out of a webhook payload. We check several
 * common Goldsky shapes:
 *   - `{ data: [...] }` — the standard Pipe payload
 *   - `{ records: [...] }` — older Pipe schema
 *   - top-level array
 *   - top-level object containing the address fields directly
 *
 * For each record we look at `user`, `participant`, `from`, `to`, `seller`,
 * `buyer`, `liquidator`, `maker`, `taker`. Anything matching `isAddress`
 * goes into the result set; everything else is silently dropped. Returning
 * a `Set` (cast to array) gives us payload-level dedupe before the tracker
 * call.
 *
 * Exported (via `__testing`) so the unit tests can assert directly on the
 * extraction layer without standing up an HTTP server.
 */
function extractAddresses(payload: unknown): readonly Address[] {
  const found = new Set<Address>();
  const records = unwrapRecords(payload);
  const FIELDS = [
    "user",
    "participant",
    "from",
    "to",
    "seller",
    "buyer",
    "liquidator",
    "maker",
    "taker",
  ] as const;
  for (const r of records) {
    if (typeof r !== "object" || r === null) continue;
    const rec = r as Record<string, unknown>;
    for (const f of FIELDS) {
      const v = rec[f];
      if (typeof v === "string" && isAddress(v)) {
        found.add(v as Address);
      }
    }
  }
  return Array.from(found);
}

function unwrapRecords(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.records)) return obj.records;
  // Fall back to treating the whole object as one record.
  return [obj];
}

export const __testing = { extractAddresses, unwrapRecords };
