import type { Address } from "viem";
import type { AccountHealth } from "../pme/health.ts";

/**
 * Min-heap-style priority queue ordered by `mmSurplus` ASC: the most-underwater
 * account comes off first.
 *
 * **Underwater accounts only.** `upsert` accepts any `AccountHealth` snapshot
 * but only enqueues entries with `mmSurplus < 0`. A snapshot showing the
 * account is now healthy implicitly removes it from the queue. This means
 * the executor never wastes a `planner.run` round-trip on a healthy user —
 * the queue is exactly "things the executor must do".
 *
 * Implementation is a sorted-on-insert array. We expect O(10–100) underwater
 * accounts at peak, far below the threshold where a binary heap matters; if
 * that ever changes, the surface (`upsert`/`remove`/`pop`/`peek`/`size`) is
 * heap-ready.
 *
 * `upsert` is keyed on `health.user`: re-evaluating an account just rewrites
 * its position in the queue rather than inserting a stale duplicate. This is
 * the contract every queue consumer relies on (sweeps fire repeatedly for
 * the same user — multiple deposits, fills, etc.).
 */
export class CoordinatorQueue {
  private items: AccountHealth[] = [];

  /**
   * Inserts or replaces (by user address) keeping the queue sorted by
   * `mmSurplus` ASC (most-underwater first). Healthy snapshots
   * (`mmSurplus >= 0`) are dropped — and remove the user from the queue
   * if they were previously enqueued. Returns true when the user is in the
   * queue after this call.
   */
  upsert(health: AccountHealth): boolean {
    this.removeUser(health.user);
    if (health.mmSurplus >= 0n) return false;
    const insertAt = this.findInsertIndex(health);
    this.items.splice(insertAt, 0, health);
    return true;
  }

  remove(user: Address): void {
    this.removeUser(user);
  }

  /** Pops the most-underwater account (smallest mmSurplus first). */
  pop(): AccountHealth | undefined {
    return this.items.shift();
  }

  /** Non-destructive — useful for the planner's snapshot logic and for tests. */
  peek(): AccountHealth | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  /** Snapshot copy. Iterating the live queue while mutating it is a footgun. */
  snapshot(): readonly AccountHealth[] {
    return [...this.items];
  }

  private removeUser(user: Address): void {
    const idx = this.items.findIndex((h) => h.user === user);
    if (idx >= 0) this.items.splice(idx, 1);
  }

  private findInsertIndex(health: AccountHealth): number {
    // Linear scan is fine at our scale; switch to binary search if N grows.
    for (let i = 0; i < this.items.length; i++) {
      const cur = this.items[i];
      if (cur === undefined) continue;
      if (compare(health, cur) < 0) return i;
    }
    return this.items.length;
  }
}

/**
 * Ordering: most-underwater first (mmSurplus ASC). Returns negative when `a`
 * should come before `b`. Ties on bigint mmSurplus are vanishingly rare and
 * arbitrarily ordered — by definition the queue only holds underwater
 * accounts (`mmSurplus < 0`), so any tiebreak is moot for picking "who's
 * most at risk".
 *
 * Exported for the unit test suite — keeps the policy auditable.
 */
export function compare(a: AccountHealth, b: AccountHealth): number {
  if (a.mmSurplus === b.mmSurplus) return 0;
  // BigInt compare → return -1/0/1 because Math.sign on a bigint difference
  // truncates the wrong way for very large values.
  return a.mmSurplus < b.mmSurplus ? -1 : 1;
}
