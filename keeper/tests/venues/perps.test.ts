import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pad, type Address } from "viem";
import { PerpsVenue, PERPS_MARKET_ID } from "../../src/venues/perps.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const PERPS = "0x00000000000000000000000000000000000DEAd5" as Address;
const USER = "0x00000000000000000000000000000000deadbeef" as Address;

interface ReadCall {
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Minimal stub: only handles the `readContract` and `multicall` shapes the
 * perps venue actually uses. Each handler receives the call and returns the
 * pre-canned result — keeps tests focused on the transformation logic.
 */
function makeChainStub(opts: {
  readContract?: (call: ReadCall) => unknown;
  multicall?: (calls: readonly ReadCall[]) => readonly unknown[];
}): Chain {
  return {
    publicClient: {
      readContract: async (call: ReadCall) => opts.readContract?.(call),
      multicall: async ({ contracts }: { contracts: readonly ReadCall[] }) =>
        opts.multicall?.(contracts),
    },
  } as unknown as Chain;
}

function makeConfigStub(): Config {
  return {
    perps: { address: PERPS },
    keeper: { dryRun: false },
  } as Config;
}

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ConstructorParameters<typeof PerpsVenue>[2];

describe("perps venue: marketLabel", () => {
  it("always returns 'perps' regardless of marketId", () => {
    const venue = new PerpsVenue(makeChainStub({}), makeConfigStub(), silentLogger);
    assert.equal(venue.marketLabel(PERPS_MARKET_ID), "perps");
    // Even an unrelated marketId resolves to the single perps label.
    assert.equal(venue.marketLabel(pad("0xdead", { size: 32 })), "perps");
  });
});

describe("perps venue: readOpenOrders", () => {
  it("returns empty when getUserOrders is empty", async () => {
    const chain = makeChainStub({
      readContract: (call) => {
        assert.equal(call.functionName, "getUserOrders");
        return [] as readonly `0x${string}`[];
      },
    });
    const venue = new PerpsVenue(chain, makeConfigStub(), silentLogger);
    const orders = await venue.readOpenOrders(USER);
    assert.equal(orders.length, 0);
  });

  it("tags each order id with the single PERPS_MARKET_ID sentinel", async () => {
    const ids = [pad("0xa", { size: 32 }), pad("0xb", { size: 32 })];
    const chain = makeChainStub({
      readContract: () => ids,
    });
    const venue = new PerpsVenue(chain, makeConfigStub(), silentLogger);
    const orders = await venue.readOpenOrders(USER);
    assert.equal(orders.length, 2);
    for (const o of orders) {
      assert.equal(o.marketId, PERPS_MARKET_ID);
    }
    assert.equal(orders[0]?.id, ids[0]);
    assert.equal(orders[1]?.id, ids[1]);
  });
});

describe("perps venue: readPositions", () => {
  // Quantities are scaled by 1e6 (QUANTITY_DECIMALS) on-chain.
  const QTY_SCALE = 1_000_000n;

  it("returns no position when netQuantity is 0", async () => {
    const chain = makeChainStub({
      multicall: () => [
        { netQuantity: 0n, aggregatedEntryPrice: 50n },
        100n, // marketPrice
      ],
    });
    const venue = new PerpsVenue(chain, makeConfigStub(), silentLogger);
    const positions = await venue.readPositions(USER);
    assert.equal(positions.length, 0);
  });

  it("computes unrealizedLoss=0 and notional=marketPrice*qty for a profitable long", async () => {
    const qty = 2n * QTY_SCALE; // long 2 contracts
    const entryPrice = 100n;
    const marketPrice = 150n; // up → long is in profit, no loss
    const chain = makeChainStub({
      multicall: () => [
        { netQuantity: qty, aggregatedEntryPrice: entryPrice },
        marketPrice,
      ],
    });
    const venue = new PerpsVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(USER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, 0n);
    assert.equal(pos.notional, (marketPrice * 2n * QTY_SCALE) / QTY_SCALE);
  });

  it("computes unrealizedLoss correctly for an underwater long (price drop)", async () => {
    const qty = 3n * QTY_SCALE; // long 3
    const entryPrice = 200n;
    const marketPrice = 150n; // -50 per contract × 3 contracts = 150 loss
    const chain = makeChainStub({
      multicall: () => [
        { netQuantity: qty, aggregatedEntryPrice: entryPrice },
        marketPrice,
      ],
    });
    const venue = new PerpsVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(USER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, 150n);
    assert.equal(pos.notional, marketPrice * 3n);
  });

  it("computes unrealizedLoss correctly for an underwater short (price rise)", async () => {
    const qty = -4n * QTY_SCALE; // short 4
    const entryPrice = 100n;
    const marketPrice = 130n; // +30 against the short × 4 = 120 loss
    const chain = makeChainStub({
      multicall: () => [
        { netQuantity: qty, aggregatedEntryPrice: entryPrice },
        marketPrice,
      ],
    });
    const venue = new PerpsVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(USER);
    assert.ok(pos);
    assert.equal(pos.unrealizedLoss, 120n);
    assert.equal(pos.notional, marketPrice * 4n);
  });

  it("synthesises a deterministic positionId from the user address (bytes32(user))", async () => {
    const chain = makeChainStub({
      multicall: () => [
        { netQuantity: 1n * QTY_SCALE, aggregatedEntryPrice: 100n },
        100n,
      ],
    });
    const venue = new PerpsVenue(chain, makeConfigStub(), silentLogger);
    const [pos] = await venue.readPositions(USER);
    assert.ok(pos);
    assert.equal(pos.id, pad(USER, { size: 32 }));
  });
});
