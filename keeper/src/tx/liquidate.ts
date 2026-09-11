import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
import { formatGasCost } from "./gasCost.ts";

/**
 * Common shape returned by all liquidate-style calls. Either we earned a fee
 * (positive on success, possibly 0n when the contract caps it at the user's
 * remaining balance), or we hit a known recoverable revert and surface it as
 * a `skipped` reason for the planner.
 */
export type LiquidateOutcome<S extends string> =
  | { feeEarned: bigint; receipt: TransactionReceipt | null }
  | { skipped: S };

/** Reverts we treat as recoverable (planner re-plans rather than crashing). */
type KnownRevert =
  | "NotLiquidatable"
  | "OrdersStillOpen"
  | "OverLiquidation"
  | "OrderNotBelongToUser"
  | "OrderNotBelongToParticipant"
  | "PositionNotBelongToParticipant"
  | "PositionNotExists";

const RECOVERABLE_REVERTS = new Set<KnownRevert>([
  "NotLiquidatable",
  "OrdersStillOpen",
  // A mis-sized batch (off-chain snapshot raced a price move) that overshoots
  // the IM buffer reverts `OverLiquidation` — recoverable: the planner
  // re-snapshots and re-sizes on the next iteration rather than crashing.
  "OverLiquidation",
  "OrderNotBelongToUser",
  "OrderNotBelongToParticipant",
  "PositionNotBelongToParticipant",
  "PositionNotExists",
]);

interface SendLiquidateOptions<S extends string> {
  chain: Chain;
  config: Config;
  logger: pino.Logger;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /**
   * Event name on the supplied ABI whose `fee` (or `liquidatorFee`) field is
   * summed across the receipt to produce `feeEarned`. Pass `null` when no fee
   * is paid (e.g. an order-only liquidation that earns nothing per leg).
   */
  feeEventName: string | null;
  /**
   * Maps a recoverable revert's `errorName` onto the venue-specific skip
   * reason. Unmapped recoverable reverts are still surfaced as `{ skipped }`
   * — defaults to "notLiquidatable" so the planner keeps moving.
   */
  mapSkip?: (errorName: KnownRevert) => S;
  /**
   * Optional ETH/USD price source. When provided the confirmation log
   * picks up a `gasCostUsd` field alongside `gasCostEth`. Always
   * optional so deployments without a configured feed stay supported.
   */
  ethUsdFeed?: EthUsdFeed;
}

/**
 * Simulates a liquidate-style call, sends it (unless `dryRun` is on), and
 * extracts `feeEarned` from the receipt. Recoverable reverts surface as
 * `{ skipped }` — anything else throws.
 *
 * Splitting "what to call" (caller) from "how to send + parse + decode
 * reverts" (this helper) keeps the venue adapters short and uniform. The
 * helper takes a runtime `Abi` (not a generic) — viem's `simulateContract`
 * overloads require literal-narrowed function names to typecheck cleanly,
 * which we can't provide for arbitrary callers; the caller is responsible for
 * making sure `functionName`/`args`/`feeEventName` match the supplied `abi`.
 */
export async function sendLiquidate<S extends string>(
  opts: SendLiquidateOptions<S>,
): Promise<LiquidateOutcome<S>> {
  const {
    chain,
    config,
    logger,
    address,
    abi,
    functionName,
    args,
    feeEventName,
    mapSkip,
    ethUsdFeed,
  } = opts;

  // Always simulate first — this is how we surface the recoverable reverts
  // before we burn gas on a tx that can't possibly succeed. Viem's overloads
  // need literal abi inference to typecheck the request shape, so we cast at
  // the boundary; the runtime ABI is still validated by viem internally.
  type SimParams = Parameters<typeof chain.publicClient.simulateContract>[0];
  type SimReturn = Awaited<ReturnType<typeof chain.publicClient.simulateContract>>;
  let request: SimReturn["request"];
  try {
    const sim = (await chain.publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: chain.account,
    } as unknown as SimParams)) as SimReturn;
    request = sim.request;
  } catch (err) {
    const decoded = decodeRecoverableRevert(err);
    if (decoded) {
      logger.debug({ functionName, args, revert: decoded }, "Liquidate skipped (recoverable revert)");
      return {
        skipped: (mapSkip ? mapSkip(decoded) : ("notLiquidatable" as unknown as S)) as S,
      };
    }
    throw err;
  }

  if (config.keeper.dryRun) {
    logger.info({ functionName, args }, "[dryRun] would send liquidate tx");
    return { feeEarned: 0n, receipt: null };
  }

  type WriteParams = Parameters<typeof chain.walletClient.writeContract>[0];
  const hash = await chain.walletClient.writeContract(request as unknown as WriteParams);
  const receipt = await chain.publicClient.waitForTransactionReceipt({
    hash,
    confirmations: config.coordinator.confirmationBlocks,
  });

  const feeEarned = feeEventName === null ? 0n : sumFees(abi, receipt, feeEventName);
  logger.info(
    { functionName, args, hash, feeEarned, ...formatGasCost(receipt, ethUsdFeed) },
    "Liquidate tx confirmed",
  );
  return { feeEarned, receipt };
}

/**
 * Walks viem's nested error chain looking for a `ContractFunctionRevertedError`
 * whose `errorName` matches one of the keeper's recoverable reverts.
 * Returns `undefined` for any other failure (RPC errors, unknown custom
 * errors, etc.) — those bubble up.
 */
function decodeRecoverableRevert(err: unknown): KnownRevert | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  const name = revert.data?.errorName;
  if (typeof name !== "string") return undefined;
  return RECOVERABLE_REVERTS.has(name as KnownRevert) ? (name as KnownRevert) : undefined;
}

/**
 * Sums the `fee` (or `liquidatorFee`) field across every matching event in the
 * receipt. Both venues emit one event per liquidated order/position carrying
 * the per-leg fee, so this naturally aggregates batch calls
 * (`liquidateOrders` cancels N orders → N events → summed fees).
 */
function sumFees(abi: Abi, receipt: TransactionReceipt, eventName: string): bigint {
  const logs = parseEventLogs({
    abi,
    logs: receipt.logs,
    eventName: eventName as never,
  });
  let total = 0n;
  for (const log of logs as Array<{ args: Record<string, unknown> }>) {
    const fee = log.args.fee ?? log.args.liquidatorFee;
    if (typeof fee === "bigint") total += fee;
  }
  return total;
}

/** Exposed for unit tests so we can assert the planner's revert-handling shape. */
export const __testing = { decodeRecoverableRevert, sumFees };

export type { Hex };
