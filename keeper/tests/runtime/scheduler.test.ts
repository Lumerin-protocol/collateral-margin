import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import type pino from "pino";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import { ParticipantTracker } from "../../src/discovery/tracker.ts";
import { Notifier, type Alert, type WebhookPoster } from "../../src/alert/notifier.ts";
import type { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

function userAt(idx: number): Address {
  return getAddress(`0x${(idx + 1).toString(16).padStart(40, "0")}` as Address);
}

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

function makeConfig(opts: { warn?: number; critical?: number } = {}): Config {
  return {
    chain: { discoveryMode: "events" },
    vault: { address: userAt(100) },
    perps: { address: userAt(101) },
    futures: { address: userAt(102) },
    pme: { address: userAt(103) },
    alerts: {
      webhookUrl: "https://hooks/x",
      dedupeMs: 60_000,
      imWarnUtilization: opts.warn ?? 0.85,
      imCriticalUtilization: opts.critical ?? 0.95,
    },
    runtime: { sweepIntervalMs: 1_000_000 },
  } as Config;
}

/**
 * Stubs out only the multicall + readContract paths the scheduler needs.
 * `healthScript` returns the per-user (balance, im, mm) triples in the order
 * the multicall is built.
 */
function makeChain(opts: { healthScript: Array<{ balance: bigint; im: bigint; mm: bigint }> }): Chain {
  return {
    publicClient: {
      multicall: async ({ contracts }: { contracts: readonly unknown[] }) => {
        const userCount = contracts.length / 3;
        assert.equal(userCount, opts.healthScript.length, "script length matches user count");
        return opts.healthScript.flatMap((h) => [h.balance, h.im, h.mm]);
      },
      readContract: async () => [],
      watchContractEvent: () => () => undefined,
    },
  } as unknown as Chain;
}

function makeKickableExecutor(): { executor: CoordinatorExecutor; kicks: number } {
  let kicks = 0;
  const executor = {
    kick: () => {
      kicks++;
    },
    isRunning: () => true,
    inflightCount: () => 0,
  } as unknown as CoordinatorExecutor;
  return {
    executor,
    get kicks() {
      return kicks;
    },
  };
}

function makeRecordingPoster(): { poster: WebhookPoster; sent: Alert["severity"][] } {
  const sent: Alert["severity"][] = [];
  const poster: WebhookPoster = async (_url, payload) => {
    sent.push((payload as { severity: Alert["severity"] }).severity);
  };
  return { poster, sent };
}

describe("Scheduler.runSweep: alert ladder", () => {
  it("fires `critical` for IM utilization ≥ critical threshold", async () => {
    // balance=1000, im=950 → util 0.95 (== critical)
    const config = makeConfig({ warn: 0.85, critical: 0.95 });
    const chain = makeChain({ healthScript: [{ balance: 1000n, im: 950n, mm: 800n }] });
    const tracker = new ParticipantTracker(chain, config, silentLogger);
    tracker.add(userAt(0));
    const queue = new CoordinatorQueue();
    const { poster, sent } = makeRecordingPoster();
    const notifier = new Notifier(config, silentLogger, { poster });
    const { executor } = makeKickableExecutor();
    const scheduler = new Scheduler(chain, config, tracker, queue, executor, notifier, silentLogger);

    await scheduler.runSweep();

    assert.deepEqual(sent, ["critical"]);
  });

  it("fires `warn` for warn ≤ utilization < critical", async () => {
    const config = makeConfig({ warn: 0.85, critical: 0.95 });
    const chain = makeChain({ healthScript: [{ balance: 1000n, im: 900n, mm: 800n }] }); // util=0.9
    const tracker = new ParticipantTracker(chain, config, silentLogger);
    tracker.add(userAt(0));
    const { poster, sent } = makeRecordingPoster();
    const notifier = new Notifier(config, silentLogger, { poster });
    const { executor } = makeKickableExecutor();
    const scheduler = new Scheduler(
      chain,
      config,
      tracker,
      new CoordinatorQueue(),
      executor,
      notifier,
      silentLogger,
    );

    await scheduler.runSweep();
    assert.deepEqual(sent, ["warn"]);
  });

  it("does not alert when utilization is below the warn threshold", async () => {
    const config = makeConfig({ warn: 0.85, critical: 0.95 });
    const chain = makeChain({ healthScript: [{ balance: 1000n, im: 800n, mm: 700n }] }); // util=0.8
    const tracker = new ParticipantTracker(chain, config, silentLogger);
    tracker.add(userAt(0));
    const { poster, sent } = makeRecordingPoster();
    const notifier = new Notifier(config, silentLogger, { poster });
    const { executor } = makeKickableExecutor();
    const scheduler = new Scheduler(
      chain,
      config,
      tracker,
      new CoordinatorQueue(),
      executor,
      notifier,
      silentLogger,
    );

    await scheduler.runSweep();
    assert.deepEqual(sent, []);
  });
});

describe("Scheduler.runSweep: queue + executor wiring", () => {
  it("only enqueues underwater users — healthy ones are filtered by the queue", async () => {
    const config = makeConfig();
    const chain = makeChain({
      healthScript: [
        { balance: 1000n, im: 100n, mm: 200n }, // healthy
        { balance: 500n, im: 100n, mm: 700n }, // under
        { balance: 200n, im: 100n, mm: 800n }, // most-under
      ],
    });
    const tracker = new ParticipantTracker(chain, config, silentLogger);
    tracker.addBatch([userAt(0), userAt(1), userAt(2)]);
    const queue = new CoordinatorQueue();
    const notifier = new Notifier(config, silentLogger, { poster: async () => undefined });
    const { executor } = makeKickableExecutor();
    const scheduler = new Scheduler(chain, config, tracker, queue, executor, notifier, silentLogger);

    await scheduler.runSweep();

    assert.equal(queue.size(), 2, "healthy user dropped, only the two underwater enqueued");
    assert.equal(queue.pop()?.user, userAt(2), "most-underwater first");
    assert.equal(queue.pop()?.user, userAt(1));
  });

  it("a recovered user is removed from the queue on the next sweep", async () => {
    const config = makeConfig();
    const tracker = new ParticipantTracker(makeChain({ healthScript: [] }), config, silentLogger);
    tracker.add(userAt(0));
    const queue = new CoordinatorQueue();
    const notifier = new Notifier(config, silentLogger, { poster: async () => undefined });
    const { executor } = makeKickableExecutor();

    // First sweep — user is underwater.
    let scheduler = new Scheduler(
      makeChain({ healthScript: [{ balance: 100n, im: 100n, mm: 200n }] }),
      config,
      tracker,
      queue,
      executor,
      notifier,
      silentLogger,
    );
    await scheduler.runSweep();
    assert.equal(queue.size(), 1);

    // Second sweep — user recovered (deposit landed, price moved, etc.).
    scheduler = new Scheduler(
      makeChain({ healthScript: [{ balance: 1000n, im: 100n, mm: 100n }] }),
      config,
      tracker,
      queue,
      executor,
      notifier,
      silentLogger,
    );
    await scheduler.runSweep();
    assert.equal(queue.size(), 0, "healthy upsert removes the user from the queue");
  });

  it("kicks the executor only when at least one underwater user is found", async () => {
    const config = makeConfig();
    const chain = makeChain({
      healthScript: [{ balance: 1000n, im: 100n, mm: 200n }], // healthy
    });
    const tracker = new ParticipantTracker(chain, config, silentLogger);
    tracker.add(userAt(0));
    const tracking = makeKickableExecutor();
    const notifier = new Notifier(config, silentLogger, { poster: async () => undefined });
    const scheduler = new Scheduler(
      chain,
      config,
      tracker,
      new CoordinatorQueue(),
      tracking.executor,
      notifier,
      silentLogger,
    );
    await scheduler.runSweep();
    assert.equal(tracking.kicks, 0, "no kick when nobody is underwater");
  });

  it("kicks the executor when at least one user is underwater", async () => {
    const config = makeConfig();
    const chain = makeChain({
      healthScript: [{ balance: 100n, im: 100n, mm: 200n }], // mmSurplus = -100
    });
    const tracker = new ParticipantTracker(chain, config, silentLogger);
    tracker.add(userAt(0));
    const tracking = makeKickableExecutor();
    const notifier = new Notifier(config, silentLogger, { poster: async () => undefined });
    const scheduler = new Scheduler(
      chain,
      config,
      tracker,
      new CoordinatorQueue(),
      tracking.executor,
      notifier,
      silentLogger,
    );
    await scheduler.runSweep();
    assert.equal(tracking.kicks, 1);
  });

  it("is a no-op (no multicall, no kick) when the tracker is empty", async () => {
    const config = makeConfig();
    let multicallCalls = 0;
    const chain = {
      publicClient: {
        multicall: async () => {
          multicallCalls++;
          return [];
        },
        readContract: async () => [],
        watchContractEvent: () => () => undefined,
      },
    } as unknown as Chain;
    const tracker = new ParticipantTracker(chain, config, silentLogger);
    const tracking = makeKickableExecutor();
    const notifier = new Notifier(config, silentLogger, { poster: async () => undefined });
    const scheduler = new Scheduler(
      chain,
      config,
      tracker,
      new CoordinatorQueue(),
      tracking.executor,
      notifier,
      silentLogger,
    );
    await scheduler.runSweep();
    assert.equal(multicallCalls, 0);
    assert.equal(tracking.kicks, 0);
  });
});
