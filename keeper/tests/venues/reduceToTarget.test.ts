import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { FuturesVenue } from "../../src/venues/futures.ts";
import { PerpsVenue } from "../../src/venues/perps.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const USER = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x000000000000000000000000000000000000000a" as Address;
const PME = "0x000000000000000000000000000000000000000b" as Address;
const PERPS = "0x000000000000000000000000000000000000c0de" as Address;
const FUTURES = "0x000000000000000000000000000000000000f00d" as Address;

// PME defaults: 10% IM / 5% MM, USDC 6-dec, perps qty 6-dec (real IM buffer).
const IM_SHOCK = 10n ** 17n;
const MM_SHOCK = 5n * 10n ** 16n;

interface ReadCall {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
}

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ConstructorParameters<typeof FuturesVenue>[2];

function makeConfigStub(dryRun: boolean, maxLotsPerLiquidationTx?: number): Config {
  return {
    vault: { address: VAULT },
    pme: { address: PME },
    perps: { address: PERPS },
    futures: { address: FUTURES, maxLotsPerLiquidationTx },
    coordinator: { confirmationBlocks: 1 },
    keeper: { dryRun },
  } as Config;
}

/**
 * Chain stub that serves the two snapshot round-trips (readMMParams +
 * readAccountSnapshot), the market-price / liquidation-fee reads, and records
 * the `simulateContract` call so tests can assert the batched calldata the
 * venue sizes. `dryRun: true` means `sendLiquidate` never writes a tx.
 */
function makeChainStub(opts: {
  balance: bigint;
  marketPrice: bigint;
  liquidationFee: bigint;
  perp: { netQuantity: bigint; aggregatedEntryPrice: bigint };
  futuresPositionIds: readonly Hex[];
  futuresPosition?: { buyer: Address; buyPricePerDay: bigint; sellPricePerDay: bigint };
  onSimulate: (call: ReadCall) => void;
}): Chain {
  return {
    account: { address: "0x0000000000000000000000000000000000009999" as Address },
    publicClient: {
      readContract: async (call: ReadCall) => {
        if (call.functionName === "getMarketPrice") return opts.marketPrice;
        if (call.functionName === "liquidationFee") return opts.liquidationFee;
        throw new Error(`unexpected readContract: ${call.functionName}`);
      },
      multicall: async ({ contracts }: { contracts: readonly ReadCall[] }) => {
        const fns = contracts.map((c) => c.functionName);
        // readMMParams
        if (fns[0] === "imSpotShock") return [IM_SHOCK, MM_SHOCK, 6, 6];
        // readAccountSnapshot bulk read
        if (fns[0] === "balanceOf") {
          return [
            opts.balance,
            { netQuantity: opts.perp.netQuantity, aggregatedEntryPrice: opts.perp.aggregatedEntryPrice },
            0n, // getOrderMargin
            0n, // getPendingFunding
            0n, // getFuturesOrderMargin
            opts.futuresPositionIds,
            7, // deliveryDurationDays
          ];
        }
        // readAccountSnapshot per-position hydration
        if (fns[0] === "getPositionById") {
          const p = opts.futuresPosition;
          if (p === undefined) throw new Error("no futuresPosition scripted");
          return contracts.map(() => ({
            seller: "0x0000000000000000000000000000000000005e11" as Address,
            buyer: p.buyer,
            buyPricePerDay: p.buyPricePerDay,
            sellPricePerDay: p.sellPricePerDay,
            deliveryAt: 1_756_416_000n,
          }));
        }
        throw new Error(`unexpected multicall head: ${fns[0]}`);
      },
      simulateContract: async (call: ReadCall) => {
        opts.onSimulate(call);
        return { request: { ...call } };
      },
    },
  } as unknown as Chain;
}

describe("futures venue: reduceToTarget", () => {
  it("sizes a strict worst-first lot subset and submits one liquidatePositions batch", async () => {
    // 12 long lots @ $4.21/day, $40 deposit, crash to $3.90 — underwater but
    // recoverable (mirrors the solver's in-band fixture).
    const ids: Hex[] = [];
    for (let i = 0; i < 12; i++) ids.push(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex);
    let simulated: ReadCall | undefined;
    const chain = makeChainStub({
      balance: 40_000_000n,
      marketPrice: 3_900_000n,
      liquidationFee: 1_000_000n,
      perp: { netQuantity: 0n, aggregatedEntryPrice: 0n },
      futuresPositionIds: ids,
      futuresPosition: { buyer: USER, buyPricePerDay: 4_210_000n, sellPricePerDay: 4_210_000n },
      onSimulate: (call) => {
        simulated = call;
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(true), silentLogger);
    const outcome = await venue.reduceToTarget(USER);

    assert.ok(simulated, "should simulate a liquidatePositions call");
    assert.equal(simulated?.functionName, "liquidatePositions");
    const [participant, batch] = simulated?.args as [Address, Hex[]];
    assert.equal(participant, USER);
    assert.ok(batch.length > 0 && batch.length < ids.length, "strict subset of lots");
    // dryRun → no fee, but the planner still learns how many lots closed.
    assert.ok("feeEarned" in outcome && outcome.positionsClosed === batch.length);
  });

  it("caps the batch to maxLotsPerLiquidationTx (gas-bounded chunking)", async () => {
    // 12 long lots @ $4.21/day, $40 deposit, crash to $1.00 — a deep crash the
    // solver resolves to a FULL close (all 12 ids). With a cap below 12,
    // `reduceToTarget` must send only the worst-first prefix and report
    // `positionsClosed` == cap; the planner loop drains the rest next iteration.
    const ids: Hex[] = [];
    for (let i = 0; i < 12; i++) ids.push(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex);

    // Uncapped target first, so the assertion is robust to the solver's sizing.
    let full: Hex[] = [];
    const chainFull = makeChainStub({
      balance: 40_000_000n,
      marketPrice: 1_000_000n,
      liquidationFee: 1_000_000n,
      perp: { netQuantity: 0n, aggregatedEntryPrice: 0n },
      futuresPositionIds: ids,
      futuresPosition: { buyer: USER, buyPricePerDay: 4_210_000n, sellPricePerDay: 4_210_000n },
      onSimulate: (call) => {
        full = (call.args as [Address, Hex[]])[1];
      },
    });
    await new FuturesVenue(chainFull, makeConfigStub(true), silentLogger).reduceToTarget(USER);
    assert.ok(full.length >= 2, `scenario should want ≥2 lots so the cap bites (got ${full.length})`);

    const cap = full.length - 1;
    let chunk: Hex[] = [];
    const chainCap = makeChainStub({
      balance: 40_000_000n,
      marketPrice: 1_000_000n,
      liquidationFee: 1_000_000n,
      perp: { netQuantity: 0n, aggregatedEntryPrice: 0n },
      futuresPositionIds: ids,
      futuresPosition: { buyer: USER, buyPricePerDay: 4_210_000n, sellPricePerDay: 4_210_000n },
      onSimulate: (call) => {
        chunk = (call.args as [Address, Hex[]])[1];
      },
    });
    const outcome = await new FuturesVenue(chainCap, makeConfigStub(true, cap), silentLogger).reduceToTarget(
      USER,
    );

    assert.equal(chunk.length, cap, "batch capped to maxLotsPerLiquidationTx");
    assert.deepEqual(chunk, full.slice(0, cap), "sends the worst-first prefix of the full target");
    assert.ok("feeEarned" in outcome && outcome.positionsClosed === cap);
  });

  it("skips with nothingToClose when the account is already at/above the IM buffer", async () => {
    const ids: Hex[] = [("0x" + "01".repeat(32)) as Hex];
    let simulateCalled = false;
    const chain = makeChainStub({
      balance: 1_000_000_000n, // fully collateralised
      marketPrice: 3_900_000n,
      liquidationFee: 1_000_000n,
      perp: { netQuantity: 0n, aggregatedEntryPrice: 0n },
      futuresPositionIds: ids,
      futuresPosition: { buyer: USER, buyPricePerDay: 4_210_000n, sellPricePerDay: 4_210_000n },
      onSimulate: () => {
        simulateCalled = true;
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(true), silentLogger);
    const outcome = await venue.reduceToTarget(USER);
    assert.deepEqual(outcome, { skipped: "nothingToClose" });
    assert.equal(simulateCalled, false, "no tx simulated when nothing to close");
  });
});

describe("perps venue: reduceToTarget", () => {
  it("sizes a partial closeQty and submits one liquidatePosition call", async () => {
    // Long 40 @ $4.21, $52 deposit, crash to $3.00 — underwater, partial-recoverable.
    let simulated: ReadCall | undefined;
    const chain = makeChainStub({
      balance: 52_000_000n,
      marketPrice: 3_000_000n,
      liquidationFee: 1_000_000n,
      perp: { netQuantity: 40n * 10n ** 6n, aggregatedEntryPrice: 4_210_000n },
      futuresPositionIds: [],
      onSimulate: (call) => {
        simulated = call;
      },
    });
    const venue = new PerpsVenue(chain, makeConfigStub(true), silentLogger);
    const outcome = await venue.reduceToTarget(USER);

    assert.ok(simulated, "should simulate a liquidatePosition call");
    assert.equal(simulated?.functionName, "liquidatePosition");
    const [user, closeQty] = simulated?.args as [Address, bigint];
    assert.equal(user, USER);
    assert.ok(closeQty > 0n && closeQty < 40n * 10n ** 6n, "partial close (residual remains)");
    assert.ok("feeEarned" in outcome && outcome.positionsClosed === 1);
  });

  it("skips with nothingToClose when the perps account is already healthy", async () => {
    let simulateCalled = false;
    const chain = makeChainStub({
      balance: 1_000_000_000n,
      marketPrice: 3_000_000n,
      liquidationFee: 1_000_000n,
      perp: { netQuantity: 40n * 10n ** 6n, aggregatedEntryPrice: 4_210_000n },
      futuresPositionIds: [],
      onSimulate: () => {
        simulateCalled = true;
      },
    });
    const venue = new PerpsVenue(chain, makeConfigStub(true), silentLogger);
    const outcome = await venue.reduceToTarget(USER);
    assert.deepEqual(outcome, { skipped: "nothingToClose" });
    assert.equal(simulateCalled, false);
  });
});
