import type { PublicClient } from "viem";

function getBaseUrl(pc: PublicClient): string {
  return pc.chain?.blockExplorers?.default?.url?.replace(/\/+$/, "") ?? "";
}

export function txUrl(pc: PublicClient, hash: string): string {
  const base = getBaseUrl(pc);
  return base ? `${base}/tx/${hash}` : hash;
}

export function addrUrl(pc: PublicClient, addr: string): string {
  const base = getBaseUrl(pc);
  return base ? `${base}/address/${addr}` : addr;
}
