import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { CoordinatorQueue, compare } from "../../src/coordinator/queue.ts";
import type { AccountHealth } from "../../src/pme/health.ts";

function userAt(idx: number): Address {
  return `0x${(idx + 1).toString(16).padStart(40, "0")}` as Address;
}

function health(opts: { user?: Address; mmSurplus: bigint; imUtil?: number }): AccountHealth {
  return {
    user: opts.user ?? userAt(0),
    balance: 1000n,
    imRequired: 100n,
    mmRequired: 1000n - opts.mmSurplus,
    mmSurplus: opts.mmSurplus,
    imUtilization: opts.imUtil ?? 0.5,
  };
}

describe("coordinator queue: ordering policy (compare)", () => {
  it("ranks lower mmSurplus first (most-underwater wins)", () => {
    assert.ok(compare(health({ mmSurplus: -100n }), health({ mmSurplus: -10n })) < 0);
    assert.ok(compare(health({ mmSurplus: -10n }), health({ mmSurplus: -100n })) > 0);
  });

  it("returns 0 for equal mmSurplus regardless of imUtilization", () => {
    // imUtilization is intentionally NOT a tiebreak — bigint mmSurplus ties are
    // vanishingly rare and any tiebreak among already-underwater accounts is moot.
    const a = health({ mmSurplus: -50n, imUtil: 0.9 });
    const b = health({ mmSurplus: -50n, imUtil: 0.7 });
    assert.equal(compare(a, b), 0);
  });

  it("handles bigint values larger than Number.MAX_SAFE_INTEGER without truncation", () => {
    const a = health({ mmSurplus: -(2n ** 70n) });
    const b = health({ mmSurplus: -1n });
    assert.ok(compare(a, b) < 0, "very-negative mmSurplus still ranks ahead");
  });
});

describe("coordinator queue: gating on mmSurplus", () => {
  it("rejects healthy snapshots (mmSurplus >= 0) and reports false from upsert", () => {
    const q = new CoordinatorQueue();
    assert.equal(q.upsert(health({ user: userAt(0), mmSurplus: 50n })), false);
    assert.equal(q.upsert(health({ user: userAt(1), mmSurplus: 0n })), false, "mmSurplus=0 is the boundary; not yet liquidatable");
    assert.equal(q.size(), 0);
  });

  it("a healthy snapshot for an already-enqueued user removes them from the queue", () => {
    const q = new CoordinatorQueue();
    q.upsert(health({ user: userAt(0), mmSurplus: -50n }));
    assert.equal(q.size(), 1);
    // Account recovered (deposit, price move, etc.) → drop from queue.
    assert.equal(q.upsert(health({ user: userAt(0), mmSurplus: 100n })), false);
    assert.equal(q.size(), 0);
  });

  it("reports true from upsert when the user ends up in the queue", () => {
    const q = new CoordinatorQueue();
    assert.equal(q.upsert(health({ user: userAt(0), mmSurplus: -10n })), true);
  });
});

describe("coordinator queue: upsert / pop / remove", () => {
  it("pops accounts in most-underwater-first order", () => {
    const q = new CoordinatorQueue();
    q.upsert(health({ user: userAt(0), mmSurplus: -10n }));
    q.upsert(health({ user: userAt(1), mmSurplus: -100n }));
    q.upsert(health({ user: userAt(2), mmSurplus: -50n }));

    assert.equal(q.pop()?.user, userAt(1), "most-negative first");
    assert.equal(q.pop()?.user, userAt(2));
    assert.equal(q.pop()?.user, userAt(0));
    assert.equal(q.pop(), undefined);
  });

  it("upsert is idempotent on user — replacing in place keeps the set unique", () => {
    const q = new CoordinatorQueue();
    q.upsert(health({ user: userAt(0), mmSurplus: -10n }));
    q.upsert(health({ user: userAt(0), mmSurplus: -100n }));
    assert.equal(q.size(), 1, "no duplicate entry for the same user");
    assert.equal(q.peek()?.mmSurplus, -100n, "latest snapshot wins");
  });

  it("upsert re-orders existing entries when mmSurplus changes", () => {
    const q = new CoordinatorQueue();
    q.upsert(health({ user: userAt(0), mmSurplus: -10n }));
    q.upsert(health({ user: userAt(1), mmSurplus: -50n }));
    // user(0) gets worse than user(1) → must move to head.
    q.upsert(health({ user: userAt(0), mmSurplus: -200n }));
    assert.equal(q.pop()?.user, userAt(0));
    assert.equal(q.pop()?.user, userAt(1));
  });

  it("remove deletes by user without affecting the rest of the order", () => {
    const q = new CoordinatorQueue();
    q.upsert(health({ user: userAt(0), mmSurplus: -10n }));
    q.upsert(health({ user: userAt(1), mmSurplus: -100n }));
    q.upsert(health({ user: userAt(2), mmSurplus: -50n }));
    q.remove(userAt(1));
    assert.equal(q.size(), 2);
    assert.equal(q.pop()?.user, userAt(2));
    assert.equal(q.pop()?.user, userAt(0));
  });

  it("remove on an unknown user is a no-op", () => {
    const q = new CoordinatorQueue();
    q.upsert(health({ user: userAt(0), mmSurplus: -10n }));
    q.remove(userAt(99));
    assert.equal(q.size(), 1);
  });

  it("snapshot returns a copy that doesn't mutate the underlying queue", () => {
    const q = new CoordinatorQueue();
    q.upsert(health({ user: userAt(0), mmSurplus: -10n }));
    const snap = q.snapshot();
    assert.equal(snap.length, 1);
    (snap as AccountHealth[]).pop();
    assert.equal(q.size(), 1);
  });
});
