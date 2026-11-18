import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { getAddress, keccak256, toHex, type Address } from "viem";
import { Notifier } from "../../src/alert/notifier.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import { CoordinatorExecutor } from "../../src/coordinator/executor.ts";
import { Planner } from "../../src/coordinator/planner.ts";
import { CoordinatorQueue } from "../../src/coordinator/queue.ts";
import { ParticipantTracker } from "../../src/discovery/tracker.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import type { Venue, VenuePosition } from "../../src/venues/types.ts";

const USDC = 1_000_000n;
const USER = getAddress("0x00000000000000000000000000000000000000d1");
const MARKET_PERPS = keccak256(toHex("perps"));

function addr(idx: number): Address {
  return getAddress(`0x${(idx + 1).toString(16).padStart(40, "0")}`);
}

interface Health {
  balance: bigint;
  im: bigint;
  mm: bigint;
}

function makeConfig(): Config {
  return {
    vault: { address: addr(100) },
    perps: { address: addr(101) },
    futures: { address: addr(102) },
    pme: { address: addr(103) },
    keeper: { dryRun: false },
    coordinator: {
      maxConcurrentAccounts: 1,
      maxOrdersPerLiquidationTx: 50,
      retryBackoffBaseMs: 50,
      retryBackoffMaxMs: 1_000,
    },
    alerts: {
      webhookUrl: "https://hooks/x",
      dedupeMs: 60_000,
      imWarnUtilization: 0.85,
      imCriticalUtilization: 0.95,
    },
    runtime: { sweepIntervalMs: 1_000_000 },
  } as unknown as Config;
}

/** Answers every (balance, IM, MM) triple of the health multicall from `health()`. */
function makeChain(health: () => Health): Chain {
  return {
    publicClient: {
      multicall: async ({ contracts }: { contracts: readonly unknown[] }) =>
        Array.from({ length: contracts.length / 3 }, () => {
          const h = health();
          return [h.balance, h.im, h.mm];
        })
          .flat()
          .map((result) => ({ status: "success", result })),
      readContract: async () => [],
      watchContractEvent: () => () => undefined,
    },
  } as unknown as Chain;
}

/** Records every log line, as CloudWatch receives them. */
function captureLogs() {
  const lines: { level: number; msg: string }[] = [];
  const logger = pino(
    { level: "debug" },
    { write: (line: string) => lines.push(JSON.parse(line)) },
  );
  return {
    logger,
    errors: () => lines.filter((l) => l.level >= pino.levels.values.error),
  };
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error("the executor never ran the plan");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The production loop: periodic sweep → coordinator queue → executor → planner. */
async function startKeeper(chain: Chain, venue: Venue, logger: pino.Logger) {
  const config = makeConfig();
  const tracker = new ParticipantTracker(chain, config, logger);
  tracker.add(USER);
  const queue = new CoordinatorQueue();
  const planner = new Planner(chain, config, [venue], logger);
  let plans = 0;
  const run = planner.run.bind(planner);
  planner.run = async (user) => {
    try {
      return await run(user);
    } finally {
      plans++;
    }
  };
  const executor = new CoordinatorExecutor(config, queue, planner, logger);
  const notifier = new Notifier(config, logger, {
    poster: async () => undefined,
  });
  const scheduler = new Scheduler(
    chain,
    config,
    tracker,
    queue,
    executor,
    notifier,
    logger,
  );
  await executor.start();
  return {
    /** One periodic sweep, then wait until the executor has run the plan it queued. */
    async sweep() {
      const before = plans;
      await scheduler.runSweep();
      await until(() => plans > before);
    },
    stop: () => executor.stop(),
  };
}

/**
 * N4 (review, Medium): since CF-665 a liquidation that leaves a shortfall records it as account
 * debt, which the engine adds to IM and MM. The flat account stays under MM for good, so every
 * 60 s sweep re-planned it and logged `BadDebt` at error level twice. The keeper-errors alarm
 * (one error-level line in 5 minutes, pages on prd) then stayed in ALARM, and CloudWatch, which
 * notifies only on state changes, never paged for a later keeper error.
 */
describe("N4 — a standing bad debt does not keep the keeper error alarm firing", () => {
  it("logs the liquidation that leaves the debt, then stays quiet on later sweeps", async () => {
    let flat = false;
    const position: VenuePosition = {
      id: keccak256(toHex("perps-position")),
      marketId: MARKET_PERPS,
      unrealizedLoss: 600n * USDC,
      notional: 2_000n * USDC,
    };
    // The close loses 600 against a 100 balance: the account ends flat with 500 of debt,
    // its whole requirement.
    const chain = makeChain(() =>
      flat
        ? { balance: 0n, im: 500n * USDC, mm: 500n * USDC }
        : { balance: 100n * USDC, im: 800n * USDC, mm: 700n * USDC },
    );
    let closes = 0;
    const venue: Venue = {
      name: "perps",
      marketLabel: () => "perps",
      readOpenOrders: async () => [],
      readPositions: async () => (flat ? [] : [position]),
      liquidateOrders: async () => ({ feeEarned: 0n }),
      reduceToTarget: async () => {
        closes++;
        flat = true;
        return { feeEarned: 0n, positionsClosed: 1 };
      },
    };
    const logs = captureLogs();
    const keeper = await startKeeper(chain, venue, logs.logger);
    try {
      await keeper.sweep();
      assert.equal(closes, 1, "the keeper closes the position");
      assert.ok(
        logs.errors().some((l) => l.msg.includes("BadDebt")),
        "the liquidation that leaves the debt is logged at error level, so it pages",
      );
      const errorsAfterLiquidation = logs.errors().length;

      await keeper.sweep();
      await keeper.sweep();
      assert.equal(closes, 1, "nothing is left to close");
      assert.deepEqual(
        logs
          .errors()
          .slice(errorsAfterLiquidation)
          .map((l) => l.msg),
        [],
        "later sweeps of the flat, indebted account must log no errors, or the alarm stays in ALARM and hides every later keeper error",
      );
    } finally {
      await keeper.stop();
    }
  });
});
