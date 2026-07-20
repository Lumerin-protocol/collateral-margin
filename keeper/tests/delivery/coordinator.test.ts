import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type pino from "pino";
import { DeliveryCoordinator, __testing } from "../../src/delivery/coordinator.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const FUTURES = "0x000000000000000000000000000000000000F00d" as Address;
const USER_A = "0x0000000000000000000000000000000000000b0b" as Address;
const USER_B = "0x0000000000000000000000000000000000005e11" as Address;
const DELIVERY_A = 1_756_416_000n;
const DELIVERY_B = 1_759_008_000n;

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

function makeConfig(overrides: Partial<Config["delivery"]> = {}): Config {
  return {
    futures: { address: FUTURES },
    keeper: { dryRun: false },
    coordinator: { confirmationBlocks: 1 },
    delivery: {
      enabled: true,
      sweepIntervalMs: 1_000_000,
      settleDelayMs: 0,
      bootstrapUsers: [],
      maxBatchSize: 50,
      ...overrides,
    },
  } as Config;
}

interface MatchedLog {
  args: {
    maker: Address;
    taker: Address;
    expirationAt: bigint;
    makerNetQtyAfter: bigint;
    takerNetQtyAfter: bigint;
  };
}

interface SettledLog {
  args: { user: Address; expirationAt: bigint };
}

function matchedLog(
  maker: Address,
  taker: Address,
  expirationAt: bigint,
  makerQty: bigint,
  takerQty: bigint,
): MatchedLog {
  return {
    args: {
      maker,
      taker,
      expirationAt,
      makerNetQtyAfter: makerQty,
      takerNetQtyAfter: takerQty,
    },
  };
}

function settledLog(user: Address, expirationAt: bigint): SettledLog {
  return { args: { user, expirationAt } };
}

interface ChainStubOptions {
  blockNumber?: bigint;
  blockTimestamp?: bigint;
  simulate?: (args: readonly unknown[]) => { request: { ok: true } } | { error: unknown };
  writeHash?: Hex;
  receipt?: TransactionReceipt;
  watchers?: {
    orderMatched?: (logs: readonly MatchedLog[]) => void;
    positionSettled?: (logs: readonly SettledLog[]) => void;
  };
  history?: {
    OrderMatched?: MatchedLog[];
    PositionSettled?: SettledLog[];
  };
  activeDatesByUser?: Record<string, readonly bigint[]>;
  positionsByUserDate?: Record<string, { netQuantity: bigint; netEntryValue: bigint }>;
  readContractError?: (functionName: string) => Error | undefined;
}

function posKey(user: Address, expirationAt: bigint): string {
  return `${user.toLowerCase()}:${expirationAt}`;
}

function makeChain(opts: ChainStubOptions = {}): Chain {
  const writeHash = opts.writeHash ?? ("0x" + "11".repeat(32) as Hex);
  const receipt = opts.receipt ?? ({
    blockNumber: 1n,
    gasUsed: 100_000n,
    effectiveGasPrice: 1n,
    status: "success",
  } as unknown as TransactionReceipt);

  return {
    account: { address: "0x0000000000000000000000000000000000009999" as Address },
    publicClient: {
      getBlockNumber: async () => opts.blockNumber ?? 100n,
      getBlock: async () => ({
        timestamp: opts.blockTimestamp ?? BigInt(Math.floor(Date.now() / 1000) + 10_000_000),
      }),
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        const err = opts.readContractError?.(functionName);
        if (err) throw err;
        if (functionName === "getActiveExpirationDates") {
          const user = (args?.[0] as Address).toLowerCase();
          return opts.activeDatesByUser?.[user] ?? [];
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      multicall: async ({
        contracts,
      }: {
        contracts: readonly { functionName: string; args?: readonly unknown[] }[];
      }) => {
        return contracts.map((c) => {
          if (c.functionName === "getUserPosition") {
            const user = (c.args?.[0] as Address).toLowerCase();
            const expirationAt = c.args?.[1] as bigint;
            const key = `${user}:${expirationAt}`;
            return (
              opts.positionsByUserDate?.[key] ?? { netQuantity: 0n, netEntryValue: 0n }
            );
          }
          if (c.functionName === "getActiveExpirationDates") {
            const user = (c.args?.[0] as Address).toLowerCase();
            return opts.activeDatesByUser?.[user] ?? [];
          }
          throw new Error(`unexpected multicall: ${c.functionName}`);
        });
      },
      getContractEvents: async ({ eventName }: { eventName: string }) => {
        if (eventName === "OrderMatched") return opts.history?.OrderMatched ?? [];
        if (eventName === "PositionSettled") return opts.history?.PositionSettled ?? [];
        return [];
      },
      watchContractEvent: ({
        eventName,
        onLogs,
      }: {
        eventName: string;
        onLogs: (logs: readonly unknown[]) => void;
      }) => {
        if (eventName === "OrderMatched" && opts.watchers) {
          opts.watchers.orderMatched = onLogs as (logs: readonly MatchedLog[]) => void;
        }
        if (eventName === "PositionSettled" && opts.watchers) {
          opts.watchers.positionSettled = onLogs as (logs: readonly SettledLog[]) => void;
        }
        return () => undefined;
      },
      simulateContract: async ({ args }: { args: readonly unknown[] }) => {
        const result = opts.simulate?.(args) ?? { request: { ok: true as const } };
        if ("error" in result) throw result.error;
        return result;
      },
      waitForTransactionReceipt: async () => receipt,
    },
    walletClient: {
      chain: null,
      writeContract: async () => writeHash,
    },
  } as unknown as Chain;
}

describe("delivery/coordinator: trackKey helpers", () => {
  it("decodeRecoverableRevert recognises PositionNotExists", () => {
    const err = new BaseError("x", {
      cause: new ContractFunctionRevertedError({
        abi: [{ type: "error", name: "PositionNotExists", inputs: [] }],
        data: "0x",
      } as never),
    });
    // viem wrapping varies — exercise the exported helper with a synthetic shape.
    const synthetic = Object.assign(new BaseError("revert"), {
      walk: (fn: (e: unknown) => unknown) => {
        const inner = new ContractFunctionRevertedError({
          abi: [{ type: "error", name: "PositionNotExists", inputs: [] }],
          data: "0x08c379a0",
        } as never);
        (inner as { data?: { errorName?: string } }).data = { errorName: "PositionNotExists" };
        return fn(inner) ? inner : null;
      },
    });
    assert.equal(__testing.decodeRecoverableRevert(synthetic), "PositionNotExists");
    void err;
  });
});

describe("delivery/coordinator: event indexing", () => {
  it("indexes maker+taker on OrderMatched and drops on PositionSettled", async () => {
    const watchers: ChainStubOptions["watchers"] = {};
    const chain = makeChain({ watchers });
    const coord = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coord.start();

    watchers.orderMatched?.([
      matchedLog(USER_A, USER_B, DELIVERY_A, -1n, 1n),
    ]);
    assert.equal(coord.size(), 2);
    assert.equal(coord.has(USER_A, DELIVERY_A), true);
    assert.equal(coord.has(USER_B, DELIVERY_A), true);

    watchers.positionSettled?.([settledLog(USER_A, DELIVERY_A)]);
    assert.equal(coord.has(USER_A, DELIVERY_A), false);
    assert.equal(coord.has(USER_B, DELIVERY_A), true);

    coord.stop();
  });

  it("drops a user when OrderMatched reports netQtyAfter=0", async () => {
    const watchers: ChainStubOptions["watchers"] = {};
    const chain = makeChain({ watchers });
    const coord = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coord.start();

    watchers.orderMatched?.([matchedLog(USER_A, USER_B, DELIVERY_A, -1n, 1n)]);
    watchers.orderMatched?.([matchedLog(USER_A, USER_B, DELIVERY_A, 0n, 0n)]);
    assert.equal(coord.has(USER_A, DELIVERY_A), false);
    assert.equal(coord.has(USER_B, DELIVERY_A), false);
    coord.stop();
  });

  it("dedupes duplicate OrderMatched for the same user+expiry", async () => {
    const watchers: ChainStubOptions["watchers"] = {};
    const chain = makeChain({ watchers });
    const coord = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coord.start();

    const log = matchedLog(USER_A, USER_B, DELIVERY_A, -1n, 1n);
    watchers.orderMatched?.([log]);
    watchers.orderMatched?.([log]);
    assert.equal(coord.size(), 2);
    coord.stop();
  });
});

describe("delivery/coordinator: bootstrap + settle", () => {
  it("bootstrapFromUsers indexes active aggregates", async () => {
    const chain = makeChain({
      activeDatesByUser: {
        [USER_A.toLowerCase()]: [DELIVERY_A, DELIVERY_B],
      },
      positionsByUserDate: {
        [posKey(USER_A, DELIVERY_A)]: { netQuantity: 1n, netEntryValue: 50n },
        [posKey(USER_A, DELIVERY_B)]: { netQuantity: -2n, netEntryValue: -100n },
      },
      // Keep sweep idle — timestamps far in the future.
      blockTimestamp: 1n,
    });
    const coord = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coord.bootstrapFromUsers([USER_A]);
    assert.equal(coord.size(), 2);
    assert.equal(coord.has(USER_A, DELIVERY_A), true);
    assert.equal(coord.has(USER_A, DELIVERY_B), true);
  });

  it("indexUserPositions swallows getActiveExpirationDates RPC errors", async () => {
    const chain = makeChain({
      readContractError: (fn) =>
        fn === "getActiveExpirationDates" ? new Error("rpc down") : undefined,
    });
    const coord = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coord.indexUserPositions(USER_A); // must not throw
    assert.equal(coord.size(), 0);
  });

  it("settleBatch simulates settlePosition(user, expirationAt) and drops on success", async () => {
    const simulated: unknown[][] = [];
    const chain = makeChain({
      // Far-future timestamp so bootstrap's trailing sweep is a no-op.
      blockTimestamp: 1n,
      simulate: (args) => {
        simulated.push([...args]);
        return { request: { ok: true } };
      },
      activeDatesByUser: { [USER_A.toLowerCase()]: [DELIVERY_A] },
      positionsByUserDate: {
        [posKey(USER_A, DELIVERY_A)]: { netQuantity: 1n, netEntryValue: 50n },
      },
    });
    const coord = new DeliveryCoordinator(chain, makeConfig({ settleDelayMs: 0 }), silentLogger);
    await coord.bootstrapFromUsers([USER_A]);
    assert.equal(coord.has(USER_A, DELIVERY_A), true);
    await coord.settle(USER_A, DELIVERY_A);
    assert.equal(simulated.length, 1);
    assert.equal(
      (simulated[0]?.[0] as string).toLowerCase(),
      USER_A.toLowerCase(),
    );
    assert.equal(simulated[0]?.[1], DELIVERY_A);
    assert.equal(coord.has(USER_A, DELIVERY_A), false);
  });

  it("backfill replays OrderMatched then PositionSettled", async () => {
    const chain = makeChain({
      blockNumber: 50n,
      history: {
        OrderMatched: [matchedLog(USER_A, USER_B, DELIVERY_A, -1n, 1n)],
        PositionSettled: [settledLog(USER_A, DELIVERY_A)],
      },
      blockTimestamp: 1n,
    });
    const coord = new DeliveryCoordinator(chain, makeConfig(), silentLogger);
    await coord.backfill(1n, 100n);
    assert.equal(coord.has(USER_A, DELIVERY_A), false);
    assert.equal(coord.has(USER_B, DELIVERY_A), true);
  });
});

describe("delivery/coordinator: isTransientTxError", () => {
  it("matches common mempool / nonce failures", () => {
    assert.equal(
      __testing.isTransientTxError(new Error("replacement transaction underpriced")),
      true,
    );
    assert.equal(__testing.isTransientTxError(new Error("nonce too low")), true);
    assert.equal(__testing.isTransientTxError(new Error("execution reverted")), false);
  });
});
