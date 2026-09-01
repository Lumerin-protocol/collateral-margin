import type { Address } from "viem";

export type ParticipantListener = (user: Address) => void;

/** Read/listen surface consumed by scheduling, prediction, and health. */
export interface ParticipantSource {
  list(): Address[];
  size(): number;
  has(user: Address): boolean;
  onAdded(listener: ParticipantListener): () => void;
  onChanged(listener: ParticipantListener): () => void;
}
