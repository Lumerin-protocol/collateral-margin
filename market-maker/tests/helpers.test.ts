import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateOrders, resampleHourlyClose, type PricedOrder } from "../src/helpers.ts";

const HOUR_MS = 60 * 60 * 1000;

// ─── calculateOrders ──────────────────────────────────────────────────────────

describe("calculateOrders", () => {
  const sort = (orders: PricedOrder[]) =>
    [...orders].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));

  const eq = (actual: PricedOrder[], expected: PricedOrder[]) => {
    assert.deepStrictEqual(sort(actual), sort(expected));
  };

  it("returns empty for both empty", () => eq(calculateOrders([], []), []));

  it("returns modelled when current is empty", () => {
    eq(calculateOrders([{ price: 100n, qty: 5n }, { price: 200n, qty: 3n }], []), [
      { price: 100n, qty: 5n },
      { price: 200n, qty: 3n },
    ]);
  });

  it("returns negated current when modelled is empty", () => {
    eq(calculateOrders([], [{ price: 100n, qty: 5n }, { price: 200n, qty: 3n }]), [
      { price: 100n, qty: -5n },
      { price: 200n, qty: -3n },
    ]);
  });

  it("returns empty when modelled equals current", () => {
    const orders = [{ price: 100n, qty: 5n }, { price: 200n, qty: 3n }];
    eq(calculateOrders(orders, orders), []);
  });

  it("positive diff when modelled > current", () =>
    eq(calculateOrders([{ price: 100n, qty: 10n }], [{ price: 100n, qty: 3n }]), [{ price: 100n, qty: 7n }]));

  it("negative diff when modelled < current", () =>
    eq(calculateOrders([{ price: 100n, qty: 3n }], [{ price: 100n, qty: 10n }]), [{ price: 100n, qty: -7n }]));

  it("handles non-overlapping price levels", () =>
    eq(calculateOrders([{ price: 100n, qty: 5n }], [{ price: 200n, qty: 3n }]), [
      { price: 100n, qty: 5n },
      { price: 200n, qty: -3n },
    ]));

  it("aggregates multiple orders at same price", () => {
    eq(calculateOrders([{ price: 100n, qty: 3n }, { price: 100n, qty: 4n }],
                       [{ price: 100n, qty: 2n }, { price: 100n, qty: 1n }]),
       [{ price: 100n, qty: 4n }]);
  });

  it("handles negative quantity (short)", () =>
    eq(calculateOrders([{ price: 100n, qty: -5n }], []), [{ price: 100n, qty: -5n }]));

  it("handles transition from short to long", () =>
    eq(calculateOrders([{ price: 100n, qty: 3n }], [{ price: 100n, qty: -2n }]), [{ price: 100n, qty: 5n }]));

  it("zero qty in modelled produces no order", () =>
    eq(calculateOrders([{ price: 100n, qty: 0n }], []), []));

  it("returns orders sorted by price ascending", () => {
    const result = calculateOrders(
      [{ price: 300n, qty: 1n }, { price: 100n, qty: 2n }, { price: 200n, qty: 3n }],
      [],
    );
    assert.deepStrictEqual(result, [
      { price: 100n, qty: 2n },
      { price: 200n, qty: 3n },
      { price: 300n, qty: 1n },
    ]);
  });

  it("invariant: applying result to current yields modelled", () => {
    const modelled = [{ price: 100n, qty: 10n }, { price: 150n, qty: -5n }, { price: 200n, qty: 3n }];
    const current  = [{ price: 100n, qty: 7n }, { price: 200n, qty: 5n }, { price: 250n, qty: 2n }];
    const delta = calculateOrders(modelled, current);

    const applied = new Map<bigint, bigint>();
    for (const o of [...current, ...delta]) {
      applied.set(o.price, (applied.get(o.price) ?? 0n) + o.qty);
    }
    const expected = new Map<bigint, bigint>();
    for (const o of modelled) {
      expected.set(o.price, (expected.get(o.price) ?? 0n) + o.qty);
    }
    for (const [k, v] of applied) if (v === 0n) applied.delete(k);
    for (const [k, v] of expected) if (v === 0n) expected.delete(k);
    assert.deepStrictEqual(applied, expected);
  });

  it("handles very large bigint values", () => {
    const L = 1000000000000000000000n;
    eq(calculateOrders([{ price: L, qty: L }], [{ price: L, qty: L / 2n }]), [{ price: L, qty: L / 2n }]);
  });
});

// ─── resampleHourlyClose ─────────────────────────────────────────────────────

describe("resampleHourlyClose", () => {
  it("returns empty for empty input", () => assert.deepStrictEqual(resampleHourlyClose([]), []));

  it("snaps single point to bucket start", () => {
    const base = HOUR_MS * 100;
    assert.deepStrictEqual(resampleHourlyClose([{ date: base + 30 * 60 * 1000, price: 100n }]), [
      { date: base, price: 100n },
    ]);
  });

  it("takes last price when multiple points in same bucket", () => {
    const base = HOUR_MS * 100;
    assert.deepStrictEqual(
      resampleHourlyClose([
        { date: base + 10 * 60 * 1000, price: 100n },
        { date: base + 20 * 60 * 1000, price: 200n },
        { date: base + 50 * 60 * 1000, price: 300n },
      ]),
      [{ date: base, price: 300n }],
    );
  });

  it("fills missing buckets with LOCF", () => {
    const h0 = HOUR_MS * 100;
    const h1 = h0 + HOUR_MS;
    const h2 = h0 + HOUR_MS * 2;
    const h3 = h0 + HOUR_MS * 3;
    assert.deepStrictEqual(
      resampleHourlyClose([
        { date: h0 + 30 * 60 * 1000, price: 100n },
        { date: h3 + 15 * 60 * 1000, price: 400n },
      ]),
      [
        { date: h0, price: 100n },
        { date: h1, price: 100n },
        { date: h2, price: 100n },
        { date: h3, price: 400n },
      ],
    );
  });

  it("handles unsorted input", () => {
    const h0 = HOUR_MS * 100;
    const h1 = h0 + HOUR_MS;
    assert.deepStrictEqual(
      resampleHourlyClose([
        { date: h1 + 30 * 60 * 1000, price: 200n },
        { date: h0 + 15 * 60 * 1000, price: 100n },
      ]),
      [{ date: h0, price: 100n }, { date: h1, price: 200n }],
    );
  });

  it("works with custom interval", () => {
    const HALF = 30 * 60 * 1000;
    const base = HALF * 100;
    assert.deepStrictEqual(
      resampleHourlyClose(
        [{ date: base + 10 * 60 * 1000, price: 100n }, { date: base + HALF + 5 * 60 * 1000, price: 200n }],
        HALF,
      ),
      [{ date: base, price: 100n }, { date: base + HALF, price: 200n }],
    );
  });
});
