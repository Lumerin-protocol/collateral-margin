import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InventoryManager } from "../../src/core/inventoryManager.ts";
import type { InstrumentAdapter } from "../../src/core/adapter.ts";
import { QUANTITY_SCALE } from "../../src/core/math.ts";

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

function makeInstrument(netQuantity: bigint): InstrumentAdapter {
  return {
    id: "test",
    getPosition: async () => ({ netQuantity, entryPrice: 0n }),
  } as unknown as InstrumentAdapter;
}

const usd = (n: number) => BigInt(n) * 1_000_000n;

describe("InventoryManager position cap", () => {
  it("converts the USD cap into perps units at the oracle price", async () => {
    const inv = new InventoryManager(
      makeInstrument(5n * QUANTITY_SCALE),
      { maxPositionNotional: usd(1000), quantityScale: QUANTITY_SCALE },
      { currentPrice: usd(40) },
      makeLogger(),
    );
    await inv.update();
    assert.equal(inv.maxPositionSize, 25n * QUANTITY_SCALE);
    assert.equal(inv.inventorySkew.valueOf(), 0.2);
  });

  it("converts the USD cap into whole futures contracts", async () => {
    const inv = new InventoryManager(
      makeInstrument(-5n),
      { maxPositionNotional: usd(1000), quantityScale: 1n },
      { currentPrice: usd(40) },
      makeLogger(),
    );
    await inv.update();
    assert.equal(inv.maxPositionSize, 25n);
    assert.equal(inv.inventorySkew.valueOf(), -0.2);
  });

  it("re-derives the cap when the oracle moves", async () => {
    const oracle = { currentPrice: usd(40) };
    const inv = new InventoryManager(
      makeInstrument(0n),
      { maxPositionNotional: usd(1000), quantityScale: QUANTITY_SCALE },
      oracle,
      makeLogger(),
    );
    await inv.update();
    assert.equal(inv.maxPositionSize, 25n * QUANTITY_SCALE);
    oracle.currentPrice = usd(80);
    await inv.update();
    assert.equal(inv.maxPositionSize, 12_500_000n);
  });

  it("saturates skew at ±1 once the position notional exceeds the cap", async () => {
    const inv = new InventoryManager(
      makeInstrument(56n * QUANTITY_SCALE),
      { maxPositionNotional: usd(1000), quantityScale: QUANTITY_SCALE },
      { currentPrice: usd(40) },
      makeLogger(),
    );
    await inv.update();
    assert.equal(inv.inventorySkew.valueOf(), 1);
  });

  it("caps at zero with neutral skew before the first oracle price", async () => {
    const inv = new InventoryManager(
      makeInstrument(5n * QUANTITY_SCALE),
      { maxPositionNotional: usd(1000), quantityScale: QUANTITY_SCALE },
      { currentPrice: 0n },
      makeLogger(),
    );
    await inv.update();
    assert.equal(inv.maxPositionSize, 0n);
    assert.equal(inv.inventorySkew.valueOf(), 0);
  });
});
