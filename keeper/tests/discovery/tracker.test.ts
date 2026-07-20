import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import type pino from "pino";
import { ParticipantTracker } from "../../src/discovery/tracker.ts";
import type { Chain } from "../../src/chain.ts";
import type { Config } from "../../src/config.ts";

function userAt(idx: number): Address {
  return getAddress(`0x${(idx + 1).toString(16).padStart(40, "0")}` as Address);
}

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as pino.Logger;

/**
 * Backfill is event-source driven: each `getContractEvents` call carries an
 * `address` and `eventName`. The script keys log lists by `"address:eventName"`
 * (lowercased address) so perps and futures `OrderCreated` don't collide.
 * Anything not in the map returns []. `readContract` is still stubbed for
 * tests that need it.
 */
function scriptKey(address: Address, eventName: string): string {
  return `${address.toLowerCase()}:${eventName}`;
}

function makeChain(
  opts: {
    perpsUsers?: readonly Address[];
    readContractFails?: boolean;
    eventScript?: Record<string, readonly unknown[]>;
    getContractEventsFails?: boolean;
    blockNumber?: bigint;
  } = {},
): Chain {
  return {
    publicClient: {
      readContract: async () => {
        if (opts.readContractFails) throw new Error("rpc down");
        return opts.perpsUsers ?? [];
      },
      getBlockNumber: async () => opts.blockNumber ?? 1000n,
      getContractEvents: async ({
        address,
        eventName,
      }: {
        address: Address;
        eventName: string;
      }) => {
        if (opts.getContractEventsFails) throw new Error("rpc down");
        return opts.eventScript?.[scriptKey(address, eventName)] ?? [];
      },
      // start() iterates watchContractEvent — return a no-op unwatcher.
      watchContractEvent: () => () => undefined,
    },
  } as unknown as Chain;
}

function makeConfig(opts: { discoveryMode?: Config["chain"]["discoveryMode"] } = {}): Config {
  return {
    chain: { discoveryMode: opts.discoveryMode ?? "events" },
    vault: { address: userAt(100) },
    perps: { address: userAt(101) },
    futures: { address: userAt(102) },
  } as Config;
}

describe("ParticipantTracker: add / remove / list", () => {
  it("dedupes additions and reports `added` only on first insert", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    assert.equal(t.add(userAt(0)), true, "first add");
    assert.equal(t.add(userAt(0)), false, "duplicate");
    assert.equal(t.size(), 1);
  });

  it("treats addresses as case-insensitive (checksum-normalised)", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    const lower = userAt(0).toLowerCase() as Address;
    const upper = getAddress(userAt(0));
    assert.equal(t.add(lower), true);
    assert.equal(t.add(upper), false, "same address, different case = same entry");
    assert.equal(t.size(), 1);
    assert.ok(t.has(lower));
    assert.ok(t.has(upper));
  });

  it("addBatch returns the count of new additions, not total", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    t.add(userAt(0));
    const added = t.addBatch([userAt(0), userAt(1), userAt(2)]);
    assert.equal(added, 2, "userAt(0) was already present");
    assert.equal(t.size(), 3);
  });

  it("remove returns true only if the user was tracked", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    t.add(userAt(0));
    assert.equal(t.remove(userAt(0)), true);
    assert.equal(t.remove(userAt(0)), false);
  });

  it("list returns a snapshot — mutating it doesn't affect the tracker", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    t.addBatch([userAt(0), userAt(1)]);
    const snap = t.list();
    snap.pop();
    assert.equal(t.size(), 2);
  });
});

describe("ParticipantTracker: onAdded listeners", () => {
  it("invokes every registered listener with the new address", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    const seen: Address[] = [];
    t.onAdded((u) => seen.push(u));
    t.add(userAt(0));
    t.add(userAt(1));
    assert.deepEqual(seen, [getAddress(userAt(0)), getAddress(userAt(1))]);
  });

  it("does not invoke listeners on duplicate adds", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    let calls = 0;
    t.onAdded(() => calls++);
    t.add(userAt(0));
    t.add(userAt(0));
    assert.equal(calls, 1);
  });

  it("unsubscribe stops further notifications", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    let calls = 0;
    const off = t.onAdded(() => calls++);
    t.add(userAt(0));
    off();
    t.add(userAt(1));
    assert.equal(calls, 1);
  });

  it("a throwing listener doesn't block the others", () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    let bCalls = 0;
    t.onAdded(() => {
      throw new Error("boom");
    });
    t.onAdded(() => bCalls++);
    t.add(userAt(0));
    assert.equal(bCalls, 1, "second listener still fired despite first throwing");
  });
});

describe("ParticipantTracker: backfill", () => {
  it("ingests participants from every event source across all chunks", async () => {
    // Each mocked log shape mirrors what viem's getContractEvents would
    // hand to our handlers — only `args` is read. Note the perps/futures
    // OrderCreated logs go to separate handlers keyed by contract address,
    // so the script is keyed (address, eventName).
    const config = makeConfig();
    const t = new ParticipantTracker(
      makeChain({
        blockNumber: 1000n,
        eventScript: {
          [scriptKey(config.vault.address, "Deposited")]: [
            { args: { user: userAt(0) } },
          ],
          [scriptKey(config.vault.address, "Transfer")]: [
            { args: { from: userAt(1), to: userAt(2) } },
          ],
          [scriptKey(config.perps.address, "OrderCreated")]: [
            { args: { participant: userAt(3) } },
          ],
          [scriptKey(config.perps.address, "OrderMatched")]: [
            { args: { maker: userAt(4), taker: userAt(5) } },
          ],
          [scriptKey(config.futures.address, "OrderCreated")]: [
            { args: { participant: userAt(6) } },
          ],
          [scriptKey(config.futures.address, "OrderMatched")]: [
            { args: { maker: userAt(7), taker: userAt(8) } },
          ],
        },
      }),
      config,
      silentLogger,
    );
    await t.backfill(0n, 500n);
    assert.equal(t.size(), 9);
  });

  it("chunks the block range and calls getContractEvents per chunk", async () => {
    const calls: Array<{ from: bigint; to: bigint; eventName: string }> = [];
    const chain = {
      publicClient: {
        getBlockNumber: async () => 2500n,
        getContractEvents: async (params: {
          fromBlock: bigint;
          toBlock: bigint;
          eventName: string;
        }) => {
          calls.push({ from: params.fromBlock, to: params.toBlock, eventName: params.eventName });
          return [];
        },
        watchContractEvent: () => () => undefined,
        readContract: async () => [],
      },
    } as unknown as Chain;
    const t = new ParticipantTracker(chain, makeConfig(), silentLogger);
    await t.backfill(0n, 1000n);
    // 6 sources × 3 chunks ([0,999], [1000,1999], [2000,2500]) = 18 calls.
    assert.equal(calls.length, 18);
    // Spot-check the chunk boundary clamping on the last page.
    const deposited = calls.filter((c) => c.eventName === "Deposited");
    assert.deepEqual(
      deposited.map((c) => [c.from, c.to]),
      [
        [0n, 999n],
        [1000n, 1999n],
        [2000n, 2500n],
      ],
    );
  });

  it("survives an RPC failure on one source and continues with the rest", async () => {
    let calls = 0;
    const chain = {
      publicClient: {
        getBlockNumber: async () => 100n,
        getContractEvents: async ({ eventName }: { eventName: string }) => {
          calls++;
          if (eventName === "Deposited") throw new Error("rpc down");
          if (eventName === "Transfer") return [{ args: { from: userAt(0), to: userAt(1) } }];
          return [];
        },
        watchContractEvent: () => () => undefined,
        readContract: async () => [],
      },
    } as unknown as Chain;
    const t = new ParticipantTracker(chain, makeConfig(), silentLogger);
    await t.backfill(0n, 1000n);
    assert.ok(calls >= 6, "all six sources attempted despite Deposited failure");
    // Transfer still ingested.
    assert.equal(t.size(), 2);
  });

  it("is a no-op when discoveryMode=webhook", async () => {
    let calls = 0;
    const chain = {
      publicClient: {
        getBlockNumber: async () => {
          calls++;
          return 100n;
        },
        getContractEvents: async () => {
          calls++;
          return [];
        },
        watchContractEvent: () => () => undefined,
        readContract: async () => [],
      },
    } as unknown as Chain;
    const t = new ParticipantTracker(chain, makeConfig({ discoveryMode: "webhook" }), silentLogger);
    await t.backfill(0n, 1000n);
    assert.equal(calls, 0, "no RPC traffic in webhook-only mode");
  });

  it("returns early when fromBlock > head", async () => {
    let eventCalls = 0;
    const chain = {
      publicClient: {
        getBlockNumber: async () => 50n,
        getContractEvents: async () => {
          eventCalls++;
          return [];
        },
        watchContractEvent: () => () => undefined,
        readContract: async () => [],
      },
    } as unknown as Chain;
    const t = new ParticipantTracker(chain, makeConfig(), silentLogger);
    await t.backfill(100n, 10n);
    assert.equal(eventCalls, 0);
  });

  it("rejects non-positive chunkSize", async () => {
    const t = new ParticipantTracker(makeChain(), makeConfig(), silentLogger);
    await assert.rejects(() => t.backfill(0n, 0n), /chunkSize must be positive/);
  });

  it("reads perps OrderCreated from `participant`, not `user`", async () => {
    // Regression: an earlier generic handler read `args.user`, which doesn't
    // exist on perps OrderCreated — the actual field is `participant`. The
    // typed per-event handler must read the correct field or this user
    // never gets added until OrderMatched fires.
    const config = makeConfig();
    const t = new ParticipantTracker(
      makeChain({
        blockNumber: 100n,
        eventScript: {
          [scriptKey(config.perps.address, "OrderCreated")]: [
            { args: { participant: userAt(7) } },
            { args: { user: userAt(8) } }, // wrong field — must be ignored
          ],
        },
      }),
      config,
      silentLogger,
    );
    await t.backfill(0n, 1000n);
    assert.equal(t.has(userAt(7)), true, "participant address tracked");
    assert.equal(t.has(userAt(8)), false, "stray `user` field ignored");
  });
});

describe("ParticipantTracker: discoveryMode gating", () => {
  it("start() is a no-op (no subscriptions wired) when discoveryMode=webhook", async () => {
    let watchCount = 0;
    const chain = {
      publicClient: {
        watchContractEvent: () => {
          watchCount++;
          return () => undefined;
        },
        readContract: async () => [],
      },
    } as unknown as Chain;
    const t = new ParticipantTracker(chain, makeConfig({ discoveryMode: "webhook" }), silentLogger);
    await t.start();
    assert.equal(watchCount, 0, "no subscriptions opened in webhook-only mode");
  });

  it("start() wires multiple subscriptions when discoveryMode=events", async () => {
    let watchCount = 0;
    const chain = {
      publicClient: {
        watchContractEvent: () => {
          watchCount++;
          return () => undefined;
        },
        readContract: async () => [],
      },
    } as unknown as Chain;
    const t = new ParticipantTracker(chain, makeConfig({ discoveryMode: "events" }), silentLogger);
    await t.start();
    assert.ok(watchCount >= 4, `expected ≥4 subscriptions, got ${watchCount}`);
    t.stop();
  });
});
