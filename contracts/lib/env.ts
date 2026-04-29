import { loadEnvFile } from "node:process";
import { type Address, isAddress, zeroAddress } from "viem";

/** Returns true if all specified env variables are set */
export function requireEnvsSet<T extends string>(
  ...envs: [T, ...T[]]
): Record<(typeof envs)[number], string> {
  for (const envName of envs) {
    if (!process.env[envName]) {
      throw new Error(`Environment variable ${envName} is required but not set`);
    }
  }
  return process.env as Record<(typeof envs)[number], string>;
}

export function tryLoadEnvFile(path: string): void {
  try {
    loadEnvFile(path);
  } catch (err: unknown) {
    console.info(`Failed to load env file ${path}:\n${(err as Error).message}`);
  }
}

/** Read a required env var, throwing if it's not a valid 0x address. */
export function requireAddress(name: string): Address {
  const raw = process.env[name];
  if (!raw) throw new Error(`Environment variable ${name} is required but not set`);
  if (!isAddress(raw))
    throw new Error(`Environment variable ${name} is not a valid address: ${raw}`);
  return raw;
}

/** Read an optional env var as an address. Empty/unset and the zero address are
 *  both treated as `undefined` so callers can branch with a single check. */
export function readOptionalAddress(name: string): Address | undefined {
  const raw = process.env[name];
  if (!raw || raw === zeroAddress) return undefined;
  if (!isAddress(raw))
    throw new Error(`Environment variable ${name} is not a valid address: ${raw}`);
  return raw;
}

/** Read an optional env var as a bigint. Empty/unset → `undefined`. */
export function readOptionalBigInt(name: string): bigint | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return BigInt(raw);
}
