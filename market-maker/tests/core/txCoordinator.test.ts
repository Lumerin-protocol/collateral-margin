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

/** Fake NonceManager: runs the broadcast (triggering venue.multicall) once. */
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
  const batches: `0x${string}`[][] = [];
  const venue = {
    kind,
    multicall: async (calls: `0x${string}`[]) => {
      if (opts.fail) throw new Error(`${kind} boom`);
      batches.push(calls);
      return "0xhash" as const;
    },
  } as unknown as VenueAdapter;
  return { venue, batches };
}

function makeMarket(
  venue: VenueAdapter,
  id: string,
  cancels: string[],
  creates: { price: bigint; im: bigint; size?: bigint }[],
): MarketIntents {
  const instrument = {
    id,
    venue,
    encodeCancel: (c: { orderId: `0x${string}` }) => `0xC${c.orderId.slice(2)}` as `0x${string}`,
    encodeCreate: (o: { price: bigint }) => `0xO${o.price.toString()}` as `0x${string}`,
    estimateOrderMargin: (o: { price: bigint }) =>
      creates.find((c) => c.price === o.price)?.im ?? 0n,
    // Mirror the futures weighting (cost units = qty) so chunking is exercised.
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
      makeMarket(venue, "f1", [], [{ price: 1n, im: 300n }]),
      makeMarket(venue, "f2", [], [{ price: 2n, im: 400n }]),
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
    const { venue, batches } = makeVenue("futures");
    const markets = [makeMarket(venue, "f1", ["0xdead"], [{ price: 1n, im: 300n }])];
    const res = await coord.submit(markets, {
      maxFeePerGas: 1n,
      dryRun: false,
      canPlace: async () => false,
    });
    assert.equal(res.gateDenied, true);
    assert.equal(res.ordersPlaced, 0);
    assert.equal(res.ordersCancelled, 1);
    assert.equal(submitCount(), 1);
    assert.deepEqual(batches[0], ["0xCdead"]); // only the cancel encoded
  });

  it("merges same-venue markets into one batch, cancels before creates", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, {}, makeLogger());
    const { venue, batches } = makeVenue("futures");
    const markets = [
      makeMarket(venue, "f1", ["0xa"], [{ price: 1n, im: 0n }]),
      makeMarket(venue, "f2", ["0xb"], [{ price: 2n, im: 0n }]),
    ];
    await coord.submit(markets, { maxFeePerGas: 1n, dryRun: false, canPlace: async () => true });
    assert.equal(submitCount(), 1); // one venue → one tx
    assert.deepEqual(batches[0], ["0xCa", "0xCb", "0xO1", "0xO2"]);
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
    assert.equal(futures.batches.length, 1);
  });

  it("chunks a venue batch that exceeds maxCallsPerTx (unit-weight cancels)", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, { maxCallsPerTx: 2 }, makeLogger());
    const { venue, batches } = makeVenue("futures");
    const markets = [
      makeMarket(venue, "f1", ["0xa", "0xb", "0xc", "0xd", "0xe"], []),
    ];
    await coord.submit(markets, { maxFeePerGas: 1n, dryRun: false, canPlace: async () => true });
    assert.equal(submitCount(), 3); // 5 cancels @ weight 1 / budget 2 = 3 chunks
    assert.deepEqual(batches.map((b) => b.length), [2, 2, 1]);
  });

  it("chunks by weighted cost units (futures qty), not raw call count", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, { maxCallsPerTx: 10 }, makeLogger());
    const { venue, batches } = makeVenue("futures");
    // Weights 6, 6, 3: budget 10 → [6] | [6, 3]. Three calls, but two txs.
    const markets = [
      makeMarket(venue, "f1", [], [
        { price: 1n, im: 0n, size: 6n },
        { price: 2n, im: 0n, size: 6n },
        { price: 3n, im: 0n, size: 3n },
      ]),
    ];
    await coord.submit(markets, { maxFeePerGas: 1n, dryRun: false, canPlace: async () => true });
    assert.equal(submitCount(), 2);
    assert.deepEqual(batches.map((b) => b.length), [1, 2]);
  });

  it("sends a single over-budget call alone rather than dropping it", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, { maxCallsPerTx: 2 }, makeLogger());
    const { venue, batches } = makeVenue("futures");
    // One create of qty 5 > budget 2 → its own chunk; a trailing cancel packs after.
    const markets = [makeMarket(venue, "f1", ["0xz"], [{ price: 1n, im: 0n, size: 5n }])];
    await coord.submit(markets, { maxFeePerGas: 1n, dryRun: false, canPlace: async () => true });
    // cancel (w1) then create (w5): [0xCz] fills to 1, +5 > 2 → flush, [0xO1] alone.
    assert.equal(submitCount(), 2);
    assert.deepEqual(batches.map((b) => b.length), [1, 1]);
  });

  it("dry run submits nothing but reports intended counts", async () => {
    const { nm, submitCount } = makeNonce();
    const coord = new TxCoordinator(nm, {}, makeLogger());
    const { venue, batches } = makeVenue("futures");
    const markets = [makeMarket(venue, "f1", ["0xa"], [{ price: 1n, im: 0n }])];
    const res = await coord.submit(markets, {
      maxFeePerGas: 1n,
      dryRun: true,
      canPlace: async () => true,
    });
    assert.equal(submitCount(), 0);
    assert.equal(batches.length, 0);
    assert.equal(res.ordersCancelled, 1);
    assert.equal(res.ordersPlaced, 1);
  });
});
