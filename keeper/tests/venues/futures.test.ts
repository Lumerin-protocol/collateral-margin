import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { FuturesVenue, expirationAtMarketId } from "../../src/venues/futures.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const FUTURES = "0x000000000000000000000000000000000000F00d" as Address;
const BUYER = "0x0000000000000000000000000000000000000b0b" as Address;

interface ReadCall {
  functionName: string;
  args?: readonly unknown[];
}

interface MulticallShape {
  contracts: readonly ReadCall[];
}

function makeChainStub(opts: {
  readContract?: (call: ReadCall) => unknown;
  multicall?: (calls: readonly ReadCall[]) => readonly unknown[];
}): Chain {
  return {
    publicClient: {
      readContract: async (call: ReadCall) => opts.readContract?.(call),
      multicall: async ({ contracts }: MulticallShape) =>
        opts.multicall?.(contracts),
    },
  } as unknown as Chain;
}

function makeConfigStub(): Config {
  return {
    futures: { address: FUTURES },
    keeper: { dryRun: false },
  } as Config;
}

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ConstructorParameters<typeof FuturesVenue>[2];

const DELIVERY_AT = 1_756_416_000n;

function makeReadHandler(
  marketPrice: bigint,
  listResult: readonly unknown[],
  opts: { orderIdsByExpiry?: Record<string, readonly Hex[]> } = {},
) {
  return (call: ReadCall): unknown => {
    if (call.functionName === "getMarketPrice") return marketPrice;
    if (call.functionName === "getActiveExpirationDates") {
      return listResult;
    }
    if (call.functionName === "getExpirationDates") {
      return opts.orderIdsByExpiry === undefined
        ? []
        : Object.keys(opts.orderIdsByExpiry).map((k) => BigInt(k));
    }
    throw new Error(`unexpected readContract call: ${call.functionName}`);
  };
}

describe("futures venue: marketLabel", () => {
  it("renders expirationAt as an ISO date prefix", () => {
    const venue = new FuturesVenue(makeChainStub({}), makeConfigStub(), silentLogger);
    const id = expirationAtMarketId(DELIVERY_AT);
    assert.equal(venue.marketLabel(id), "futures 2025-08-28");
  });
});

describe("futures venue: readOpenOrders", () => {
  it("returns empty when the tradable window has no dates (no multicall)", async () => {
    let multicallCount = 0;
    const chain = makeChainStub({
      readContract: makeReadHandler(100n, []),
      multicall: () => {
        multicallCount++;
        return [];
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const orders = await venue.readOpenOrders(BUYER);
    assert.equal(orders.length, 0);
    assert.equal(multicallCount, 0, "no multicall when no tradable dates");
  });

  it("hydrates each order's expirationAt as its marketId", async () => {
    const orderIds: Hex[] = [
      "0x000000000000000000000000000000000000000000000000000000000000000a",
      "0x000000000000000000000000000000000000000000000000000000000000000b",
    ];
    const expiryB = DELIVERY_AT + 86_400n;
    let multicallStep = 0;
    const chain = makeChainStub({
      readContract: makeReadHandler(100n, [], {
        orderIdsByExpiry: {
          [DELIVERY_AT.toString()]: [orderIds[0]!],
          [expiryB.toString()]: [orderIds[1]!],
        },
      }),
      multicall: (calls) => {
        multicallStep++;
        if (multicallStep === 1) {
          assert.equal(calls.length, 2);
          for (const c of calls) assert.equal(c.functionName, "getUserOrdersAtExpiration");
          return [[orderIds[0]!], [orderIds[1]!]];
        }
        assert.equal(calls.length, 2);
        for (const c of calls) assert.equal(c.functionName, "getOrder");
        return [
          { participant: BUYER, expirationAt: DELIVERY_AT, price: 50n, quantity: 1n },
          { participant: BUYER, expirationAt: expiryB, price: 60n, quantity: -1n },
        ];
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const orders = await venue.readOpenOrders(BUYER);
    assert.equal(orders.length, 2);
    assert.equal(orders[0]?.id, orderIds[0]);
    assert.equal(orders[0]?.marketId, expirationAtMarketId(DELIVERY_AT));
    assert.equal(orders[1]?.marketId, expirationAtMarketId(expiryB));
  });
});

describe("futures venue: readPositions", () => {
  it("returns empty when getActiveExpirationDates is empty", async () => {
    const chain = makeChainStub({
      readContract: makeReadHandler(100n, []),
      multicall: () => [],
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const positions = await venue.readPositions(BUYER);
    assert.equal(positions.length, 0);
  });

  it("computes long-side underwater PnL when market drops below entry", async () => {
    const entry = 100n;
    const marketPrice = 70n;
    const chain = makeChainStub({
      readContract: makeReadHandler(marketPrice, [DELIVERY_AT]),
      multicall: (calls) => {
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.functionName, "getUserPosition");
        return [{ netQuantity: 1n, netEntryValue: entry }];
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(BUYER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, entry - marketPrice);
    assert.equal(pos.notional, entry);
    assert.equal(pos.marketId, expirationAtMarketId(DELIVERY_AT));
  });

  it("computes short-side underwater PnL when market rises above entry", async () => {
    const entry = 100n;
    const marketPrice = 130n;
    const chain = makeChainStub({
      readContract: makeReadHandler(marketPrice, [DELIVERY_AT]),
      multicall: () => [{ netQuantity: -1n, netEntryValue: -entry }],
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(BUYER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, marketPrice - entry);
    assert.equal(pos.notional, entry);
  });
});
