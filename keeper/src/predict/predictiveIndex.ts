import type { Address } from "viem";
import type { PriceThresholds } from "./types.ts";

/**
 * Crossings emitted by `PredictiveIndex.crossings(prev, next)`. The
 * coordinator translates each crossing into a fresh on-chain health read +
 * `CoordinatorQueue.upsert`.
 */
export interface Crossing {
  user: Address;
  /** Threshold price that was crossed. */
  threshold: bigint;
  /** "down": triggered when spot dropped below threshold (net-long users). */
  direction: "down" | "up";
}

/**
 * Per-user predicted liquidation thresholds, indexed for fast crossing
 * detection on every price tick.
 *
 * Stores two views of the same `PriceThresholds` data:
 *
 *   - `byUser`: keyed lookup for upsert/invalidate.
 *   - `downSorted` / `upSorted`: parallel sorted arrays for O(log N + K)
 *     per-tick crossing lookup, where K is the number of users actually
 *     crossed by this tick.
 *
 * Invariants:
 *   - `byUser.get(addr).liqDown` (when defined) appears exactly once in
 *     `downSorted`. Same for `liqUp` ↔ `upSorted`.
 *   - `downSorted` is sorted ASC by `threshold`. `upSorted` is sorted ASC
 *     by `threshold`. Both choices give us O(log) binary search for the
 *     range of crossings on either side.
 *
 * We deliberately keep both arrays as plain `[]` and re-sort on insert.
 * For our scale (≤ low thousands of underwater-eligible users), this beats
 * a balanced-BST library both in code size and constant factor.
 */
export class PredictiveIndex {
  private readonly byUser = new Map<Address, PriceThresholds>();
  private downSorted: Array<{ threshold: bigint; user: Address }> = [];
  private upSorted: Array<{ threshold: bigint; user: Address }> = [];

  /**
   * Insert or update the user's thresholds. Removes any prior entry for
   * the same user from both sorted arrays before re-inserting. Returns
   * `true` when the user has at least one defined threshold after the call
   * (i.e. is "watched"); `false` if they have neither.
   */
  upsert(thresholds: PriceThresholds): boolean {
    const { user, liqDown, liqUp } = thresholds;
    this.removeUser(user);
    if (liqDown === undefined && liqUp === undefined) return false;
    this.byUser.set(user, thresholds);
    if (liqDown !== undefined) {
      insertSorted(this.downSorted, { threshold: liqDown, user });
    }
    if (liqUp !== undefined) {
      insertSorted(this.upSorted, { threshold: liqUp, user });
    }
    return true;
  }

  /** Remove a user from the index. Idempotent. */
  invalidate(user: Address): void {
    this.removeUser(user);
  }

  /** Lookup the cached thresholds for a user (or `undefined` if untracked). */
  get(user: Address): PriceThresholds | undefined {
    return this.byUser.get(user);
  }

  /** Number of users with at least one defined threshold. */
  size(): number {
    return this.byUser.size;
  }

  /**
   * Find every user whose threshold was crossed by a price move from
   * `prev` to `next`. Both endpoints are inclusive of the boundary —
   * landing exactly on a threshold counts as a crossing because the
   * on-chain `mmSurplus < 0` predicate treats that as an edge-case the
   * planner should re-verify.
   *
   * Crossing rules:
   *   - DOWN-cross fires for users with `liqDown ∈ [next, prev]` when
   *     the price fell (`next < prev`).
   *   - UP-cross fires for users with `liqUp ∈ [prev, next]` when the
   *     price rose (`next > prev`).
   *
   * `prev = undefined` (first tick after start) returns nothing — we don't
   * have a baseline to detect crossings against; the periodic sweep
   * catches anything already in the danger zone.
   */
  crossings(prev: bigint | undefined, next: bigint): Crossing[] {
    if (prev === undefined || next === prev) return [];
    const out: Crossing[] = [];
    if (next < prev) {
      // Falling price: pick downSorted entries with threshold ∈ [next, prev].
      const lo = lowerBound(this.downSorted, next);
      const hi = upperBound(this.downSorted, prev);
      for (let i = lo; i < hi; i++) {
        const entry = this.downSorted[i];
        if (entry === undefined) continue;
        out.push({ user: entry.user, threshold: entry.threshold, direction: "down" });
      }
    } else {
      // Rising price: pick upSorted entries with threshold ∈ [prev, next].
      const lo = lowerBound(this.upSorted, prev);
      const hi = upperBound(this.upSorted, next);
      for (let i = lo; i < hi; i++) {
        const entry = this.upSorted[i];
        if (entry === undefined) continue;
        out.push({ user: entry.user, threshold: entry.threshold, direction: "up" });
      }
    }
    return out;
  }

  /** Snapshot of all tracked users' thresholds (test/debug). */
  snapshot(): readonly PriceThresholds[] {
    return Array.from(this.byUser.values());
  }

  private removeUser(user: Address): void {
    if (!this.byUser.has(user)) return;
    this.byUser.delete(user);
    this.downSorted = this.downSorted.filter((e) => e.user !== user);
    this.upSorted = this.upSorted.filter((e) => e.user !== user);
  }
}

interface SortedEntry {
  threshold: bigint;
  user: Address;
}

function insertSorted(arr: SortedEntry[], entry: SortedEntry): void {
  // Binary insertion — the arrays grow monotonically with tracked users.
  // A real heap is overkill at our scale; sort-on-insert is O(log N) for
  // the search and O(N) for the splice, which beats heap ceremony for
  // ≤ a few thousand entries.
  const idx = lowerBound(arr, entry.threshold);
  arr.splice(idx, 0, entry);
}

/** First index with `arr[i].threshold >= target`. Returns `arr.length` when none. */
function lowerBound(arr: SortedEntry[], target: bigint): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const entry = arr[mid];
    if (entry === undefined || entry.threshold < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with `arr[i].threshold > target`. Returns `arr.length` when none. */
function upperBound(arr: SortedEntry[], target: bigint): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const entry = arr[mid];
    if (entry === undefined || entry.threshold <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
