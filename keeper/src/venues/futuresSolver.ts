import { Worker } from "node:worker_threads";
import type {
  AccountSnapshot,
  FuturesCloseLeg,
  MMParams,
} from "@hashpower/portfolio-margin";

export interface FuturesSolveRequest {
  id: number;
  snapshot: AccountSnapshot;
  params: MMParams;
  currentPrice: bigint;
  liquidationFee: bigint;
  now: bigint;
}

export type FuturesSolveResponse =
  | { id: number; legs: FuturesCloseLeg[] }
  | { id: number; error: string };

interface Pending {
  resolve: (legs: FuturesCloseLeg[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Runs `solveFuturesClosesToTarget` on a worker thread so a large book cannot
 * stall the keeper's event loop (health check, sweeps, delivery). A solve that
 * outlives `timeoutMs` terminates the worker and rejects; the next call starts a
 * fresh one, and the executor backs the account off like any other failure.
 */
export class FuturesCloseSolver {
  private readonly timeoutMs: number;
  private readonly workerUrl: URL;
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(
    timeoutMs: number,
    workerUrl = new URL("./futuresSolverWorker.ts", import.meta.url),
  ) {
    this.timeoutMs = timeoutMs;
    this.workerUrl = workerUrl;
  }

  solve(req: Omit<FuturesSolveRequest, "id">): Promise<FuturesCloseLeg[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(
            `futures close solver timed out after ${this.timeoutMs} ms`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...req, id } satisfies FuturesSolveRequest);
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.fail(new Error("futures close solver closed"));
    await worker?.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker !== undefined) return this.worker;
    const worker = new Worker(this.workerUrl);
    worker.unref();
    worker.on("message", (res: FuturesSolveResponse) => {
      const p = this.pending.get(res.id);
      if (p === undefined) return;
      this.pending.delete(res.id);
      clearTimeout(p.timer);
      if ("error" in res) p.reject(new Error(res.error));
      else p.resolve(res.legs);
    });
    worker.on("error", (err) => {
      if (this.worker === worker) this.fail(err);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.fail(new Error(`futures close solver exited with code ${code}`));
      }
    });
    this.worker = worker;
    return worker;
  }

  /** Reject every pending solve and drop the worker; the next solve respawns it. */
  private fail(err: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    void worker?.terminate();
  }
}
