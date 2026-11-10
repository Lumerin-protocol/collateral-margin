import type { Address } from "viem";

export type ParticipantListener = (user: Address) => void;

/** Read/listen surface consumed by scheduling, prediction, and health. */
export interface ParticipantSource {
  list(): Address[];
  size(): number;
  has(user: Address): boolean;
  onAdded(listener: ParticipantListener): () => void;
  onChanged(listener: ParticipantListener): () => void;
  /**
   * Starts a sweep's prune: the returned function drops the given users unless
   * an event touched them after this call, and returns how many it dropped.
   * Sources that bound themselves leave it out.
   */
  idlePruner?(): (idle: readonly Address[]) => number;
}
