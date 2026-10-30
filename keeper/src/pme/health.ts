import type pino from "pino";
import type { Address } from "viem";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import { CollateralVaultAbi } from "collateral-margin-abi/CollateralVault.ts";
import { PortfolioMarginEngineAbi } from "collateral-margin-abi/PortfolioMarginEngine.ts";

/**
 * Snapshot of an account's portfolio-margin state at a single block.
 *
 * `mmSurplus` and `imRequired` are sourced from the PortfolioMarginEngine
 * (single source of truth — both venues' on-chain liquidation predicates
 * resolve back to it).
 */
export interface AccountHealth {
  user: Address;
  balance: bigint;
  imRequired: bigint;
  mmRequired: bigint;
  /** balance - mmRequired. Negative = liquidatable. */
  mmSurplus: bigint;
  /** imRequired / balance. >1 means below IM. Used by the alert ranker. */
  imUtilization: number;
}

/** Default chunk size for the multicall. Each user costs 3 calls. */
const DEFAULT_CHUNK_SIZE = 64;

/**
 * Reads `(balanceOf, computePortfolioIM, computePortfolioMM)` for every
 * supplied user in a single multicall (chunked when the user list is large).
 *
 * Each account settles on its own: an account whose reads revert (a venue's
 * `getRiskView` failing makes the engine revert for that account) is logged at
 * error level and left out, so it cannot hide the rest of its chunk. Callers that
 * need the account treat the missing entry as a failure.
 */
export async function readAccountHealthBatch(
  chain: Chain,
  config: Config,
  users: readonly Address[],
  opts: { chunkSize?: number; logger?: pino.Logger } = {},
): Promise<AccountHealth[]> {
  if (users.length === 0) return [];
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const result: AccountHealth[] = [];
  for (let i = 0; i < users.length; i += chunkSize) {
    const chunk = users.slice(i, i + chunkSize);
    const calls = chunk.flatMap((user) => [
      {
        address: config.vault.address,
        abi: CollateralVaultAbi,
        functionName: "balanceOf" as const,
        args: [user] as const,
      },
      {
        address: config.pme.address,
        abi: PortfolioMarginEngineAbi,
        functionName: "computePortfolioIM" as const,
        args: [user] as const,
      },
      {
        address: config.pme.address,
        abi: PortfolioMarginEngineAbi,
        functionName: "computePortfolioMM" as const,
        args: [user] as const,
      },
    ]);

    const reads = await chain.publicClient.multicall({
      contracts: calls,
      allowFailure: true,
    });

    chunk.forEach((user, j) => {
      const triple = [reads[j * 3], reads[j * 3 + 1], reads[j * 3 + 2]];
      const failed = triple.find((r) => r?.status !== "success");
      if (failed !== undefined) {
        opts.logger?.error(
          {
            user,
            err:
              failed?.error instanceof Error
                ? failed.error.message
                : String(failed?.error),
          },
          "account health read failed",
        );
        return;
      }
      const [balance, imRequired, mmRequired] = triple.map(
        (r) => r?.result as bigint,
      ) as [bigint, bigint, bigint];
      result.push({
        user,
        balance,
        imRequired,
        mmRequired,
        mmSurplus: balance - mmRequired,
        imUtilization: computeUtilization(imRequired, balance),
      });
    });
  }

  return result;
}

/**
 * `imRequired / balance` as a JS `number`. Returns:
 *   - `0`        when both balance and imRequired are 0 (idle account)
 *   - `Infinity` when balance is 0 but imRequired isn't (broken — already underwater)
 *   - clamped to a finite number otherwise
 *
 * We accept the precision loss because this value only drives alert ranking
 * (warn / critical thresholds are configured as JS numbers in `Config`); the
 * MM predicate itself stays in BigInt land via `mmSurplus`.
 */
export function computeUtilization(
  imRequired: bigint,
  balance: bigint,
): number {
  if (balance === 0n) {
    return imRequired === 0n ? 0 : Number.POSITIVE_INFINITY;
  }
  // Scale into ppm so we keep ~6 decimal digits of precision before the float cast.
  const ppm = (imRequired * 1_000_000n) / balance;
  return Number(ppm) / 1_000_000;
}
