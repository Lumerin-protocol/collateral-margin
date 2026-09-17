import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BookTracker } from "../src/bookTracker.ts";
import type { MakerConfig } from "../src/config.ts";

function makeConfig(): MakerConfig {
  return {
    perpsAddress: "0x0000000000000000000000000000000000000001",
    resyncIntervalMs: 60000,
  } as unknown as MakerConfig;
}

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

const MM_ADDRESS = "0x000000000000000000000000000000000000aaaa" as `0x${string}`;
const OTHER_ADDRESS = "0x000000000000000000000000000000000000bbbb" as `0x${string}`;

function makeOrderId(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function makeEmptyClient() {
  return {
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === "getOrderBookPrices") return [[], []];
      if (args.functionName === "getUserOrders") return [];
      return undefined;
    },
    multicall: async () => [],
    watchContractEvent: () => () => {},
  };
}

describe("BookTracker", () => {
  it("starts with zero best bid/ask", () => {
    const tracker = new BookTracker({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    assert.equal(tracker.bestBid, 0n);
    assert.equal(tracker.bestAsk, 0n);
    assert.equal(tracker.midPrice, 0n);
    assert.equal(tracker.ownOrders.size, 0);
  });

  it("depthAtPrice returns 0 for unknown prices", () => {
    const tracker = new BookTracker({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    assert.equal(tracker.depthAtPrice(100_000_000n, true), 0n);
    assert.equal(tracker.depthAtPrice(100_000_000n, false), 0n);
  });

  it("start performs full resync and watches events", async () => {
    let watchCalled = false;
    const client = {
      ...makeEmptyClient(),
      watchContractEvent: () => {
        watchCalled = true;
        return () => {};
      },
    };
    const tracker = new BookTracker(client as never, makeConfig(), MM_ADDRESS, makeLogger());
    await tracker.start();
    assert.ok(watchCalled);
  });

  it("processes events delivered via onLogs callback", async () => {
    let capturedOnLogs: ((logs: unknown[]) => void) | null = null;
    const client = {
      ...makeEmptyClient(),
      watchContractEvent: (opts: { onLogs: (logs: unknown[]) => void }) => {
        capturedOnLogs = opts.onLogs;
        return () => {};
      },
    };
    const tracker = new BookTracker(client as never, makeConfig(), MM_ADDRESS, makeLogger());
    await tracker.start();
    assert.ok(capturedOnLogs);

    const orderId = makeOrderId(99);
    capturedOnLogs([
      {
        eventName: "OrderCreated",
        args: { participant: MM_ADDRESS, orderId, price: 100_000_000n, quantity: 5_000_000n },
      },
    ]);
    assert.equal(tracker.ownOrders.size, 1);
    assert.equal(tracker.ownOrders.get(orderId)?.price, 100_000_000n);
  });

  it("stop calls unwatch", async () => {
    let unwatchCalled = false;
    const client = {
      ...makeEmptyClient(),
      watchContractEvent: () => {
        return () => {
          unwatchCalled = true;
        };
      },
    };
    const tracker = new BookTracker(client as never, makeConfig(), MM_ADDRESS, makeLogger());
    await tracker.start();
    tracker.stop();
    assert.ok(unwatchCalled);
  });

  it("stop is safe to call without start", () => {
    const tracker = new BookTracker({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    tracker.stop();
  });

  it("resync sets best bid/ask/mid from contract", async () => {
    const bids = [110_000_000n, 100_000_000n];
    const asks = [120_000_000n, 130_000_000n];
    const client = {
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === "getOrderBookPrices") return [bids, asks];
        if (args.functionName === "getUserOrders") return [];
        return undefined;
      },
      multicall: async (args: { contracts: unknown[] }) => {
        return args.contracts.map(() => 5_000_000n);
      },
      watchContractEvent: () => () => {},
    };
    const tracker = new BookTracker(client as never, makeConfig(), MM_ADDRESS, makeLogger());
    await tracker.start();

    assert.equal(tracker.bestBid, 110_000_000n);
    assert.equal(tracker.bestAsk, 120_000_000n);
    assert.equal(tracker.midPrice, 115_000_000n);
    assert.equal(tracker.depthAtPrice(110_000_000n, true), 5_000_000n);
  });

  it("resync loads own orders", async () => {
    const orderId1 = makeOrderId(1);
    const client = {
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === "getOrderBookPrices") return [[], []];
        if (args.functionName === "getUserOrders") return [orderId1];
        return undefined;
      },
      multicall: async () => [
        { participant: MM_ADDRESS, price: 100_000_000n, quantity: 5_000_000n },
      ],
      watchContractEvent: () => () => {},
    };
    const tracker = new BookTracker(client as never, makeConfig(), MM_ADDRESS, makeLogger());
    await tracker.start();

    assert.equal(tracker.ownOrders.size, 1);
    assert.equal(tracker.ownOrders.get(orderId1)?.price, 100_000_000n);
  });

  it("refresh triggers resync when interval elapsed", async () => {
    let resyncCount = 0;
    const client = {
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === "getOrderBookPrices") {
          resyncCount++;
          return [[], []];
        }
        if (args.functionName === "getUserOrders") return [];
        return undefined;
      },
      multicall: async () => [],
      watchContractEvent: () => () => {},
    };
    const config = { ...makeConfig(), resyncIntervalMs: 0 } as MakerConfig;
    const tracker = new BookTracker(client as never, config, MM_ADDRESS, makeLogger());
    await tracker.start();
    const initial = resyncCount;
    // Force lastResyncAt into the past so interval check passes
    (tracker as unknown as { lastResyncAt: number }).lastResyncAt = 0;
    await tracker.refresh();
    assert.ok(resyncCount > initial, "should have resynced");
  });

  it("refresh skips resync when interval not elapsed", async () => {
    let resyncCount = 0;
    const client = {
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === "getOrderBookPrices") {
          resyncCount++;
          return [[], []];
        }
        if (args.functionName === "getUserOrders") return [];
        return undefined;
      },
      multicall: async () => [],
      watchContractEvent: () => () => {},
    };
    const config = { ...makeConfig(), resyncIntervalMs: 999_999 } as MakerConfig;
    const tracker = new BookTracker(client as never, config, MM_ADDRESS, makeLogger());
    await tracker.start();
    const afterStart = resyncCount;
    await tracker.refresh();
    assert.equal(resyncCount, afterStart, "should not have resynced yet");
  });
});

describe("BookTracker.handleEvent", () => {
  let tracker: BookTracker;

  beforeEach(async () => {
    const client = makeEmptyClient();
    tracker = new BookTracker(client as never, makeConfig(), MM_ADDRESS, makeLogger());
    await tracker.start();
  });

  it("OrderCreated adds own order when participant matches", () => {
    const orderId = makeOrderId(42);
    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderCreated",
      args: { participant: MM_ADDRESS, orderId, price: 100_000_000n, quantity: 5_000_000n },
    });
    assert.equal(tracker.ownOrders.size, 1);
    assert.equal(tracker.ownOrders.get(orderId)?.quantity, 5_000_000n);
  });

  it("OrderCreated ignores orders from other addresses", () => {
    const orderId = makeOrderId(43);
    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderCreated",
      args: { participant: OTHER_ADDRESS, orderId, price: 100_000_000n, quantity: 5_000_000n },
    });
    assert.equal(tracker.ownOrders.size, 0);
  });

  it("OrderCreated ignores events with missing fields", () => {
    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderCreated",
      args: { participant: MM_ADDRESS },
    });
    assert.equal(tracker.ownOrders.size, 0);
  });

  it("OrderCancelled removes own order", () => {
    const orderId = makeOrderId(44);
    tracker.ownOrders.set(orderId, { orderId, price: 100n, quantity: 10n });

    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderCancelled",
      args: { orderId },
    });
    assert.equal(tracker.ownOrders.size, 0);
  });

  it("OrderUpdated modifies existing own order quantity", () => {
    const orderId = makeOrderId(45);
    tracker.ownOrders.set(orderId, { orderId, price: 100n, quantity: 10n });

    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderUpdated",
      args: { orderId, newQuantity: 5n },
    });
    assert.equal(tracker.ownOrders.get(orderId)?.quantity, 5n);
  });

  it("OrderUpdated removes order when quantity goes to 0", () => {
    const orderId = makeOrderId(46);
    tracker.ownOrders.set(orderId, { orderId, price: 100n, quantity: 10n });

    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderUpdated",
      args: { orderId, newQuantity: 0n },
    });
    assert.equal(tracker.ownOrders.size, 0);
  });

  it("OrderUpdated ignores unknown order IDs", () => {
    const orderId = makeOrderId(99);
    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderUpdated",
      args: { orderId, newQuantity: 5n },
    });
    assert.equal(tracker.ownOrders.size, 0);
  });

  it("OrderUpdated ignores events with missing fields", () => {
    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderUpdated",
      args: {},
    });
    assert.equal(tracker.ownOrders.size, 0);
  });

  it("OrderMatched logs but does not crash", () => {
    const orderId = makeOrderId(47);
    tracker.ownOrders.set(orderId, { orderId, price: 100n, quantity: 10n });

    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "OrderMatched",
      args: { makerOrderId: orderId },
    });
    assert.equal(tracker.ownOrders.size, 1);
  });

  it("handles unknown event names gracefully", () => {
    (tracker as unknown as { handleEvent: (log: unknown) => void }).handleEvent({
      eventName: "SomeUnknownEvent",
      args: {},
    });
    assert.equal(tracker.ownOrders.size, 0);
  });
});
