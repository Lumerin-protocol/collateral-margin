import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseAbi,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import type pino from "pino";
import { DeliveryCoordinator, __testing } from "../../src/delivery/coordinator.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const FUTURES = "0x000000000000000000000000000000000000F00d" as Address;
const VALIDATOR = "0x0000000000000000000000000000000000005a1d" as Address;
const SELLER = "0x0000000000000000000000000000000000005e11" as Address;
const BUYER = "0x0000000000000000000000000000000000000b0b" as Address;

const POSITION_A: Hex = `0x${"a".repeat(64)}`;
const POSITION_B: Hex = `0x${"b".repeat(64)}`;
const POSITION_C: Hex = `0x${"c".repeat(64)}`;

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

interface LogCall {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

/** Capturing logger for tests that assert on log severity / messages. */
function makeRecordingLogger(): { logger: pino.Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const make = (level: LogCall["level"]) => (obj: Record<string, unknown>, msg?: string) => {
    if (typeof obj === "string") calls.push({ level, obj: {}, msg: obj });
    else calls.push({ level, obj, msg: msg ?? "" });
  };
  const logger = {
    child: () => logger,
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  } as unknown as pino.Logger;
  return { logger, calls };
}

function makeConfig(overrides: Partial<Config["delivery"]> = {}): Config {
  return {
    futures: { address: FUTURES },
    keeper: { dryRun: false },
    coordinator: { confirmationBlocks: 1 },
    delivery: {
      enabled: true,
      blameSeller: true,
      sweepIntervalMs: 1_000_000,
      settleDelayMs: 0,
      bootstrapUsers: [],
      maxBatchSize: 50,
      ...overrides,
    },
  } as Config;
}

interface LotCreatedLog {
  args: {
    lotId: Hex;
    seller: Address;
    buyer: Address;
    deliveryAt: bigint;
  };
}

interface LotClosedLog {
  args: { lotId: Hex };
}

function lotCreatedLog(lotId: Hex, deliveryAt: bigint): LotCreatedLog {
  return { args: { lotId, seller: SELLER, buyer: BUYER, deliveryAt } };
}

function lotClosedLog(lotId: Hex): LotClosedLog {
  return { args: { lotId } };
}

interface ChainStubOptions {
  /** Fixed `block.timestamp`-style number returned by `getBlockNumber`. */
  blockNumber?: bigint;
  /** Value `deliveryDurationDays` returns (uint8 → number). Defaults to 7. */
  deliveryDurationDays?: number;
  /** Recorded calls to `simulateContract`. The handler is per-call so tests can vary outcomes. */
  simulate?: (args: readonly unknown[]) => { request: { ok: true } } | { error: unknown };
  writeHash?: `0x${string}`;
  receipt?: TransactionReceipt;
  /** Captures live event subscriptions so a test can flush manual logs into them. */
  watchers?: {
    lotCreated?: (logs: readonly LotCreatedLog[]) => void;
    lotClosed?: (logs: readonly LotClosedLog[]) => void;
  };
  /**
   * Historical logs returned by `getContractEvents`, keyed by event name.
   * Same logs are returned for every chunk — tests use a single chunk that
   * covers the whole window, so a per-chunk dispatcher is overkill here.
   */
  history?: {
    LotCreated?: LotCreatedLog[];
    LotClosed?: LotClosedLog[];
  };
  /**
   * View-based discovery fixtures: per-user `getPositionIds` results and
   * per-id `getPositionById` results, used by `bootstrapFromUsers` /
   * `indexUserPositions`. Missing keys default to an empty list /
   * `seller == 0` (already-closed) so a test can express "this user has
   * no positions" or "this id is closed" without populating both maps.
   */
  positionIdsByUser?: ReadonlyMap<Address, readonly Hex[]>;
  positionsById?: ReadonlyMap<Hex, { seller: Address; buyer: Address; deliveryAt: bigint }>;
  /**
   * Override `Futures.validatorAddress()` returned by the chain stub.
   * Defaults to `VALIDATOR` (matches the stub's signer) so existing tests
   * pass `start()`'s pre-flight check transparently.
   */
  validator?: Address;
}

function makeChain(opts: ChainStubOptions = {}): Chain & {
  calls: { writes: Array<readonly unknown[]>; simulates: Array<readonly unknown[]> };
} {
  const calls = {
    writes: [] as Array<readonly unknown[]>,
    simulates: [] as Array<readonly unknown[]>,
  };
  const chain = {
    account: { address: VALIDATOR } as { address: Address },
    publicClient: {
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (functionName === "deliveryDurationDays") return opts.deliveryDurationDays ?? 7;
        // start()'s pre-flight asserts the keeper signer == validator. Default
        // matches `VALIDATOR` (the chain stub's account.address), so existing
        // tests don't need to opt into anything. Set `validator: 0x...other`
        // in opts to deliberately exercise the misalignment path.
        if (functionName === "validatorAddress") return opts.validator ?? VALIDATOR;
        if (functionName === "getPositionIds") {
          const user = args?.[0] as Address | undefined;
          if (user === undefined) throw new Error("getPositionIds called without user arg");
          return opts.positionIdsByUser?.get(user) ?? [];
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      multicall: async ({
        contracts,
      }: {
        contracts: ReadonlyArray<{ functionName: string; args?: readonly unknown[] }>;
      }) => {
        return contracts.map((c) => {
          if (c.functionName === "getPositionIds") {
            const user = c.args?.[0] as Address;
            return opts.positionIdsByUser?.get(user) ?? [];
          }
          if (c.functionName === "getPositionById") {
            const id = c.args?.[0] as Hex;
            return (
              opts.positionsById?.get(id) ?? {
                // `_removePosition` deletes the slot so closed/missing
                // positions read back as the zero-initialized struct.
                seller: "0x0000000000000000000000000000000000000000" as Address,
                buyer: "0x0000000000000000000000000000000000000000" as Address,
                deliveryAt: 0n,
              }
            );
          }
          throw new Error(`unexpected multicall function: ${c.functionName}`);
        });
      },
      simulateContract: async (call: { args: readonly unknown[] }) => {
        calls.simulates.push(call.args);
        if (opts.simulate === undefined) throw new Error("test bug: simulate not configured");
        const out = opts.simulate(call.args);
        if ("error" in out) throw out.error;
        return out;
      },
      writeContract: undefined,
      waitForTransactionReceipt: async () =>
        opts.receipt ?? ({ blockNumber: 1n, logs: [] } as unknown as TransactionReceipt),
      getBlockNumber: async () => opts.blockNumber ?? 0n,
      // Sweep reads chain time from `getBlock().timestamp` (not Date.now)
      // so it agrees with the contract's window guards. Default to wall
      // clock so tests using `Date.now()`-derived `deliveryAt` still
      // see the expected ordering.
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
      // Defaults so `withUnstickRetry` (used by `attemptBatch` to recover
      // from `replacement transaction underpriced`) can run against the
      // stub without exploding. `latest == pending` means "no stuck txs"
      // → unstick is a no-op, then the original write retries.
      getTransactionCount: async () => 0,
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 100_000_000n,
      }),
      getContractEvents: async ({ eventName }: { eventName: string }) => {
        if (eventName === "LotCreated") return opts.history?.LotCreated ?? [];
        if (eventName === "LotClosed") return opts.history?.LotClosed ?? [];
        return [];
      },
      watchContractEvent: ({
        eventName,
        onLogs,
      }: {
        eventName: string;
        onLogs: (logs: readonly Log[]) => void;
      }) => {
        if (opts.watchers !== undefined) {
          if (eventName === "LotCreated") {
            opts.watchers.lotCreated = (logs) => onLogs(logs as unknown as readonly Log[]);
          } else if (eventName === "LotClosed") {
            opts.watchers.lotClosed = (logs) => onLogs(logs as unknown as readonly Log[]);
          }
        }
        return () => undefined;
      },
    },
    walletClient: {
      chain: null,
      writeContract: async (req: readonly unknown[]) => {
        calls.writes.push(req);
        return opts.writeHash ?? ("0xdeadbeef" as `0x${string}`);
      },
      // Used by unstick to send 0-value cancellation self-transfers.
      // Returns a fake hash; tests that care about cancellations
      // override this in the per-test chain object directly.
      sendTransaction: async () => "0xcafe" as `0x${string}`,
    },
    calls,
  } as unknown as Chain & {
    calls: { writes: Array<readonly unknown[]>; simulates: Array<readonly unknown[]> };
  };
  return chain;
}

const FUTURES_ABI = parseAbi([
  "error PositionDeliveryNotStartedYet()",
  "error PositionDeliveryExpired()",
  "error PositionNotExists()",
  "error OnlyValidatorOrPositionParticipant()",
  "error UnknownProblem()",
  "function closeDelivery(bytes32 positionId, bool blameSeller)",
]);

/** Build the same shape of revert viem hands `simulateContract` callers. */
function makeRevert(errorName: string): BaseError {
  const inner = new ContractFunctionRevertedError({
    abi: FUTURES_ABI,
    data: undefined,
    functionName: "closeDelivery",
  });
  (inner as unknown as { data: { errorName: string } }).data = { errorName };
  const outer = new BaseError("simulated revert");
  (outer as unknown as { cause: unknown }).cause = inner;
  return outer;
}

describe("DeliveryCoordinator: revert classification", () => {
  it("recognises the contract's settlement-window guards as recoverable", () => {
    assert.equal(
      __testing.decodeRecoverableRevert(makeRevert("PositionDeliveryNotStartedYet")),
      "PositionDeliveryNotStartedYet",
    );
    assert.equal(
      __testing.decodeRecoverableRevert(makeRevert("PositionDeliveryExpired")),
      "PositionDeliveryExpired",
    );
    assert.equal(
      __testing.decodeRecoverableRevert(makeRevert("PositionNotExists")),
      "PositionNotExists",
    );
    assert.equal(
      __testing.decodeRecoverableRevert(makeRevert("OnlyValidatorOrPositionParticipant")),
      "OnlyValidatorOrPositionParticipant",
    );
  });

  it("treats oracle freshness reverts as recoverable so the sweep retries", () => {
    assert.equal(__testing.decodeRecoverableRevert(makeRevert("OracleStale")), "OracleStale");
    assert.equal(__testing.decodeRecoverableRevert(makeRevert("InvalidOracle")), "InvalidOracle");
  });

  it("does not classify unknown reverts as recoverable", () => {
    assert.equal(__testing.decodeRecoverableRevert(makeRevert("UnknownProblem")), undefined);
    assert.equal(__testing.decodeRecoverableRevert(new Error("boom")), undefined);
  });
});

describe("DeliveryCoordinator: live event handling", () => {
  it("indexes positions on LotCreated and removes them on LotClosed", async () => {
    const watchers: ChainStubOptions["watchers"] = {};
    const chain = makeChain({ watchers });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();

    const future = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
    watchers.lotCreated?.([lotCreatedLog(POSITION_A, future)]);
    assert.equal(coordinator.size(), 1);
    assert.ok(coordinator.has(POSITION_A));

    watchers.lotClosed?.([lotClosedLog(POSITION_A)]);
    assert.equal(coordinator.size(), 0);
    coordinator.stop();
  });

  it("dedupes duplicate LotCreated for the same id (live + backfill overlap)", async () => {
    const watchers: ChainStubOptions["watchers"] = {};
    const chain = makeChain({ watchers });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();

    const future = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
    watchers.lotCreated?.([lotCreatedLog(POSITION_A, future)]);
    watchers.lotCreated?.([lotCreatedLog(POSITION_A, future)]);
    assert.equal(coordinator.size(), 1);
    coordinator.stop();
  });
});

describe("DeliveryCoordinator: settle()", () => {
  it("simulates and broadcasts closeDelivery with the configured blame side", async () => {
    let simulatedArgs: readonly unknown[] | undefined;
    const chain = makeChain({
      simulate: (args) => {
        simulatedArgs = args;
        return { request: { ok: true } };
      },
      writeHash: "0xfeed",
    });
    const coordinator = new DeliveryCoordinator(
      chain,
      makeConfig({ blameSeller: false }),
      silentLogger,
    );
    await coordinator.start();
    // Inject directly via the live watcher stub so we don't have to wait
    // on a real timer.
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);

    assert.deepEqual(simulatedArgs, [POSITION_A, false]);
    assert.equal(chain.calls.writes.length, 1);
    assert.equal(coordinator.has(POSITION_A), false, "settled position is dropped");
    coordinator.stop();
  });

  it("dryRun skips the broadcast but still drops the position from the index", async () => {
    const chain = makeChain({
      simulate: () => ({ request: { ok: true } }),
    });
    const config = makeConfig();
    (config.keeper as { dryRun: boolean }).dryRun = true;
    const coordinator = new DeliveryCoordinator(chain, config, silentLogger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });

    await coordinator.settle(POSITION_A);
    assert.equal(chain.calls.writes.length, 0, "no tx in dryRun");
    assert.equal(coordinator.has(POSITION_A), false);
    coordinator.stop();
  });

  it("drops positions on PositionDeliveryExpired (no second attempt possible)", async () => {
    const chain = makeChain({
      simulate: () => ({ error: makeRevert("PositionDeliveryExpired") }),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });

    await coordinator.settle(POSITION_A);
    assert.equal(chain.calls.writes.length, 0);
    assert.equal(coordinator.has(POSITION_A), false, "expired position is dropped");
    coordinator.stop();
  });

  it("drops positions on PositionNotExists (already settled by someone else)", async () => {
    const chain = makeChain({
      simulate: () => ({ error: makeRevert("PositionNotExists") }),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);
    assert.equal(coordinator.has(POSITION_A), false);
    coordinator.stop();
  });

  it("keeps positions on PositionDeliveryNotStartedYet (sweep will retry)", async () => {
    const chain = makeChain({
      simulate: () => ({ error: makeRevert("PositionDeliveryNotStartedYet") }),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);
    assert.equal(coordinator.has(POSITION_A), true, "still tracked — sweep retries later");
    coordinator.stop();
  });

  it("keeps positions on OnlyValidatorOrPositionParticipant (signer not validator)", async () => {
    const chain = makeChain({
      simulate: () => ({ error: makeRevert("OnlyValidatorOrPositionParticipant") }),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);
    assert.equal(coordinator.has(POSITION_A), true, "auth misconfig is recoverable");
    coordinator.stop();
  });

  it("logs unknown simulate reverts at error and skips them from the batch", async () => {
    // New batching contract: an unknown simulate revert does NOT take down
    // the keeper. Instead it's logged at error level (visible to ops) and
    // the offending position is filtered out so the rest of the batch
    // still settles. Crashing on one bad apple was the old per-id
    // behaviour and proved fragile in production — a single position with
    // weird state would unhandled-reject the setTimeout-fired settle and
    // exit the process.
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain({ simulate: () => ({ error: makeRevert("UnknownProblem") }) });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), logger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A); // must NOT throw
    const errors = calls.filter(
      (c) => c.level === "error" && /non-recoverable error/.test(c.msg),
    );
    assert.equal(errors.length, 1, "operator-visible error log");
    assert.equal(chain.calls.writes.length, 0, "no broadcast — nothing in batch");
    assert.equal(coordinator.has(POSITION_A), true, "left for next sweep to surface again");
    coordinator.stop();
  });

  it("coalesces concurrent settle() calls for the same positionId", async () => {
    // Block the first simulate via a deferred so the second call observes
    // the in-flight set before the first finishes.
    let simulateCount = 0;
    let resolveFirst: () => void = () => undefined;
    const blocker = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const chain = makeChain({
      simulate: () => {
        simulateCount++;
        return { request: { ok: true } };
      },
      writeHash: "0xfeed",
    });
    // Slow the first simulate by patching the publicClient method via a typed
    // wrapper that still satisfies viem's overloaded signature.
    const realSimulate = chain.publicClient.simulateContract.bind(chain.publicClient);
    const slowed = async (...args: unknown[]) => {
      const out = await (realSimulate as (...a: unknown[]) => Promise<unknown>)(...args);
      if (simulateCount === 1) await blocker;
      return out;
    };
    (chain.publicClient as unknown as { simulateContract: typeof slowed }).simulateContract =
      slowed;

    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });

    const first = coordinator.settle(POSITION_A);
    const second = coordinator.settle(POSITION_A);
    resolveFirst();
    await Promise.all([first, second]);

    assert.equal(simulateCount, 1, "second concurrent settle is a no-op");
    coordinator.stop();
  });
});

describe("DeliveryCoordinator: settleBatch()", () => {
  it("bundles N closeDelivery calls into one Futures.multicall(bytes[]) tx", async () => {
    // The whole point of batching: even with 3 candidates, we want exactly
    // one writeContract call (one nonce) so a concurrent manual send or a
    // stale pending tx can't cause `replacement transaction underpriced`.
    let simulateCount = 0;
    const writeArgs: unknown[] = [];
    const chain = makeChain({
      simulate: () => {
        simulateCount++;
        return { request: { ok: true } };
      },
      writeHash: "0xfeed",
    });
    const recordingWrite = async (req: unknown) => {
      writeArgs.push(req);
      return "0xfeed" as `0x${string}`;
    };
    (chain.walletClient as unknown as { writeContract: typeof recordingWrite }).writeContract =
      recordingWrite;
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    for (const id of [POSITION_A, POSITION_B, POSITION_C]) {
      coordinator["tracked"].set(id, {
        positionId: id,
        deliveryAt: 0n,
        seller: SELLER,
        buyer: BUYER,
      });
    }
    await coordinator.settleBatch([POSITION_A, POSITION_B, POSITION_C]);
    assert.equal(simulateCount, 3, "simulated each candidate to filter reverters");
    assert.equal(writeArgs.length, 1, "exactly one broadcast — one nonce, no race");
    const req = writeArgs[0] as { functionName: string; args: readonly [readonly `0x${string}`[]] };
    assert.equal(req.functionName, "multicall");
    assert.equal(req.args[0].length, 3, "three encoded closeDelivery calls in the bundle");
    for (const id of [POSITION_A, POSITION_B, POSITION_C]) {
      assert.equal(coordinator.has(id), false, `${id} dropped after multicall confirms`);
    }
    coordinator.stop();
  });

  it("filters out per-id reverters before broadcast so one bad apple can't poison the batch", async () => {
    // POSITION_B reverts in simulate (PositionNotExists); A and C are fine.
    // The multicall must contain only A and C — including B would revert
    // the entire bundle and leave A & C unsettled. Critical test.
    let simulateCount = 0;
    const writeArgs: unknown[] = [];
    const chain = makeChain({
      simulate: (args: readonly unknown[]) => {
        simulateCount++;
        if (args[0] === POSITION_B) return { error: makeRevert("PositionNotExists") };
        return { request: { ok: true } };
      },
    });
    const recordingWrite = async (req: unknown) => {
      writeArgs.push(req);
      return "0xfeed" as `0x${string}`;
    };
    (chain.walletClient as unknown as { writeContract: typeof recordingWrite }).writeContract =
      recordingWrite;
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    for (const id of [POSITION_A, POSITION_B, POSITION_C]) {
      coordinator["tracked"].set(id, {
        positionId: id,
        deliveryAt: 0n,
        seller: SELLER,
        buyer: BUYER,
      });
    }
    await coordinator.settleBatch([POSITION_A, POSITION_B, POSITION_C]);
    assert.equal(simulateCount, 3);
    assert.equal(writeArgs.length, 1, "still one broadcast for the survivors");
    const req = writeArgs[0] as { args: readonly [readonly `0x${string}`[]] };
    assert.equal(req.args[0].length, 2, "B filtered out, A + C remain");
    assert.equal(coordinator.has(POSITION_A), false);
    assert.equal(coordinator.has(POSITION_B), false, "PositionNotExists drops B from index");
    assert.equal(coordinator.has(POSITION_C), false);
    coordinator.stop();
  });

  it("treats `replacement transaction underpriced` as recoverable — does not throw", async () => {
    // The original failure mode this whole batching change is designed
    // to mitigate. Even when the underlying RPC bounces a replacement
    // tx, the keeper must not crash — the next sweep tick will retry
    // with a fresh nonce.
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain({ simulate: () => ({ request: { ok: true } }) });
    const failingWrite = async () => {
      throw new Error("replacement transaction underpriced");
    };
    (chain.walletClient as unknown as { writeContract: typeof failingWrite }).writeContract =
      failingWrite;
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), logger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settleBatch([POSITION_A]); // must NOT throw
    assert.equal(coordinator.has(POSITION_A), true, "left tracked for next sweep retry");
    const warns = calls.filter((c) => c.level === "warn" && /tx submission failed/.test(c.msg));
    assert.equal(warns.length, 1, "warned about transient submission failure");
    coordinator.stop();
  });

  it("respects DELIVERY_MAX_BATCH_SIZE by splitting large sweeps across multiple multicalls", async () => {
    // 5 candidates, batch size 2 → 3 multicalls (2 + 2 + 1).
    const writeArgs: unknown[] = [];
    const chain = makeChain({ simulate: () => ({ request: { ok: true } }) });
    const recordingWrite = async (req: unknown) => {
      writeArgs.push(req);
      return "0xfeed" as `0x${string}`;
    };
    (chain.walletClient as unknown as { writeContract: typeof recordingWrite }).writeContract =
      recordingWrite;
    const coordinator = new DeliveryCoordinator(
      chain,
      makeConfig({ maxBatchSize: 2 }),
      silentLogger,
    );
    await coordinator.start();
    // Real 32-byte hex — the production code calls `encodeFunctionData`
    // which strictly validates `bytes32` width, so test fixtures must
    // match that width or encode throws before any tx is built.
    const ids: `0x${string}`[] = [
      `0xa${"1".repeat(63)}`,
      `0xa${"2".repeat(63)}`,
      `0xa${"3".repeat(63)}`,
      `0xa${"4".repeat(63)}`,
      `0xa${"5".repeat(63)}`,
    ] as `0x${string}`[];
    // Just past delivery so sweep picks them up but the settlement window
    // (default 7d) hasn't expired — `deliveryAt: 0n` would land outside
    // the window vs. the wall-clock-based stub `getBlock()` timestamp and
    // get silently dropped before any broadcast.
    const recentlyPast = BigInt(Math.floor(Date.now() / 1000)) - 60n;
    for (const id of ids) {
      coordinator["tracked"].set(id, {
        positionId: id,
        deliveryAt: recentlyPast,
        seller: SELLER,
        buyer: BUYER,
      });
    }
    await coordinator.sweep();
    assert.equal(writeArgs.length, 3, "5 ids @ batch=2 → ceil(5/2) multicalls");
    const sizes = writeArgs.map((r) => (r as { args: [`0x${string}`[]] }).args[0].length);
    assert.deepEqual(sizes.sort(), [1, 2, 2]);
    coordinator.stop();
  });
});

describe("DeliveryCoordinator: backfill", () => {
  it("seeds the index from historical LotCreated and respects subsequent LotClosed", async () => {
    const future = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
    const chain = makeChain({
      blockNumber: 1000n,
      simulate: () => ({ request: { ok: true } }),
      writeHash: "0xfeed",
      history: {
        LotCreated: [
          lotCreatedLog(POSITION_A, future),
          lotCreatedLog(POSITION_B, future + 86_400n),
          lotCreatedLog(POSITION_C, future + 2n * 86_400n),
        ],
        // C was already closed historically — backfill should not leave it scheduled.
        LotClosed: [lotClosedLog(POSITION_C)],
      },
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();

    await coordinator.backfill(0n, 10_000n);

    assert.equal(coordinator.size(), 2);
    assert.ok(coordinator.has(POSITION_A));
    assert.ok(coordinator.has(POSITION_B));
    assert.equal(coordinator.has(POSITION_C), false);
    coordinator.stop();
  });

  it("settles past-due positions found during backfill on the immediate sweep", async () => {
    const past = BigInt(Math.floor(Date.now() / 1000)) - 60n; // 60s ago
    let simulateCount = 0;
    const chain = makeChain({
      blockNumber: 1000n,
      simulate: () => {
        simulateCount++;
        return { request: { ok: true } };
      },
      writeHash: "0xfeed",
      history: {
        LotCreated: [lotCreatedLog(POSITION_A, past)],
      },
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    await coordinator.backfill(0n, 10_000n);

    assert.equal(simulateCount, 1, "past-due position settled on backfill sweep");
    assert.equal(chain.calls.writes.length, 1);
    assert.equal(coordinator.has(POSITION_A), false);
    coordinator.stop();
  });

  it("drops positions whose entire settlement window has already expired", async () => {
    // 7 days * 86400 s + extra → window expired
    const longAgo = BigInt(Math.floor(Date.now() / 1000)) - 8n * 86_400n;
    let simulateCount = 0;
    const chain = makeChain({
      blockNumber: 1000n,
      simulate: () => {
        simulateCount++;
        return { request: { ok: true } };
      },
      writeHash: "0xfeed",
      deliveryDurationDays: 7,
      history: {
        LotCreated: [lotCreatedLog(POSITION_A, longAgo)],
      },
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    await coordinator.backfill(0n, 10_000n);

    assert.equal(simulateCount, 0, "no settlement attempted for expired window");
    assert.equal(coordinator.has(POSITION_A), false, "expired position pruned");
    coordinator.stop();
  });

  it("rejects non-positive chunkSize", async () => {
    const chain = makeChain({ blockNumber: 1000n });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    await assert.rejects(() => coordinator.backfill(0n, 0n));
    coordinator.stop();
  });
});

describe("DeliveryCoordinator: validator pre-flight", () => {
  it("start() throws when keeper signer is not Futures.validatorAddress()", async () => {
    const OTHER = "0x0000000000000000000000000000000000000001" as Address;
    const chain = makeChain({ validator: OTHER });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await assert.rejects(
      () => coordinator.start(),
      /signer is not the futures validator/i,
      "boot must fail loudly so the orchestrator restart loop pages on-call",
    );
  });

  it("start() succeeds when keeper signer matches the validator", async () => {
    const chain = makeChain({ validator: VALIDATOR });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator.stop();
  });
});

describe("DeliveryCoordinator: recoverable-revert log severity", () => {
  // The whole point of differentiated logging: at the default `info` log
  // level, an operator should *immediately* see operational misconfigs
  // (wrong validator key, missed delivery window) without having to flip
  // LOG_LEVEL=debug. Transient reverts the sweep will retry stay at debug
  // so they don't drown out everything else.

  it("errors once when the keeper signer is not the validator (page-worthy)", async () => {
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain({
      simulate: () => ({ error: makeRevert("OnlyValidatorOrPositionParticipant") }),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), logger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);
    const errors = calls.filter((c) => c.level === "error");
    assert.equal(errors.length, 1, "first occurrence is an error the operator must see");
    assert.equal(errors[0]?.obj.revert, "OnlyValidatorOrPositionParticipant");
    assert.match(errors[0]?.msg ?? "", /signer is not Futures\.validatorAddress/);
    assert.equal(coordinator.has(POSITION_A), true, "auth misconfig is recoverable; position kept");
    coordinator.stop();
  });

  it("dedupes repeated auth-failure errors to debug to avoid flooding", async () => {
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain({
      simulate: () => ({ error: makeRevert("OnlyValidatorOrPositionParticipant") }),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), logger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);
    await coordinator.settle(POSITION_A);
    await coordinator.settle(POSITION_A);
    const errors = calls.filter((c) => c.level === "error");
    assert.equal(errors.length, 1, "subsequent attempts on same position do not re-error");
  });

  it("errors once when settlement window has expired and drops the position", async () => {
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain({ simulate: () => ({ error: makeRevert("PositionDeliveryExpired") }) });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), logger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);
    const errors = calls.filter((c) => c.level === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.obj.revert, "PositionDeliveryExpired");
    assert.match(errors[0]?.msg ?? "", /settlement window already expired/);
    assert.equal(coordinator.has(POSITION_A), false, "expired window → drop");
    coordinator.stop();
  });

  it("logs at info (not error) when someone else already settled the position", async () => {
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain({ simulate: () => ({ error: makeRevert("PositionNotExists") }) });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), logger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: 0n,
      seller: SELLER,
      buyer: BUYER,
    });
    await coordinator.settle(POSITION_A);
    const infos = calls.filter((c) => c.level === "info" && c.obj.revert === "PositionNotExists");
    const loud = calls.filter((c) => c.level === "warn" || c.level === "error");
    assert.equal(infos.length, 1, "benign termination → info");
    assert.equal(loud.length, 0, "not an operator-actionable failure → no warn/error");
    coordinator.stop();
  });

  it("keeps transient reverts (NotStartedYet, OracleStale, InvalidOracle) at debug", async () => {
    for (const revert of ["PositionDeliveryNotStartedYet", "OracleStale", "InvalidOracle"]) {
      const { logger, calls } = makeRecordingLogger();
      const chain = makeChain({ simulate: () => ({ error: makeRevert(revert) }) });
      const coordinator = new DeliveryCoordinator(chain, makeConfig(), logger);
      await coordinator.start();
      coordinator["tracked"].set(POSITION_A, {
        positionId: POSITION_A,
        deliveryAt: 0n,
        seller: SELLER,
        buyer: BUYER,
      });
      await coordinator.settle(POSITION_A);
      const debugs = calls.filter((c) => c.level === "debug" && c.obj.revert === revert);
      const loud = calls.filter((c) => c.level === "warn" || c.level === "error");
      assert.ok(debugs.length >= 1, `${revert} should debug-log`);
      assert.equal(loud.length, 0, `${revert} is transient — must not warn/error`);
      coordinator.stop();
    }
  });
});

describe("DeliveryCoordinator: view-based discovery", () => {
  it("bootstrapFromUsers indexes still-alive positions and skips closed ones", async () => {
    const future = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
    const userA = "0x000000000000000000000000000000000000A11C" as Address;
    const userB = "0x000000000000000000000000000000000000b0b1" as Address;
    const chain = makeChain({
      blockNumber: 1000n,
      simulate: () => ({ request: { ok: true } }),
      writeHash: "0xfeed",
      positionIdsByUser: new Map<Address, readonly Hex[]>([
        [userA, [POSITION_A, POSITION_C]],
        [userB, [POSITION_B]],
      ]),
      positionsById: new Map([
        [POSITION_A, { seller: SELLER, buyer: userA, deliveryAt: future }],
        [POSITION_B, { seller: SELLER, buyer: userB, deliveryAt: future + 86_400n }],
        // POSITION_C: not in the map → zero-struct → seller==0 → already closed → skipped.
      ]),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();

    await coordinator.bootstrapFromUsers([userA, userB]);

    assert.equal(coordinator.size(), 2, "two live positions indexed, closed one skipped");
    assert.ok(coordinator.has(POSITION_A));
    assert.ok(coordinator.has(POSITION_B));
    assert.equal(coordinator.has(POSITION_C), false);
    coordinator.stop();
  });

  it("bootstrapFromUsers settles past-due positions on the trailing sweep", async () => {
    const past = BigInt(Math.floor(Date.now() / 1000)) - 60n;
    const user = "0x1441Bc52156Cf18c12cde6A92aE6BDE8B7f775D4" as Address;
    let simulateCount = 0;
    const chain = makeChain({
      blockNumber: 1000n,
      simulate: () => {
        simulateCount++;
        return { request: { ok: true } };
      },
      writeHash: "0xfeed",
      positionIdsByUser: new Map<Address, readonly Hex[]>([[user, [POSITION_A]]]),
      positionsById: new Map([[POSITION_A, { seller: SELLER, buyer: user, deliveryAt: past }]]),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();

    await coordinator.bootstrapFromUsers([user]);

    assert.equal(simulateCount, 1, "past-due position settled on bootstrap sweep");
    assert.equal(chain.calls.writes.length, 1);
    assert.equal(coordinator.has(POSITION_A), false);
    coordinator.stop();
  });

  it("bootstrapFromUsers is a no-op for an empty user list", async () => {
    const chain = makeChain({ blockNumber: 1000n });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();

    await coordinator.bootstrapFromUsers([]);

    assert.equal(coordinator.size(), 0);
    coordinator.stop();
  });

  it("bootstrapFromUsers does not re-index already-tracked positions", async () => {
    const future = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
    const user = "0x000000000000000000000000000000000000A11C" as Address;
    const chain = makeChain({
      blockNumber: 1000n,
      simulate: () => ({ request: { ok: true } }),
      writeHash: "0xfeed",
      positionIdsByUser: new Map<Address, readonly Hex[]>([[user, [POSITION_A]]]),
      positionsById: new Map([[POSITION_A, { seller: SELLER, buyer: user, deliveryAt: future }]]),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator["tracked"].set(POSITION_A, {
      positionId: POSITION_A,
      deliveryAt: future,
      seller: SELLER,
      buyer: user,
    });

    await coordinator.bootstrapFromUsers([user]);

    assert.equal(coordinator.size(), 1, "no duplicate entry");
    coordinator.stop();
  });

  it("indexUserPositions discovers a single user's positions", async () => {
    const future = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
    const user = "0x000000000000000000000000000000000000A11C" as Address;
    const chain = makeChain({
      blockNumber: 1000n,
      positionIdsByUser: new Map<Address, readonly Hex[]>([[user, [POSITION_A, POSITION_B]]]),
      positionsById: new Map([
        [POSITION_A, { seller: SELLER, buyer: user, deliveryAt: future }],
        [POSITION_B, { seller: SELLER, buyer: user, deliveryAt: future + 86_400n }],
      ]),
    });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();

    await coordinator.indexUserPositions(user);

    assert.equal(coordinator.size(), 2);
    assert.ok(coordinator.has(POSITION_A));
    assert.ok(coordinator.has(POSITION_B));
    coordinator.stop();
  });

  it("indexUserPositions swallows getPositionIds RPC errors instead of throwing", async () => {
    const user = "0x000000000000000000000000000000000000A11C" as Address;
    const chain = makeChain({ blockNumber: 1000n });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    // Force getPositionIds to blow up *after* startup (which uses readContract
    // for `deliveryDurationDays`). The listener path must never throw —
    // bubbling out would crash the tracker's onAdded fan-out.
    chain.publicClient.readContract = (async () => {
      throw new Error("rpc down");
    }) as unknown as typeof chain.publicClient.readContract;

    await coordinator.indexUserPositions(user);
    assert.equal(coordinator.size(), 0, "discovery error degrades silently");
    coordinator.stop();
  });
});

describe("DeliveryCoordinator: lifecycle", () => {
  it("start() is idempotent", async () => {
    const chain = makeChain({ simulate: () => ({ request: { ok: true } }) });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    await coordinator.start();
    coordinator.stop();
  });

  it("stop() is idempotent and clears all timers", async () => {
    const chain = makeChain({ simulate: () => ({ request: { ok: true } }) });
    const coordinator = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coordinator.start();
    coordinator.stop();
    coordinator.stop();
  });
});
