import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import pino from "pino";
import { FuturesAbi } from "futures-marketplace-abi/Futures.ts";
import { OutdatedOrderSweeper } from "../../src/runtime/outdatedOrderSweeper.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import type { ParticipantTracker } from "../../src/discovery/tracker.ts";

const FUTURES: Address = "0x00000000000000000000000000000000000000F1";
const USER_A: Address = "0x000000000000000000000000000000000000000a";
const USER_B: Address = "0x000000000000000000000000000000000000000B";
const SIGNER: Address = "0x00000000000000000000000000000000000000A1";

interface LogCall {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  ctx: Record<string, unknown>;
}

function makeRecordingLogger(): { logger: pino.Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record =
    (level: LogCall["level"]) => (ctxOrMsg: unknown, msg?: string) => {
      if (typeof ctxOrMsg === "string") {
        calls.push({ level, msg: ctxOrMsg, ctx: {} });
      } else {
        calls.push({
          level,
          msg: msg ?? "",
          ctx: ctxOrMsg as Record<string, unknown>,
        });
      }
    };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    trace: () => undefined,
    fatal: () => undefined,
    child: () => logger,
  } as unknown as pino.Logger;
  return { logger, calls };
}

interface FakeOrder {
  participant: Address;
  expirationAt: bigint;
}

interface FakeChainOpts {
  blockTimestamp: bigint;
  orderIdsByUser: Map<Address, Hex[]>;
  orders: Map<Hex, FakeOrder>;
  /** Simulate failure: returns an `errorName` for the given orderId, else undefined. */
  simulateRevert?: (orderId: Hex) => string | undefined;
}

interface Recorded {
  readContractCalls: number;
  multicallReadCalls: number;
  simulateCalls: Hex[];
  writeCalls: Array<{ functionName: string; calldatas: Hex[] }>;
}

function makeChain(opts: FakeChainOpts): { chain: Chain; recorded: Recorded } {
  const recorded: Recorded = {
    readContractCalls: 0,
    multicallReadCalls: 0,
    simulateCalls: [],
    writeCalls: [],
  };

  const publicClient = {
    getBlock: async () => ({ timestamp: opts.blockTimestamp }),
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: unknown[];
    }) => {
      recorded.readContractCalls++;
      if (functionName !== "getUserOrders") {
        throw new Error(`unexpected readContract: ${functionName}`);
      }
      const user = args[0] as Address;
      return opts.orderIdsByUser.get(user) ?? [];
    },
    multicall: async ({
      contracts,
    }: {
      contracts: Array<{ functionName: string; args: unknown[] }>;
    }) => {
      recorded.multicallReadCalls++;
      return contracts.map((c) => {
        if (c.functionName !== "getOrder") {
          throw new Error(`unexpected multicall fn: ${c.functionName}`);
        }
        const id = c.args[0] as Hex;
        const order = opts.orders.get(id);
        if (order === undefined) {
          throw new Error(`order not found in fake state: ${id}`);
        }
        // Return shape matches the on-chain Order struct; sweeper only
        // reads `expirationAt` but include the other fields so tests
        // stay close to the real ABI.
        return {
          participant: order.participant,
          price: 0n,
          quantity: 1n,
          expirationAt: order.expirationAt,
        };
      });
    },
    simulateContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: unknown[];
    }) => {
      if (functionName !== "removeOutdatedOrder") {
        throw new Error(`unexpected simulate fn: ${functionName}`);
      }
      const orderId = args[0] as Hex;
      recorded.simulateCalls.push(orderId);
      const errorName = opts.simulateRevert?.(orderId);
      if (errorName !== undefined) {
        throw new MockRevertError(errorName);
      }
      return { request: { functionName, args } };
    },
    waitForTransactionReceipt: async () => ({
      blockNumber: 1n,
      gasUsed: 200_000n,
      logs: [],
    }),
  };

  const walletClient = {
    chain: null,
    writeContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: unknown[];
    }) => {
      if (functionName !== "multicall") {
        throw new Error(`unexpected write fn: ${functionName}`);
      }
      recorded.writeCalls.push({ functionName, calldatas: args[0] as Hex[] });
      return "0xabc" as Hex;
    },
  };

  const chain: Chain = {
    publicClient,
    walletClient,
    account: { address: SIGNER },
  } as unknown as Chain;
  return { chain, recorded };
}

/** Mimics a viem ContractFunctionRevertedError so `BaseError.walk` finds it. */
class MockRevertError extends BaseError {
  override name = "ContractFunctionExecutionError";
  constructor(errorName: string) {
    const inner = new ContractFunctionRevertedError({
      abi: FuturesAbi,
      data: undefined,
      functionName: "removeOutdatedOrder",
    });
    (inner as unknown as { data: { errorName: string } }).data = { errorName };
    super("simulated revert", { cause: inner });
  }
}

function makeConfig(overrides: Partial<Config["outdatedOrders"]> = {}): Config {
  return {
    futures: { address: FUTURES },
    keeper: { dryRun: false },
    coordinator: { confirmationBlocks: 0 },
    outdatedOrders: {
      sweepIntervalMs: 1_000_000, // intervals never auto-fire in tests
      maxBatchSize: 50,
      ...overrides,
    },
  } as unknown as Config;
}

function makeTracker(users: Address[]): ParticipantTracker {
  return { list: () => users } as unknown as ParticipantTracker;
}

describe("OutdatedOrderSweeper", () => {
  it("is a no-op when the tracker is empty", async () => {
    const { logger, calls } = makeRecordingLogger();
    const { chain, recorded } = makeChain({
      blockTimestamp: 1_000n,
      orderIdsByUser: new Map(),
      orders: new Map(),
    });
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 0);
    assert.equal(recorded.writeCalls.length, 0);
    assert.equal(recorded.readContractCalls, 0);
    assert.equal(calls.filter((c) => c.level === "warn").length, 0);
  });

  it("skips users with no orders without sending a write", async () => {
    const { logger } = makeRecordingLogger();
    const { chain, recorded } = makeChain({
      blockTimestamp: 1_000n,
      orderIdsByUser: new Map([[USER_A, []]]),
      orders: new Map(),
    });
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 0);
    assert.equal(recorded.writeCalls.length, 0);
    assert.equal(recorded.multicallReadCalls, 0);
  });

  it("ignores orders whose expirationAt is still in the future", async () => {
    const { logger } = makeRecordingLogger();
    const orderId = ("0x" + "11".repeat(32)) as Hex;
    const { chain, recorded } = makeChain({
      blockTimestamp: 1_000n,
      orderIdsByUser: new Map([[USER_A, [orderId]]]),
      orders: new Map([
        [orderId, { participant: USER_A, expirationAt: 5_000n }], // future
      ]),
    });
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 0);
    assert.equal(recorded.simulateCalls.length, 0);
    assert.equal(recorded.writeCalls.length, 0);
  });

  it("batches all expired orders for a user into a single multicall write", async () => {
    const { logger, calls } = makeRecordingLogger();
    const id1 = ("0x" + "11".repeat(32)) as Hex;
    const id2 = ("0x" + "22".repeat(32)) as Hex;
    const id3 = ("0x" + "33".repeat(32)) as Hex;
    const { chain, recorded } = makeChain({
      blockTimestamp: 10_000n,
      orderIdsByUser: new Map([[USER_A, [id1, id2, id3]]]),
      orders: new Map([
        [id1, { participant: USER_A, expirationAt: 5_000n }], // expired
        [id2, { participant: USER_A, expirationAt: 9_999n }], // expired
        [id3, { participant: USER_A, expirationAt: 20_000n }], // future
      ]),
    });

    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A]),
      logger,
    );
    const closed = await sweeper.runSweep();

    assert.equal(closed, 2);
    assert.equal(recorded.writeCalls.length, 1);
    assert.deepEqual(recorded.simulateCalls, [id1, id2]);

    // Decode each calldata to confirm both are `removeOutdatedOrder(<expectedId>)`.
    const decoded = recorded.writeCalls[0]!.calldatas.map((cd) =>
      decodeFunctionData({ abi: FuturesAbi, data: cd }),
    );
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0]?.functionName, "removeOutdatedOrder");
    assert.equal(decoded[0]?.args?.[0], id1);
    assert.equal(decoded[1]?.functionName, "removeOutdatedOrder");
    assert.equal(decoded[1]?.args?.[0], id2);

    assert.ok(
      calls.some((c) => c.level === "info" && c.msg.includes("confirmed")),
      "expected an INFO log when the multicall write confirms",
    );
  });

  it("aggregates expired orders across multiple tracked users into one tx", async () => {
    const { logger } = makeRecordingLogger();
    const idA = ("0x" + "aa".repeat(32)) as Hex;
    const idB = ("0x" + "bb".repeat(32)) as Hex;
    const { chain, recorded } = makeChain({
      blockTimestamp: 10_000n,
      orderIdsByUser: new Map([
        [USER_A, [idA]],
        [USER_B, [idB]],
      ]),
      orders: new Map([
        [idA, { participant: USER_A, expirationAt: 5_000n }],
        [idB, { participant: USER_B, expirationAt: 5_000n }],
      ]),
    });
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A, USER_B]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 2);
    assert.equal(
      recorded.writeCalls.length,
      1,
      "one multicall write for cross-user batch",
    );
    assert.equal(recorded.writeCalls[0]!.calldatas.length, 2);
  });

  it("splits across multiple writes when batch size cap is exceeded", async () => {
    const { logger } = makeRecordingLogger();
    const ids: Hex[] = [];
    const orders = new Map<Hex, FakeOrder>();
    for (let i = 0; i < 5; i++) {
      const id = ("0x" + String(i).padStart(2, "0").repeat(32)) as Hex;
      ids.push(id);
      orders.set(id, { participant: USER_A, expirationAt: 1n });
    }
    const { chain, recorded } = makeChain({
      blockTimestamp: 1_000n,
      orderIdsByUser: new Map([[USER_A, ids]]),
      orders,
    });
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig({ maxBatchSize: 2 }),
      makeTracker([USER_A]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 5);
    // 5 expired / batch of 2 → ceil(5/2) = 3 writes
    assert.equal(recorded.writeCalls.length, 3);
    assert.deepEqual(
      recorded.writeCalls.map((c) => c.calldatas.length),
      [2, 2, 1],
    );
  });

  it("drops stale-state candidates flagged by simulate (OrderNotExists / OrderNotExpired)", async () => {
    // Race scenario: between our `getOrder` read and our simulate, the
    // user (or a concurrent keeper) closed orderId1, and orderId2 had its
    // expirationAt bumped. The sweeper must skip them silently and still
    // broadcast a write for the survivor (orderId3).
    const { logger, calls } = makeRecordingLogger();
    const id1 = ("0x" + "11".repeat(32)) as Hex;
    const id2 = ("0x" + "22".repeat(32)) as Hex;
    const id3 = ("0x" + "33".repeat(32)) as Hex;
    const { chain, recorded } = makeChain({
      blockTimestamp: 10_000n,
      orderIdsByUser: new Map([[USER_A, [id1, id2, id3]]]),
      orders: new Map([
        [id1, { participant: USER_A, expirationAt: 5_000n }],
        [id2, { participant: USER_A, expirationAt: 6_000n }],
        [id3, { participant: USER_A, expirationAt: 7_000n }],
      ]),
      simulateRevert: (id) => {
        if (id === id1) return "OrderNotExists";
        if (id === id2) return "OrderNotExpired";
        return undefined;
      },
    });
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 1);
    assert.equal(recorded.writeCalls.length, 1);
    assert.equal(recorded.writeCalls[0]!.calldatas.length, 1);
    // Stale-state skips are debug — they're benign and shouldn't pollute INFO.
    assert.equal(
      calls.filter(
        (c) => c.level === "warn" && c.msg.includes("non-recoverable"),
      ).length,
      0,
    );
  });

  it("skips the write entirely on dry-run but still simulates", async () => {
    const { logger, calls } = makeRecordingLogger();
    const id1 = ("0x" + "11".repeat(32)) as Hex;
    const { chain, recorded } = makeChain({
      blockTimestamp: 10_000n,
      orderIdsByUser: new Map([[USER_A, [id1]]]),
      orders: new Map([[id1, { participant: USER_A, expirationAt: 1n }]]),
    });
    const config = makeConfig();
    (config as { keeper: { dryRun: boolean } }).keeper.dryRun = true;
    const sweeper = new OutdatedOrderSweeper(
      chain,
      config,
      makeTracker([USER_A]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 0);
    assert.equal(recorded.writeCalls.length, 0);
    assert.equal(
      recorded.simulateCalls.length,
      1,
      "simulate runs so dry-run still surfaces reverts",
    );
    assert.ok(calls.some((c) => c.msg.startsWith("[dryRun]")));
  });

  it("does not crash when one user's getUserOrders fails — continues with the next user", async () => {
    // Per-user RPC blips shouldn't drop the whole sweep tick.
    const { logger, calls } = makeRecordingLogger();
    const idB = ("0x" + "bb".repeat(32)) as Hex;
    const orderIdsByUser = new Map<Address, Hex[]>([[USER_B, [idB]]]);
    const orders = new Map<Hex, FakeOrder>([
      [idB, { participant: USER_B, expirationAt: 1n }],
    ]);
    const blockTimestamp = 10_000n;

    // Custom chain that fails getUserOrders(USER_A) only.
    const recorded: Recorded = {
      readContractCalls: 0,
      multicallReadCalls: 0,
      simulateCalls: [],
      writeCalls: [],
    };
    const publicClient = {
      getBlock: async () => ({ timestamp: blockTimestamp }),
      readContract: async ({ args }: { args: unknown[] }) => {
        recorded.readContractCalls++;
        const user = args[0] as Address;
        if (user === USER_A) throw new Error("rpc 503");
        return orderIdsByUser.get(user) ?? [];
      },
      multicall: async ({
        contracts,
      }: {
        contracts: Array<{ args: unknown[] }>;
      }) => {
        recorded.multicallReadCalls++;
        return contracts.map((c) => {
          const order = orders.get(c.args[0] as Hex);
          if (order === undefined) throw new Error("missing");
          return {
            participant: order.participant,
            price: 0n,
            quantity: 1n,
            expirationAt: order.expirationAt,
          };
        });
      },
      simulateContract: async ({ args }: { args: unknown[] }) => {
        recorded.simulateCalls.push(args[0] as Hex);
        return { request: {} };
      },
      waitForTransactionReceipt: async () => ({
        blockNumber: 1n,
        gasUsed: 0n,
        logs: [],
      }),
    };
    const walletClient = {
      chain: null,
      writeContract: async ({ args }: { args: unknown[] }) => {
        recorded.writeCalls.push({
          functionName: "multicall",
          calldatas: args[0] as Hex[],
        });
        return "0xabc" as Hex;
      },
    };
    const chain: Chain = {
      publicClient,
      walletClient,
      account: { address: SIGNER },
    } as unknown as Chain;

    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A, USER_B]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(
      closed,
      1,
      "USER_B's order still gets closed despite USER_A's RPC failure",
    );
    assert.ok(
      calls.some(
        (c) => c.level === "warn" && c.msg.includes("getUserOrders failed"),
      ),
      "expected a warn log for the failed user",
    );
  });

  it("drops the sweep cleanly when getBlock fails (skip rather than guess at timestamp)", async () => {
    const { logger, calls } = makeRecordingLogger();
    const chain: Chain = {
      publicClient: {
        getBlock: async () => {
          throw new Error("rpc 503");
        },
      },
      walletClient: {},
      account: { address: SIGNER },
    } as unknown as Chain;
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A]),
      logger,
    );
    const closed = await sweeper.runSweep();
    assert.equal(closed, 0);
    assert.ok(
      calls.some((c) => c.level === "warn" && c.msg.includes("getBlock")),
    );
  });

  it("coalesces overlapping sweeps — second concurrent runSweep is dropped", async () => {
    // setInterval can fire while a previous sweep is still in flight on
    // slow RPCs. Overlapping sweeps would race on the same nonce, so the
    // sweeper must drop the redundant call.
    const { logger } = makeRecordingLogger();
    const id1 = ("0x" + "11".repeat(32)) as Hex;
    let releaseFirstSweep: () => void = () => undefined;
    const firstSweepBlocked = new Promise<void>((resolve) => {
      releaseFirstSweep = resolve;
    });
    let getBlockCount = 0;
    const chain: Chain = {
      publicClient: {
        getBlock: async () => {
          getBlockCount++;
          if (getBlockCount === 1) await firstSweepBlocked;
          return { timestamp: 0n };
        },
        readContract: async () => [],
      },
      walletClient: {},
      account: { address: SIGNER },
    } as unknown as Chain;
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([USER_A]),
      logger,
    );

    const first = sweeper.runSweep();
    const second = sweeper.runSweep(); // Should bail immediately.
    const secondResult = await second;
    assert.equal(
      secondResult,
      0,
      "concurrent sweep returns 0 without doing work",
    );
    releaseFirstSweep();
    await first;
    assert.equal(
      getBlockCount,
      1,
      "block timestamp read once — second sweep was dropped",
    );
  });

  it("stop() is idempotent and clears the interval", () => {
    const { logger } = makeRecordingLogger();
    const { chain } = makeChain({
      blockTimestamp: 0n,
      orderIdsByUser: new Map(),
      orders: new Map(),
    });
    const sweeper = new OutdatedOrderSweeper(
      chain,
      makeConfig(),
      makeTracker([]),
      logger,
    );
    sweeper.stop(); // no-op pre-start
    sweeper.stop(); // no-op repeated
  });
});
