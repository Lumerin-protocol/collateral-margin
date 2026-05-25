import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { PredictiveIndex } from "../../src/predict/predictiveIndex.ts";

function userAt(idx: number): Address {
  return `0x${(idx + 1).toString(16).padStart(40, "0")}` as Address;
}

describe("predict/predictiveIndex: upsert / invalidate / size", () => {
  it("ignores upserts where both thresholds are undefined", () => {
    const idx = new PredictiveIndex();
    const tracked = idx.upsert({ user: userAt(0), liqDown: undefined, liqUp: undefined });
    assert.equal(tracked, false);
    assert.equal(idx.size(), 0);
  });

  it("stores users with at least one defined threshold", () => {
    const idx = new PredictiveIndex();
    assert.equal(idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: undefined }), true);
    assert.equal(idx.upsert({ user: userAt(1), liqDown: undefined, liqUp: 200n }), true);
    assert.equal(idx.size(), 2);
  });

  it("upsert replaces (not duplicates) by user address", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: undefined });
    idx.upsert({ user: userAt(0), liqDown: 90n, liqUp: undefined });
    assert.equal(idx.size(), 1);
    assert.deepEqual(idx.get(userAt(0)), { user: userAt(0), liqDown: 90n, liqUp: undefined });
  });

  it("invalidate removes the user from both sorted lists", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: 200n });
    idx.invalidate(userAt(0));
    assert.equal(idx.size(), 0);
    // Subsequent crossings should find nothing.
    assert.deepEqual(idx.crossings(150n, 50n), []);
  });
});

describe("predict/predictiveIndex: crossings on price drop", () => {
  it("returns nothing on the very first tick (prev=undefined)", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: undefined });
    assert.deepEqual(idx.crossings(undefined, 50n), []);
  });

  it("returns nothing when price doesn't move", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: undefined });
    assert.deepEqual(idx.crossings(120n, 120n), []);
  });

  it("fires DOWN crossings for every user whose liqDown ∈ [next, prev]", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: undefined }); // crossed
    idx.upsert({ user: userAt(1), liqDown: 90n, liqUp: undefined }); // crossed
    idx.upsert({ user: userAt(2), liqDown: 80n, liqUp: undefined }); // not crossed (below `next`)
    idx.upsert({ user: userAt(3), liqDown: 110n, liqUp: undefined }); // already triggered before `prev`

    const out = idx.crossings(105n, 85n);
    assert.equal(out.length, 2);
    const users = new Set(out.map((c) => c.user));
    assert.ok(users.has(userAt(0)));
    assert.ok(users.has(userAt(1)));
    for (const c of out) assert.equal(c.direction, "down");
  });

  it("inclusive bound — landing exactly on a threshold counts as crossed", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: undefined });
    const out = idx.crossings(105n, 100n);
    assert.equal(out.length, 1);
  });

  it("ignores upSorted entries during a price drop", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: undefined, liqUp: 90n }); // up only
    assert.deepEqual(idx.crossings(105n, 80n), []);
  });
});

describe("predict/predictiveIndex: crossings on price rise", () => {
  it("fires UP crossings for every user whose liqUp ∈ [prev, next]", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: undefined, liqUp: 100n }); // crossed
    idx.upsert({ user: userAt(1), liqDown: undefined, liqUp: 110n }); // crossed
    idx.upsert({ user: userAt(2), liqDown: undefined, liqUp: 120n }); // not crossed (above `next`)
    idx.upsert({ user: userAt(3), liqDown: undefined, liqUp: 90n }); // already triggered

    const out = idx.crossings(95n, 115n);
    assert.equal(out.length, 2);
    const users = new Set(out.map((c) => c.user));
    assert.ok(users.has(userAt(0)));
    assert.ok(users.has(userAt(1)));
    for (const c of out) assert.equal(c.direction, "up");
  });

  it("ignores downSorted entries during a price rise", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 110n, liqUp: undefined }); // down only
    assert.deepEqual(idx.crossings(95n, 120n), []);
  });
});

describe("predict/predictiveIndex: snapshot", () => {
  it("returns all tracked thresholds", () => {
    const idx = new PredictiveIndex();
    idx.upsert({ user: userAt(0), liqDown: 100n, liqUp: undefined });
    idx.upsert({ user: userAt(1), liqDown: undefined, liqUp: 200n });
    const snap = idx.snapshot();
    assert.equal(snap.length, 2);
  });
});
