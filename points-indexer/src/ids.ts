import { BigInt, Bytes } from "@graphprotocol/graph-ts";

/** Stable per-log identifier: `transactionHash || logIndex` (5-byte i32 suffix). */
export function createEventId(transactionHash: Bytes, logIndex: BigInt): Bytes {
  return transactionHash.concatI32(logIndex.toI32());
}
