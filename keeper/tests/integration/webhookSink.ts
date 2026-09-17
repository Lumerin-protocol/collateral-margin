import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";

/**
 * Tiny HTTP sink the `Notifier` alert test posts into. Listens on port 0
 * (kernel-assigned ephemeral port) so multiple tests can run in parallel
 * without collisions, and records every JSON body it receives.
 *
 * Why local-fake rather than `nock` or similar: the keeper's `Notifier`
 * uses Node's built-in `fetch` which can't be intercepted by transport
 * mocks. A real socket server is simpler and exercises the same code path
 * the production keeper uses.
 */
export interface WebhookSink {
  url: string;
  received: ReceivedRequest[];
  stop(): Promise<void>;
}

export interface ReceivedRequest {
  body: unknown;
  /** ms-since-epoch timestamp set when the body finished arriving. */
  at: number;
}

export async function startWebhookSink(): Promise<WebhookSink> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      received.push({ body, at: Date.now() });
      res.statusCode = 204;
      res.end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("webhook sink failed to bind a TCP port");
  }
  const url = `http://127.0.0.1:${addr.port}/`;

  return {
    url,
    received,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
