import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import {
  AbiFunctionNotFoundError,
  BaseError,
  ContractFunctionRevertedError,
  encodeEventTopics,
  encodeAbiParameters,
  parseAbi,
  type Abi,
  type Address,
  type TransactionReceipt,
} from "viem";
import { __testing, sendLiquidate } from "../../src/tx/liquidate.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const silentLogger = pino({ level: "silent" });

const VENUE = "0x000000000000000000000000000000000000aa01" as Address;
const LIQUIDATOR = "0x000000000000000000000000000000000000bb01" as Address;
const TARGET_USER = "0x000000000000000000000000000000000000cc01" as Address;

const VENUE_ABI: Abi = parseAbi([
  "function liquidate(address user) returns (uint256)",
  "function liquidateOrder(address user, bytes32 orderId)",
  "event Liquidated(address indexed user, address indexed liquidator, uint256 fee)",
  "event PositionLiquidated(address indexed user, uint256 liquidatorFee)",
  "error NotLiquidatable()",
  "error OrdersStillOpen()",
  "error UnknownProblem()",
]);

function makeConfig(dryRun = false): Config {
  return {
    keeper: { dryRun },
    coordinator: { confirmationBlocks: 1 },
  } as Config;
}

interface ChainStubOptions {
  /** What `simulateContract` should do — return a request, throw the given error. */
  simulate: { request: { ok: true } } | { error: unknown };
  /** Hash to return from `writeContract` — required when simulate succeeds and dryRun is false. */
  writeHash?: `0x${string}`;
  /** Receipt fed to `waitForTransactionReceipt`. */
  receipt?: TransactionReceipt;
}

function makeChain(opts: ChainStubOptions): Chain & { calls: { writeCount: number } } {
  const calls = { writeCount: 0 };
  const chain = {
    account: { address: LIQUIDATOR } as { address: Address },
    publicClient: {
      simulateContract: async () => {
        if ("error" in opts.simulate) throw opts.simulate.error;
        return opts.simulate;
      },
      waitForTransactionReceipt: async () => opts.receipt as TransactionReceipt,
    },
    walletClient: {
      writeContract: async () => {
        calls.writeCount++;
        if (opts.writeHash === undefined) throw new Error("test bug: writeHash not provided");
        return opts.writeHash;
      },
    },
    calls,
  } as unknown as Chain & { calls: { writeCount: number } };
  return chain;
}

/**
 * Build a viem-compatible BaseError that wraps a ContractFunctionRevertedError
 * with the given errorName. `sendLiquidate` calls `err.walk()` to find it.
 */
function makeRevert(errorName: string): BaseError {
  const inner = new ContractFunctionRevertedError({
    abi: VENUE_ABI,
    data: undefined,
    functionName: "liquidate",
  });
  // Patch `data.errorName` directly — the constructor only sets it when
  // it can decode raw return data, which we don't have here.
  (inner as unknown as { data: { errorName: string } }).data = { errorName };
  const outer = new BaseError("simulated revert");
  // viem's `walk()` calls `cause` recursively; injecting our inner here is
  // the same shape `simulateContract` produces in real failures.
  (outer as unknown as { cause: unknown }).cause = inner;
  return outer;
}

/**
 * Build a real-looking receipt with N `eventName` logs whose `fee` field
 * each contributes to the summed `feeEarned`. We only have to set the
 * `topics` and `data` correctly for `parseEventLogs` to decode them —
 * everything else viem ignores.
 */
function makeReceiptWithFees(eventName: "Liquidated" | "PositionLiquidated", fees: bigint[]): TransactionReceipt {
  const logs = fees.map((fee) => {
    if (eventName === "Liquidated") {
      const topics = encodeEventTopics({
        abi: VENUE_ABI,
        eventName: "Liquidated",
        args: { user: TARGET_USER, liquidator: LIQUIDATOR },
      });
      return {
        address: VENUE,
        topics,
        data: encodeAbiParameters([{ type: "uint256" }], [fee]),
      };
    }
    const topics = encodeEventTopics({
      abi: VENUE_ABI,
      eventName: "PositionLiquidated",
      args: { user: TARGET_USER },
    });
    return {
      address: VENUE,
      topics,
      data: encodeAbiParameters([{ type: "uint256" }], [fee]),
    };
  });
  return {
    transactionHash: "0xfeed",
    logs,
    status: "success",
  } as unknown as TransactionReceipt;
}

describe("tx/liquidate: simulate-only path", () => {
  it("returns { skipped: 'notLiquidatable' } by default when simulate reverts with a recoverable error", async () => {
    const chain = makeChain({ simulate: { error: makeRevert("NotLiquidatable") } });
    const out = await sendLiquidate({
      chain,
      config: makeConfig(),
      logger: silentLogger,
      address: VENUE,
      abi: VENUE_ABI,
      functionName: "liquidate",
      args: [TARGET_USER],
      feeEventName: "Liquidated",
    });
    assert.deepEqual(out, { skipped: "notLiquidatable" });
    assert.equal(chain.calls.writeCount, 0, "writeContract must not be called on revert");
  });

  it("maps recoverable reverts via mapSkip when supplied", async () => {
    const chain = makeChain({ simulate: { error: makeRevert("OrdersStillOpen") } });
    const out = await sendLiquidate({
      chain,
      config: makeConfig(),
      logger: silentLogger,
      address: VENUE,
      abi: VENUE_ABI,
      functionName: "liquidate",
      args: [TARGET_USER],
      feeEventName: "Liquidated",
      mapSkip: (e) => (e === "OrdersStillOpen" ? ("ordersStillOpen" as const) : ("notLiquidatable" as const)),
    });
    assert.deepEqual(out, { skipped: "ordersStillOpen" });
  });

  it("rethrows unknown reverts (we should not silently swallow them)", async () => {
    const chain = makeChain({ simulate: { error: makeRevert("UnknownProblem") } });
    await assert.rejects(
      sendLiquidate({
        chain,
        config: makeConfig(),
        logger: silentLogger,
        address: VENUE,
        abi: VENUE_ABI,
        functionName: "liquidate",
        args: [TARGET_USER],
        feeEventName: "Liquidated",
      }),
    );
  });

  it("rethrows non-BaseError failures (RPC error, network, etc.)", async () => {
    const chain = makeChain({ simulate: { error: new Error("RPC down") } });
    await assert.rejects(
      sendLiquidate({
        chain,
        config: makeConfig(),
        logger: silentLogger,
        address: VENUE,
        abi: VENUE_ABI,
        functionName: "liquidate",
        args: [TARGET_USER],
        feeEventName: "Liquidated",
      }),
      /RPC down/,
    );
  });
});

describe("tx/liquidate: dry-run path", () => {
  it("logs but does NOT call writeContract when dryRun=true", async () => {
    const chain = makeChain({ simulate: { request: { ok: true } } });
    const out = await sendLiquidate({
      chain,
      config: makeConfig(true),
      logger: silentLogger,
      address: VENUE,
      abi: VENUE_ABI,
      functionName: "liquidate",
      args: [TARGET_USER],
      feeEventName: "Liquidated",
    });
    assert.deepEqual(out, { feeEarned: 0n, receipt: null });
    assert.equal(chain.calls.writeCount, 0);
  });
});

describe("tx/liquidate: broadcast + fee aggregation", () => {
  it("sums `fee` across multiple Liquidated events in a single receipt", async () => {
    const chain = makeChain({
      simulate: { request: { ok: true } },
      writeHash: "0xabcdef",
      receipt: makeReceiptWithFees("Liquidated", [1_000n, 2_500n, 100n]),
    });
    const out = await sendLiquidate({
      chain,
      config: makeConfig(false),
      logger: silentLogger,
      address: VENUE,
      abi: VENUE_ABI,
      functionName: "liquidate",
      args: [TARGET_USER],
      feeEventName: "Liquidated",
    });
    assert.ok("feeEarned" in out, "expected success outcome");
    if ("feeEarned" in out) {
      assert.equal(out.feeEarned, 3_600n);
      assert.equal(chain.calls.writeCount, 1);
    }
  });

  it("falls back to `liquidatorFee` field when `fee` is absent (PositionLiquidated)", async () => {
    const chain = makeChain({
      simulate: { request: { ok: true } },
      writeHash: "0xbeef01",
      receipt: makeReceiptWithFees("PositionLiquidated", [42n]),
    });
    const out = await sendLiquidate({
      chain,
      config: makeConfig(false),
      logger: silentLogger,
      address: VENUE,
      abi: VENUE_ABI,
      functionName: "liquidate",
      args: [TARGET_USER],
      feeEventName: "PositionLiquidated",
    });
    assert.ok("feeEarned" in out);
    if ("feeEarned" in out) assert.equal(out.feeEarned, 42n);
  });

  it("returns feeEarned=0 when feeEventName is null (orders-only leg)", async () => {
    const chain = makeChain({
      simulate: { request: { ok: true } },
      writeHash: "0xbeef02",
      receipt: makeReceiptWithFees("Liquidated", [999n]), // log present but ignored
    });
    const out = await sendLiquidate({
      chain,
      config: makeConfig(false),
      logger: silentLogger,
      address: VENUE,
      abi: VENUE_ABI,
      functionName: "liquidateOrder",
      args: [TARGET_USER, "0x" + "00".repeat(32)],
      feeEventName: null,
    });
    assert.ok("feeEarned" in out);
    if ("feeEarned" in out) assert.equal(out.feeEarned, 0n);
  });
});

describe("tx/liquidate: __testing internals", () => {
  it("decodeRecoverableRevert returns the errorName for known reverts", () => {
    assert.equal(__testing.decodeRecoverableRevert(makeRevert("NotLiquidatable")), "NotLiquidatable");
    assert.equal(__testing.decodeRecoverableRevert(makeRevert("OrdersStillOpen")), "OrdersStillOpen");
  });

  it("decodeRecoverableRevert returns undefined for unknown reverts", () => {
    assert.equal(__testing.decodeRecoverableRevert(makeRevert("UnknownProblem")), undefined);
  });

  it("decodeRecoverableRevert returns undefined for non-Base errors (RPC failure, etc.)", () => {
    assert.equal(__testing.decodeRecoverableRevert(new Error("rpc")), undefined);
    assert.equal(__testing.decodeRecoverableRevert("not even an error"), undefined);
    assert.equal(__testing.decodeRecoverableRevert(new AbiFunctionNotFoundError("foo")), undefined);
  });
});
