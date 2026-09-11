import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { computeUtilization, readAccountHealthBatch } from "../../src/pme/health.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

const VAULT = "0x0000000000000000000000000000000000000001" as Address;
const PME = "0x0000000000000000000000000000000000000002" as Address;

function userAt(idx: number): Address {
  return `0x${(idx + 1).toString(16).padStart(40, "0")}` as Address;
}

/**
 * Minimal stub that emulates `publicClient.multicall({ contracts, allowFailure: false })`.
 * The handler receives the calls in order and returns one result per call —
 * matching viem's contract.
 */
function makeChainStub(handler: (calls: readonly unknown[]) => readonly unknown[]) {
  let multicallInvocations = 0;
  const stub = {
    publicClient: {
      multicall: async ({ contracts }: { contracts: readonly unknown[] }) => {
        multicallInvocations++;
        return handler(contracts);
      },
    },
  } as unknown as Chain;
  return { stub, getInvocations: () => multicallInvocations };
}

function makeConfigStub(): Config {
  return {
    vault: { address: VAULT },
    pme: { address: PME },
    // Other config fields unused by readAccountHealthBatch — minimal cast is fine.
  } as Config;
}

describe("pme/health: computeUtilization", () => {
  it("returns 0 for an idle account (both 0)", () => {
    assert.equal(computeUtilization(0n, 0n), 0);
  });

  it("returns +Infinity when balance is 0 but IM is required (already underwater)", () => {
    assert.equal(computeUtilization(100n, 0n), Number.POSITIVE_INFINITY);
  });

  it("returns 1 at exactly the IM boundary", () => {
    assert.equal(computeUtilization(1_000n, 1_000n), 1);
  });

  it("returns 0.85 for healthy 85% IM utilization", () => {
    assert.equal(computeUtilization(850n, 1_000n), 0.85);
  });

  it("preserves ~6 decimal digits of precision via ppm scaling", () => {
    // 1234567 / 10000000 = 0.1234567 → ppm scaling truncates to 0.123456
    const u = computeUtilization(1_234_567n, 10_000_000n);
    assert.ok(Math.abs(u - 0.1234567) < 1e-6);
  });
});

describe("pme/health: readAccountHealthBatch", () => {
  it("returns empty for an empty user list without invoking multicall", async () => {
    const { stub, getInvocations } = makeChainStub(() => []);
    const result = await readAccountHealthBatch(stub, makeConfigStub(), []);
    assert.equal(result.length, 0);
    assert.equal(getInvocations(), 0);
  });

  it("issues exactly 3 calls per user in a single multicall when chunk fits", async () => {
    const users = [userAt(0), userAt(1), userAt(2)];
    const { stub, getInvocations } = makeChainStub((calls) => {
      assert.equal(calls.length, users.length * 3);
      // Per-user triple: balanceOf(vault), computePortfolioIM(pme), computePortfolioMM(pme)
      users.forEach((user, i) => {
        const a = calls[i * 3] as { address: Address; functionName: string; args: unknown[] };
        const b = calls[i * 3 + 1] as { address: Address; functionName: string; args: unknown[] };
        const c = calls[i * 3 + 2] as { address: Address; functionName: string; args: unknown[] };
        assert.equal(a.address, VAULT);
        assert.equal(a.functionName, "balanceOf");
        assert.deepEqual(a.args, [user]);
        assert.equal(b.address, PME);
        assert.equal(b.functionName, "computePortfolioIM");
        assert.deepEqual(b.args, [user]);
        assert.equal(c.address, PME);
        assert.equal(c.functionName, "computePortfolioMM");
        assert.deepEqual(c.args, [user]);
      });
      // Return triples: balance=1000+i, im=400+i, mm=200+i
      return calls.map((_, idx) => {
        const triple = idx % 3;
        const u = Math.floor(idx / 3);
        if (triple === 0) return BigInt(1000 + u);
        if (triple === 1) return BigInt(400 + u);
        return BigInt(200 + u);
      });
    });

    const result = await readAccountHealthBatch(stub, makeConfigStub(), users);

    assert.equal(getInvocations(), 1);
    assert.equal(result.length, 3);
    users.forEach((user, i) => {
      const h = result[i]!;
      assert.equal(h.user, user);
      assert.equal(h.balance, BigInt(1000 + i));
      assert.equal(h.imRequired, BigInt(400 + i));
      assert.equal(h.mmRequired, BigInt(200 + i));
      assert.equal(h.mmSurplus, BigInt(1000 + i) - BigInt(200 + i));
      assert.ok(Math.abs(h.imUtilization - (400 + i) / (1000 + i)) < 1e-6);
    });
  });

  it("flags an underwater account with negative mmSurplus", async () => {
    const users = [userAt(0)];
    const { stub } = makeChainStub(() => [100n, 80n, 150n]);
    const [health] = await readAccountHealthBatch(stub, makeConfigStub(), users);
    assert.ok(health, "result has one element");
    assert.equal(health.mmSurplus, -50n);
    assert.ok(health.mmSurplus < 0n, "mmSurplus<0 means liquidatable");
  });

  it("chunks the user list when above chunkSize and concatenates results in order", async () => {
    const users = Array.from({ length: 5 }, (_, i) => userAt(i));
    const { stub, getInvocations } = makeChainStub((calls) =>
      calls.map((_, idx) => {
        const triple = idx % 3;
        // Embed the per-call user index into the bigint so we can verify ordering.
        const u = Math.floor(idx / 3);
        if (triple === 0) return BigInt(10_000 + u);
        if (triple === 1) return BigInt(20_000 + u);
        return BigInt(30_000 + u);
      }),
    );

    const result = await readAccountHealthBatch(stub, makeConfigStub(), users, 2);

    // 5 users / chunk 2 = 3 multicalls
    assert.equal(getInvocations(), 3);
    assert.equal(result.length, 5);
    // The per-chunk user index resets to 0 each chunk, so chunk-aware decoding:
    // chunks: [u0,u1], [u2,u3], [u4]
    const chunkLayout = [
      { offset: 0, len: 2 },
      { offset: 2, len: 2 },
      { offset: 4, len: 1 },
    ];
    for (const { offset, len } of chunkLayout) {
      for (let i = 0; i < len; i++) {
        const r = result[offset + i]!;
        assert.equal(r.user, users[offset + i]);
        assert.equal(r.balance, BigInt(10_000 + i));
        assert.equal(r.imRequired, BigInt(20_000 + i));
        assert.equal(r.mmRequired, BigInt(30_000 + i));
      }
    }
  });
});
