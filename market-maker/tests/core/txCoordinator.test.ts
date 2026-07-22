import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TxCoordinator, type MarketIntents } from "../../src/core/txCoordinator.ts";
import type { NonceManager } from "../../src/core/nonceManager.ts";
import type { InstrumentAdapter, VenueAdapter } from "../../src/core/adapter.ts";

const noop = () => {};
function makeLogger(): never {
  return {
    child: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
  } as never;
}

const RECEIPT = { gasUsed: 21_000n, effectiveGasPrice: 1n };

/** Fake NonceManager: runs the broadcast (triggering venue.sendCall) once. */
function makeNonce(): { nm: NonceManager; submitCount: () => number } {
  let count = 0;
  const nm = {
    submit: async (
      broadcast: (p: { nonce: number; maxFeePerGas: bigint }) => Promise<`0x${string}`>,
      opts: { maxFeePerGas: bigint },
    ) => {
      count++;
      await broadcast({ nonce: count, maxFeePerGas: opts.maxFeePerGas });
      return RECEIPT;
    },
  } as unknown as NonceManager;
  return { nm, submitCount: () => count };
}

function makeVenue(kind: "perps" | "futures", opts: { fail?: boolean } = {}) {
  const calls: `0x${string}`[] = [];
  const venue = {
    kind,
    sendCall: async (data: `0x${string}`) => {
      if (opts.fail) throw new Error(`${kind} boom`);
      calls.push(data);
      return "0xhash" as const;
    },
    multicall: async () => {
      throw new Error("multicall should not be used");
    },
  } as unknown as VenueAdapter;
  return { venue, calls };
}

function makeMarket(
  venue: VenueAdapter,
  id: string,
  cancels: string[],
  creates: { price: bigint; im: bigint; size?: bigint }[],
  expirationAt?: bigint,
): MarketIntents {
  const instrument = {
    id,
    venue,
    expirationAt,
    encodeCancel: (c: { orderId: `0x${string}` }) => `0xC${c.orderId.slice(2)}` as `0x${string}`,
    encodeCreate: (o: { price: bigint }) => `0xO${o.price.toString()}` as `0x${string}`,
    encodeUpdateOrders: (
      cancelIntents: { orderId: `0x${string}` }[],
      orders: { price: bigint; expirationAt?: bigint }[],
    ) => {
      const cancelPart = cancelIntents.map((c) => c.orderId.slice(2)).join("+");
      const createPart = orders
        .map((o) =>
          o.expirationAt !== undefined
            ? `${o.price}@${o.expirationAt}`
            : o.price.toString(),
        )
        .join(",");
      return `0xU${cancelPart}>${createPart}` as `0x${string}`;
    },
    estimateOrderMargin: (o: { price: bigint }) =>
      creates.find((c) => c.price === o.price)?.im ?? 0n,
    createCallWeight: (o: { size: bigint }) => Number(o.size),
  } as unknown as InstrumentAdapter;
  return {
    instrument,
    cancels: cancels.map((o) => ({ orderId: o as `0x${string}` })),
    creates: creates.map((c) => ({ side: "buy" as const, price: c.price, size: c.size ?? 1n })),
  };
}

describe("TxCoordinator", () => {
  it("runs one aggregate gate summing IM across all markets' creates", async () => {
    const { nm } = makeNonce();
    const seen: bigint[] = [];
    const coord = new TxCoordinator(nm, {}, makeLogger());
    const { venue } = makeVenue("futures");
    const markets = [
      makeMarket(venue, "f1", [], [{ price: 1n, im: 300n }], 100n),
      makeMarket(venue, "f2", [], [{ price: 2n, im: 400n }], 200n),
    ];
    await coord.submit(markets, {
      maxFeePerGas: 1n,
      dryRun: false,
      canPlace: async (im) => {
        seen.push(im);
        return true;
      },
    });
    assert.deepEqual(seen, [700n]); // 300 + 400, one call
  });

  it("drops creates but keeps cancels when the gate denies", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, {}, makeLogger());
    const { venue, calls } = makeVenue("futures");
    const markets = [makeMarket(venue, "f1", ["0xdead"], [{ price: 1n, im: 300n }], 100n)];
    const res = await coord.submit(markets, {
      maxFeePerGas: 1n,
      dryRun: false,
      canPlace: async () => false,
    });
    assert.equal(res.gateDenied, true);
    assert.equal(res.ordersPlaced, 0);
    assert.equal(res.ordersCancelled, 1);
    assert.equal(submitCount(), 1);
    assert.deepEqual(calls, ["0xUdead>"]); // updateOrders with cancels only
  });

  it("merges all same-venue expiries into one updateOrders call", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, {}, makeLogger());
    const { venue, calls } = makeVenue("futures");
    const markets = [
      makeMarket(venue, "f1", ["0xa"], [{ price: 1n, im: 0n }], 100n),
      makeMarket(venue, "f2", ["0xb"], [{ price: 2n, im: 0n }], 200n),
    ];
    await coord.submit(markets, { maxFeePerGas: 1n, dryRun: false, canPlace: async () => true });
    assert.equal(submitCount(), 1);
    assert.deepEqual(calls, ["0xUa+b>1@100,2@200"]);
  });

  it("isolates venue failures: one venue's revert doesn't block the other", async () => {
    const { nm } = makeNonce();
    const coord = new TxCoordinator(nm, {}, makeLogger());
    const perps = makeVenue("perps", { fail: true });
    const futures = makeVenue("futures");
    const markets = [
      makeMarket(perps.venue, "p", ["0x1"], []),
      makeMarket(futures.venue, "f", ["0x2"], []),
    ];
    const res = await coord.submit(markets, {
      maxFeePerGas: 1n,
      dryRun: false,
      canPlace: async () => true,
    });
    assert.equal(res.errors.length, 1);
    assert.equal(res.receipts.length, 1); // futures still submitted
    assert.equal(futures.calls.length, 1);
  });

  it("splits an over-budget venue into cancel-then-create updateOrders txs", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, { maxCallsPerTx: 2 }, makeLogger());
    const { venue, calls } = makeVenue("futures");
    // 3 cancels + create weight 3 → over budget 2 → cancel chunk(s) then create chunk.
    const markets = [
      makeMarket(
        venue,
        "f1",
        ["0xa", "0xb", "0xc"],
        [{ price: 1n, im: 0n, size: 3n }],
        100n,
      ),
    ];
    await coord.submit(markets, { maxFeePerGas: 1n, dryRun: false, canPlace: async () => true });
    assert.equal(submitCount(), 3);
    assert.deepEqual(calls, ["0xUa+b>", "0xUc>", "0xU>1@100"]);
  });

  it("keeps under-budget cancel+create in one updateOrders across expiries", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, { maxCallsPerTx: 20 }, makeLogger());
    const { venue, calls } = makeVenue("futures");
    const markets = [
      makeMarket(venue, "f1", ["0xz"], [{ price: 1n, im: 0n, size: 5n }], 100n),
      makeMarket(venue, "f2", [], [{ price: 2n, im: 0n, size: 1n }], 200n),
    ];
    await coord.submit(markets, { maxFeePerGas: 1n, dryRun: false, canPlace: async () => true });
    assert.equal(submitCount(), 1);
    assert.deepEqual(calls, ["0xUz>1@100,2@200"]);
  });

  it("dry run submits nothing but reports intended counts", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, {}, makeLogger());
    const { venue, calls } = makeVenue("futures");
    const markets = [makeMarket(venue, "f1", ["0xa"], [{ price: 1n, im: 0n }], 100n)];
    const res = await coord.submit(markets, {
      maxFeePerGas: 1n,
      dryRun: true,
      canPlace: async () => true,
    });
    assert.equal(submitCount(), 0);
    assert.equal(calls.length, 0);
    assert.equal(res.ordersCancelled, 1);
    assert.equal(res.ordersPlaced, 1);
  });
});
