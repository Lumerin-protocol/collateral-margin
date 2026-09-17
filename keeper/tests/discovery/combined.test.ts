import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import { CombinedParticipantSource } from "../../src/discovery/combined.ts";
import type {
  ParticipantListener,
  ParticipantSource,
} from "../../src/discovery/types.ts";

const USER_A = "0x00000000000000000000000000000000000000A1" as Address;
const USER_B = "0x00000000000000000000000000000000000000B2" as Address;
const USER_C = "0x00000000000000000000000000000000000000C3" as Address;

class StubSource implements ParticipantSource {
  private readonly users = new Set<Address>();
  private readonly added = new Set<ParticipantListener>();
  private readonly changed = new Set<ParticipantListener>();

  constructor(users: readonly Address[]) {
    for (const user of users) this.users.add(getAddress(user));
  }

  list(): Address[] {
    return Array.from(this.users);
  }
  size(): number {
    return this.users.size;
  }
  has(user: Address): boolean {
    return this.users.has(getAddress(user));
  }
  onAdded(listener: ParticipantListener): () => void {
    this.added.add(listener);
    return () => this.added.delete(listener);
  }
  onChanged(listener: ParticipantListener): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }
  add(user: Address): void {
    const checksummed = getAddress(user);
    this.users.add(checksummed);
    for (const listener of this.added) listener(checksummed);
  }
}

describe("CombinedParticipantSource", () => {
  it("deduplicates users from perps/vault and Futures sources", () => {
    const combined = new CombinedParticipantSource([
      new StubSource([USER_A, USER_B]),
      new StubSource([USER_B, USER_C]),
    ]);
    assert.deepEqual(combined.list(), [
      getAddress(USER_A),
      getAddress(USER_B),
      getAddress(USER_C),
    ]);
    assert.equal(combined.size(), 3);
  });

  it("forwards newly discovered Futures users to listeners", () => {
    const futures = new StubSource([]);
    const combined = new CombinedParticipantSource([
      new StubSource([USER_A]),
      futures,
    ]);
    const seen: Address[] = [];
    const dispose = combined.onAdded((user) => seen.push(user));
    futures.add(USER_C);
    assert.deepEqual(seen, [getAddress(USER_C)]);
    dispose();
  });
});
