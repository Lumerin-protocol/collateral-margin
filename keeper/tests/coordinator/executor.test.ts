import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import type { Config } from "../../src/config.ts";
import { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import type { Planner, PlanOutcome } from "../../src/coordinator/planner.ts";
import { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import type { AccountHealth } from "../../src/pme/health.ts";

const ATTACKER = "0x00000000000000000000000000000000000000a1" as Address;
const VICTIM = "0x00000000000000000000000000000000000000b2" as Address;
const BACKOFF_BASE_MS = 50;
const BACKOFF_MAX_MS = 1_000;
const RUN_MS = 300;

function health(user: Address, mmSurplus: bigint): AccountHealth {
  return {
    user,
    balance: 1000n,
    imRequired: 100n,
    mmRequired: 1000n - mmSurplus,
    mmSurplus,
    imUtilization: 2,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CF-011 (High), also the keeper half of CF-021: when `planner.run` throws a non-recoverable
 * error (a Panic, OracleStale, an RPC failure), the executor re-queued the same account at once.
 * The queue is ordered most-underwater first, so at concurrency 1 the failing account was popped
 * again in a tight loop and every less-underwater account starved.
 */
describe("CF-011 — a permanently failing account cannot starve the executor", () => {
  it("backs off the failing account, serves the next one, then retries", async () => {
    const config = {
      coordinator: {
        maxConcurrentAccounts: 1,
        confirmationBlocks: 1,
        retryBackoffBaseMs: BACKOFF_BASE_MS,
        retryBackoffMaxMs: BACKOFF_MAX_MS,
      },
    } as unknown as Config;

    const attempts = new Map<Address, number>();
    const planner = {
      async run(user: Address): Promise<PlanOutcome> {
        attempts.set(user, (attempts.get(user) ?? 0) + 1);
        await sleep(1);
        if (user === ATTACKER) throw new Error("Panic: arithmetic overflow");
        return {
          kind: "liquidated",
          mmSurplus: 0n,
          feeEarned: 0n,
          positionsClosed: 1,
          ordersClosed: 0,
        };
      },
    } as unknown as Planner;

    const queue = new CoordinatorQueue();
    queue.upsert(health(ATTACKER, -1_000n));
    queue.upsert(health(VICTIM, -10n));

    const executor = new CoordinatorExecutor(
      config,
      queue,
      planner,
      pino({ level: "silent" }),
    );
    await executor.start();
    await sleep(RUN_MS);
    await executor.stop();

    assert.equal(
      attempts.get(VICTIM),
      1,
      "the less-underwater account must be liquidated",
    );
    const attackerAttempts = attempts.get(ATTACKER) ?? 0;
    assert.ok(
      attackerAttempts >= 2,
      "the failing account must be retried after its backoff",
    );
    assert.ok(
      attackerAttempts <=
        Math.ceil(Math.log2(RUN_MS / BACKOFF_BASE_MS + 1)) + 1,
      `the failing account must back off, got ${attackerAttempts} attempts`,
    );
  });
});
