import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { FuturesVenue, deliveryAtMarketId } from "../../src/venues/futures.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const FUTURES = "0x000000000000000000000000000000000000F00d" as Address;
const BUYER = "0x0000000000000000000000000000000000000b0b" as Address;
const SELLER = "0x0000000000000000000000000000000000005e11" as Address;

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

const DELIVERY_AT = 1_756_416_000n; // 2025-08-28T18:40:00Z (slice(0,10) → "2025-08-28")
const DELIVERY_DURATION_DAYS = 7n;

/** Reusable stub: deliveryDurationDays + market price + (positionIds | orderIds) reads. */
function makeReadHandler(deliveryDurationDays: bigint, marketPrice: bigint, listResult: readonly Hex[]) {
  return (call: ReadCall): unknown => {
    if (call.functionName === "deliveryDurationDays") return Number(deliveryDurationDays);
    if (call.functionName === "getMarketPrice") return marketPrice;
    if (call.functionName === "getOrderIds" || call.functionName === "getPositionIds") return listResult;
    throw new Error(`unexpected readContract call: ${call.functionName}`);
  };
}

describe("futures venue: marketLabel", () => {
  it("renders deliveryAt as an ISO date prefix", () => {
    const venue = new FuturesVenue(makeChainStub({}), makeConfigStub(), silentLogger);
    const id = deliveryAtMarketId(DELIVERY_AT);
    assert.equal(venue.marketLabel(id), "futures 2025-08-28");
  });
});

describe("futures venue: readOpenOrders", () => {
  it("returns empty when getOrderIds is empty (no extra multicall)", async () => {
    let multicallCount = 0;
    const chain = makeChainStub({
      readContract: makeReadHandler(DELIVERY_DURATION_DAYS, 100n, []),
      multicall: () => {
        multicallCount++;
        return [];
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const orders = await venue.readOpenOrders(BUYER);
    assert.equal(orders.length, 0);
    assert.equal(multicallCount, 0, "no multicall when no orders");
  });

  it("hydrates each order's deliveryAt as its marketId", async () => {
    const orderIds: Hex[] = [
      "0x000000000000000000000000000000000000000000000000000000000000000a",
      "0x000000000000000000000000000000000000000000000000000000000000000b",
    ];
    const chain = makeChainStub({
      readContract: makeReadHandler(DELIVERY_DURATION_DAYS, 100n, orderIds),
      multicall: (calls) => {
        // One getOrderById per order id, in order.
        assert.equal(calls.length, 2);
        for (const c of calls) assert.equal(c.functionName, "getOrderById");
        return [
          { isBuy: true, participant: BUYER, deliveryAt: DELIVERY_AT, pricePerDay: 50n },
          { isBuy: false, participant: BUYER, deliveryAt: DELIVERY_AT + 86_400n, pricePerDay: 60n },
        ];
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const orders = await venue.readOpenOrders(BUYER);
    assert.equal(orders.length, 2);
    assert.equal(orders[0]?.id, orderIds[0]);
    assert.equal(orders[0]?.marketId, deliveryAtMarketId(DELIVERY_AT));
    assert.equal(orders[1]?.marketId, deliveryAtMarketId(DELIVERY_AT + 86_400n));
  });
});

describe("futures venue: readPositions", () => {
  it("returns empty when getPositionIds is empty", async () => {
    const chain = makeChainStub({
      readContract: makeReadHandler(DELIVERY_DURATION_DAYS, 100n, []),
      multicall: () => [],
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const positions = await venue.readPositions(BUYER);
    assert.equal(positions.length, 0);
  });

  it("computes long-side underwater PnL for a buyer when market drops below entry", async () => {
    const positionIds: Hex[] = ["0x" + "11".repeat(32) as Hex];
    const buyPx = 100n;
    const sellPx = 100n;
    const marketPrice = 70n; // long → loses (100-70)*7days = 210 per contract
    const chain = makeChainStub({
      readContract: makeReadHandler(DELIVERY_DURATION_DAYS, marketPrice, positionIds),
      multicall: (calls) => {
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.functionName, "getPositionById");
        return [
          {
            seller: SELLER,
            buyer: BUYER,
            buyPricePerDay: buyPx,
            sellPricePerDay: sellPx,
            deliveryAt: DELIVERY_AT,
          },
        ];
      },
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(BUYER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, (buyPx - marketPrice) * DELIVERY_DURATION_DAYS);
    assert.equal(pos.notional, buyPx * DELIVERY_DURATION_DAYS);
    assert.equal(pos.marketId, deliveryAtMarketId(DELIVERY_AT));
  });

  it("computes short-side underwater PnL for a seller when market rises above entry", async () => {
    const positionIds: Hex[] = ["0x" + "22".repeat(32) as Hex];
    const sellPx = 100n;
    const buyPx = 100n;
    const marketPrice = 130n; // short → loses (130-100)*7days = 210 per contract
    const chain = makeChainStub({
      readContract: makeReadHandler(DELIVERY_DURATION_DAYS, marketPrice, positionIds),
      multicall: () => [
        {
          seller: SELLER,
          buyer: BUYER,
          buyPricePerDay: buyPx,
          sellPricePerDay: sellPx,
          deliveryAt: DELIVERY_AT,
        },
      ],
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(SELLER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, (marketPrice - sellPx) * DELIVERY_DURATION_DAYS);
    assert.equal(pos.notional, sellPx * DELIVERY_DURATION_DAYS);
  });

  it("reports zero loss when the user is in profit", async () => {
    const positionIds: Hex[] = ["0x" + "33".repeat(32) as Hex];
    const chain = makeChainStub({
      readContract: makeReadHandler(DELIVERY_DURATION_DAYS, 150n, positionIds),
      multicall: () => [
        {
          seller: SELLER,
          buyer: BUYER,
          buyPricePerDay: 100n,
          sellPricePerDay: 100n,
          deliveryAt: DELIVERY_AT,
        },
      ],
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(BUYER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, 0n, "buyer with market > entry is in profit");
  });

  it("caches deliveryDurationDays across calls (read once)", async () => {
    let durationReads = 0;
    const chain = makeChainStub({
      readContract: (call) => {
        if (call.functionName === "deliveryDurationDays") {
          durationReads++;
          return Number(DELIVERY_DURATION_DAYS);
        }
        if (call.functionName === "getMarketPrice") return 100n;
        if (call.functionName === "getPositionIds") return [];
        throw new Error(`unexpected ${call.functionName}`);
      },
      multicall: () => [],
    });
    const venue = new FuturesVenue(chain, makeConfigStub(), silentLogger);
    await venue.readPositions(BUYER);
    await venue.readPositions(BUYER);
    await venue.readPositions(BUYER);
    assert.equal(durationReads, 1, "deliveryDurationDays read only once");
  });
});
