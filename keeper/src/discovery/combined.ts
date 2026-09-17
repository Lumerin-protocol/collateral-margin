import { getAddress, type Address } from "viem";
import type {
  ParticipantListener,
  ParticipantSource,
} from "./types.ts";

/** Deduplicated live union of independent participant discovery sources. */
export class CombinedParticipantSource implements ParticipantSource {
  private readonly sources: readonly ParticipantSource[];

  constructor(sources: readonly ParticipantSource[]) {
    this.sources = sources;
  }

  list(): Address[] {
    const users = new Map<string, Address>();
    for (const source of this.sources) {
      for (const user of source.list()) {
        const checksummed = getAddress(user);
        users.set(checksummed.toLowerCase(), checksummed);
      }
    }
    return Array.from(users.values());
  }

  size(): number {
    return this.list().length;
  }

  has(user: Address): boolean {
    return this.sources.some((source) => source.has(user));
  }

  onAdded(listener: ParticipantListener): () => void {
    return combineDisposers(this.sources.map((source) => source.onAdded(listener)));
  }

  onChanged(listener: ParticipantListener): () => void {
    return combineDisposers(
      this.sources.map((source) => source.onChanged(listener)),
    );
  }
}

function combineDisposers(disposers: Array<() => void>): () => void {
  return () => {
    for (const dispose of disposers) dispose();
  };
}
