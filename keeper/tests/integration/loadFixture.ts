import type { Hex, TestClient } from "viem";

/**
 * Viem-native re-implementation of Hardhat's `loadFixture`.
 *
 * First call:                       run the fixture fn, take `evm_snapshot`,
 *                                   cache `{ snapshotId, data }` keyed by fn.
 * Subsequent calls (same fn ref):   `evm_revert` to the cached snapshot, then
 *                                   immediately re-`evm_snapshot` (Hardhat's
 *                                   snapshots are consumed on revert, so we
 *                                   have to retake one), return cached data.
 *
 * The cache is keyed by the fixture function *reference*, so each scenario
 * gets its own snapshot. Two different fixtures that build on a shared
 * baseline don't share snapshots — they each pay the full deploy cost on
 * first invocation, then are O(1) thereafter. That's the same trade-off
 * Hardhat makes; it keeps the snapshot bookkeeping trivial.
 *
 * The fixture's return value (typically the deploy addresses + viem
 * contract handles) survives revert because EVM state including deployer
 * nonces is rolled back too — addresses are deterministic in `evm_revert`'s
 * world view, so cached contract handles keep working.
 */
type FixtureFn<T> = () => Promise<T>;

interface CacheEntry {
  snapshotId: Hex;
  data: unknown;
}

const cache = new WeakMap<FixtureFn<unknown>, CacheEntry>();

/**
 * Drop the snapshot cache. Useful between test files when a previous file
 * mutated state that the next file's fixture should not inherit. Ordinary
 * intra-file usage doesn't need this — same-fixture calls revert correctly.
 */
export function resetFixtureCache(): void {
  // WeakMap has no clear() — replace by re-initialising. We hold the only
  // reference, so the old map is GC-able as soon as we drop the binding.
  for (const k of __keys()) cache.delete(k);
}

const allKeys: FixtureFn<unknown>[] = [];
function __keys(): readonly FixtureFn<unknown>[] {
  return allKeys;
}

/**
 * Load (or revert to) a fixture's snapshot. Pass the same `fn` reference on
 * every call — wrapping the fixture in a lambda each test case defeats the
 * cache and reverts to "redeploy on every test".
 */
export async function loadFixture<T>(fn: FixtureFn<T>, tc: TestClient): Promise<T> {
  const cached = cache.get(fn as FixtureFn<unknown>);
  if (cached !== undefined) {
    // `revert` returns true on success; if it fails (e.g. snapshot ID
    // invalidated by another revert path) we fall through to redeploy.
    const reverted = (await tc.request({
      method: "evm_revert",
      params: [cached.snapshotId] as unknown as never,
    })) as unknown as boolean;
    if (reverted) {
      const fresh = (await tc.request({
        method: "evm_snapshot",
        params: [] as unknown as never,
      })) as unknown as Hex;
      cache.set(fn as FixtureFn<unknown>, { snapshotId: fresh, data: cached.data });
      return cached.data as T;
    }
    cache.delete(fn as FixtureFn<unknown>);
  }
  const data = await fn();
  const snapshotId = (await tc.request({
    method: "evm_snapshot",
    params: [] as unknown as never,
  })) as unknown as Hex;
  cache.set(fn as FixtureFn<unknown>, { snapshotId, data });
  allKeys.push(fn as FixtureFn<unknown>);
  return data;
}
