import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Address } from "viem";
import { BalanceMonitor } from "../../src/runtime/balanceMonitor.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const SIGNER: Address = "0x00000000000000000000000000000000000000A1";

interface LogCall {
  level: "info" | "warn" | "error";
  msg: string;
  ctx: Record<string, unknown>;
}

function makeRecordingLogger(): { logger: pino.Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record =
    (level: LogCall["level"]) =>
    (ctxOrMsg: unknown, msg?: string) => {
      if (typeof ctxOrMsg === "string") {
        calls.push({ level, msg: ctxOrMsg, ctx: {} });
      } else {
        calls.push({ level, msg: msg ?? "", ctx: ctxOrMsg as Record<string, unknown> });
      }
    };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => logger,
  } as unknown as pino.Logger;
  return { logger, calls };
}

function makeChain(getBalance: () => Promise<bigint>): Chain {
  return {
    account: { address: SIGNER },
    publicClient: {
      getBalance,
    },
    walletClient: {},
  } as unknown as Chain;
}

function makeConfig(overrides: Partial<Config["runtime"]> = {}): Config {
  return {
    runtime: {
      sweepIntervalMs: 60_000,
      healthPort: 0,
      logLevel: "info",
      balanceCheckIntervalMs: 1_000_000, // intervals never fire in tests
      balanceLowWei: 10_000_000_000_000_000n, // 10 mETH
      balanceCriticalWei: 1_000_000_000_000_000n, // 1 mETH
      ...overrides,
    },
  } as Config;
}

describe("BalanceMonitor", () => {
  it("logs INFO when balance is comfortably above the low threshold", async () => {
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain(async () => 5n * 10n ** 17n); // 0.5 ETH
    const monitor = new BalanceMonitor(chain, makeConfig(), logger);
    await monitor.check();
    monitor.stop();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.level, "info");
    assert.match(calls[0]?.msg ?? "", /balance OK/);
    // Operator-readable units in the log context — wei is too long to
    // eyeball at 4 a.m., we want both representations present.
    assert.ok(typeof calls[0]?.ctx.balanceWei === "string");
    assert.ok(typeof calls[0]?.ctx.balanceEth === "string");
  });

  it("logs WARN when balance dips below the low threshold but stays above critical", async () => {
    const { logger, calls } = makeRecordingLogger();
    // 5 mETH — between low (10) and critical (1)
    const chain = makeChain(async () => 5n * 10n ** 15n);
    const monitor = new BalanceMonitor(chain, makeConfig(), logger);
    await monitor.check();
    monitor.stop();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.level, "warn");
    assert.match(calls[0]?.msg ?? "", /balance low/);
  });

  it("logs ERROR when balance drops below the critical threshold", async () => {
    const { logger, calls } = makeRecordingLogger();
    // 0.5 mETH — well under critical (1 mETH)
    const chain = makeChain(async () => 5n * 10n ** 14n);
    const monitor = new BalanceMonitor(chain, makeConfig(), logger);
    await monitor.check();
    monitor.stop();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.level, "error");
    assert.match(calls[0]?.msg ?? "", /CRITICAL/);
  });

  it("treats a zero balance as critical", async () => {
    // Boundary check — wallet drained completely should still surface
    // as ERROR, not silently skipped because of a strict-less-than bug.
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain(async () => 0n);
    const monitor = new BalanceMonitor(chain, makeConfig(), logger);
    await monitor.check();
    monitor.stop();
    assert.equal(calls[0]?.level, "error");
  });

  it("does not throw when getBalance fails — logs a warn and returns undefined", async () => {
    // RPC blip should not take the keeper down. The monitor runs on a
    // setInterval whose unhandled rejection would crash the process.
    const { logger, calls } = makeRecordingLogger();
    const chain = makeChain(async () => {
      throw new Error("connect ETIMEDOUT alchemy");
    });
    const monitor = new BalanceMonitor(chain, makeConfig(), logger);
    const result = await monitor.check();
    monitor.stop();
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.level, "warn");
    assert.match(calls[0]?.msg ?? "", /balance check failed/);
  });

  it("start() runs an immediate check and is idempotent", async () => {
    // Eager initial check is the point — operators want a balance signal
    // at boot, not one full interval later.
    const { logger, calls } = makeRecordingLogger();
    let getBalanceCount = 0;
    const chain = makeChain(async () => {
      getBalanceCount++;
      return 1n * 10n ** 18n;
    });
    const monitor = new BalanceMonitor(chain, makeConfig(), logger);
    await monitor.start();
    await monitor.start(); // second start is a no-op, must NOT trigger another check
    monitor.stop();
    assert.equal(getBalanceCount, 1, "exactly one check on boot, second start is a no-op");
    assert.equal(calls.length, 1);
  });

  it("stop() clears the interval and is idempotent", async () => {
    const { logger } = makeRecordingLogger();
    const chain = makeChain(async () => 1n * 10n ** 18n);
    const monitor = new BalanceMonitor(chain, makeConfig(), logger);
    await monitor.start();
    monitor.stop();
    monitor.stop(); // must not throw
  });
});
