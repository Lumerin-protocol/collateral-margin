import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseError, ContractFunctionRevertedError, getAddress, type Address } from "viem";
import type pino from "pino";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";
import { BackstopUnwinder } from "../../src/backstop/unwinder.ts";
import { BACKSTOP_ADDR } from "../../src/protocolAccounts.ts";

const FUTURES = "0x000000000000000000000000000000000000F00d" as Address;
const PERPS = "0x000000000000000000000000000000000000Fee5" as Address;
const NOW = BigInt(Math.floor(Date.now() / 1000));
const LIVE_EXPIRY = NOW + 7n * 86_400n;
const MATURED_EXPIRY = NOW - 86_400n;

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

interface Call {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
}

function makeConfig(over: Partial<Config["backstop"]> = {}): Config {
  return {
    futures: { address: FUTURES },
    perps: { address: PERPS },
    keeper: { dryRun: true },
    coordinator: { confirmationBlocks: 1 },
    backstop: { enabled: true, intervalMs: 60_000, maxQtyFutures: 0n, maxQtyPerps: 0n, ...over },
  } as unknown as Config;
}

function revert(errorName: string): BaseError {
  const inner = new ContractFunctionRevertedError({
    abi: [{ type: "error", name: errorName, inputs: [] }],
    functionName: "unwindBackstop",
    data: undefined,
  });
  (inner as unknown as { data: { errorName: string } }).data = { errorName };
  return new BaseError("reverted", { cause: inner });
}

function makeChain(state: {
  futuresLegs: Record<string, bigint>;
  perpsNet: bigint;
  simulateFails?: (call: Call) => string | undefined;
}) {
  const simulated: Call[] = [];
  const chain = {
    account: { address: "0x0000000000000000000000000000000000009999" as Address },
    publicClient: {
      readContract: async (call: Call) => {
        if (call.functionName === "getActiveExpirationDates") {
          assert.equal(getAddress(call.args?.[0] as Address), BACKSTOP_ADDR);
          return Object.keys(state.futuresLegs).map((k) => BigInt(k));
        }
        if (call.functionName === "getUserPosition" && call.address === PERPS) {
          assert.equal(getAddress(call.args?.[0] as Address), BACKSTOP_ADDR);
          return { netQuantity: state.perpsNet, netEntryValue: 0n };
        }
        throw new Error(`unexpected readContract ${call.functionName}`);
      },
      multicall: async ({ contracts }: { contracts: readonly Call[] }) =>
        contracts.map((c) => ({
          netQuantity: state.futuresLegs[String(c.args?.[1])] ?? 0n,
          netEntryValue: 0n,
        })),
      simulateContract: async (call: Call) => {
        const fail = state.simulateFails?.(call);
        if (fail !== undefined) throw revert(fail);
        simulated.push(call);
        return { request: { ...call } };
      },
    },
  } as unknown as Chain;
  return { chain, simulated };
}

describe("BackstopUnwinder", () => {
  it("sends one unwindBackstop per live futures leg and one for perps, requesting the whole leg", async () => {
    const { chain, simulated } = makeChain({
      futuresLegs: { [String(LIVE_EXPIRY)]: 7n, [String(MATURED_EXPIRY)]: -2n },
      perpsNet: -40_000_000n,
    });
    const unwinder = new BackstopUnwinder(chain, makeConfig(), silentLogger);
    await unwinder.tick();

    assert.equal(simulated.length, 2);
    const futures = simulated.find((c) => c.address === FUTURES);
    const perps = simulated.find((c) => c.address === PERPS);
    assert.deepEqual(futures?.args, [LIVE_EXPIRY, 7n], "matured leg left to settlement");
    assert.deepEqual(perps?.args, [40_000_000n], "absolute size, side chosen on-chain");
    assert.ok(simulated.every((c) => c.functionName === "unwindBackstop"));

    const stats = unwinder.snapshot();
    assert.equal(stats.ticks, 1);
    assert.equal(stats.unwinds, 2, "dry-run counts as sent");
    assert.equal(stats.legs.length, 3, "matured leg still reported");
  });

  it("caps the requested quantity per venue", async () => {
    const { chain, simulated } = makeChain({
      futuresLegs: { [String(LIVE_EXPIRY)]: -10n },
      perpsNet: 5_000_000n,
    });
    const unwinder = new BackstopUnwinder(
      chain,
      makeConfig({ maxQtyFutures: 3n, maxQtyPerps: 1_000_000n }),
      silentLogger,
    );
    await unwinder.tick();
    assert.deepEqual(simulated.find((c) => c.address === FUTURES)?.args, [LIVE_EXPIRY, 3n]);
    assert.deepEqual(simulated.find((c) => c.address === PERPS)?.args, [1_000_000n]);
  });

  it("does nothing when the backstop is flat everywhere", async () => {
    const { chain, simulated } = makeChain({ futuresLegs: {}, perpsNet: 0n });
    const unwinder = new BackstopUnwinder(chain, makeConfig(), silentLogger);
    await unwinder.tick();
    assert.equal(simulated.length, 0);
    assert.deepEqual(unwinder.snapshot().legs, []);
  });

  it("treats TimeInForceNotFilled as 'no liquidity' and keeps going", async () => {
    const { chain, simulated } = makeChain({
      futuresLegs: { [String(LIVE_EXPIRY)]: 4n },
      perpsNet: 1n,
      simulateFails: (call) => (call.address === FUTURES ? "TimeInForceNotFilled" : undefined),
    });
    const unwinder = new BackstopUnwinder(chain, makeConfig(), silentLogger);
    await unwinder.tick();
    assert.equal(simulated.length, 1, "perps still attempted");
    assert.equal(simulated[0]?.address, PERPS);
    const stats = unwinder.snapshot();
    assert.equal(stats.unfilled, 1);
    assert.equal(stats.unwinds, 1);
  });
});
