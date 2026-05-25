import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import type { PlanOutcome } from "../../src/coordinator/planner.ts";
import type { KeeperHarness } from "./buildKeeper.ts";
import type { DeployedStack } from "./deployStack.ts";

/**
 * Integration-test helpers.
 *
 * The goal of this module is to keep test bodies short and read like a
 * spec: a scenario is loaded as a fixture, the test asks "what did the
 * keeper do?", and helpers translate that into rich assertions with
 * BigInt-safe failure messages.
 *
 * Three layers, in order of how often they're called from a test:
 *   1. Action helpers (`runOneSweep`, `discoverUser`) — drive the keeper.
 *   2. Observation helpers (`readPerpsPosition`, `readFuturesPositions`,
 *      `expectPerpsClosed`, ...) — query final on-chain state.
 *   3. Outcome assertions (`expectLiquidated`, `expectHealthy`, ...) — type-
 *      narrow `PlanOutcome` and surface its fields when an assert fails.
 */

// ─────────────────────────────────────────────────────────────────────────
// Action helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * `ParticipantTracker` is event-driven — there's a small RPC-poll delay
 * between a user's first on-chain action and the keeper "knowing" about
 * them. Every test that wants the keeper to act on `user` must call this
 * first, otherwise `runSweep` / `planner.run` will short-circuit on an
 * empty user set.
 */
export async function discoverUser(
  keeper: KeeperHarness,
  user: Address,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(() => keeper.tracker.has(user), timeoutMs);
}

/**
 * `discoverUser` + flush any in-flight `PredictiveCoordinator` rebuilds.
 * Use this in tests that need the predictor's *initial* (pre-crash)
 * thresholds to be indexed before the price moves — otherwise the
 * predictor would build its first snapshot using an already-underwater
 * account, and `solveLiquidationThresholds` would short-circuit.
 */
export async function discoverAndIndex(
  keeper: KeeperHarness,
  user: Address,
  timeoutMs = 10_000,
): Promise<void> {
  await discoverUser(keeper, user, timeoutMs);
  await keeper.predictor.awaitIdle();
}

/**
 * Drive one full scheduler sweep for `user`. Wraps `discoverUser` so
 * tests don't repeat the same prelude every time. The sweep populates the
 * coordinator queue from the tracker, and the executor's worker loop
 * picks `user` up from there.
 */
export async function runOneSweep(keeper: KeeperHarness, user: Address): Promise<void> {
  await discoverUser(keeper, user);
  await keeper.scheduler.runSweep();
}

// ─────────────────────────────────────────────────────────────────────────
// On-chain observation helpers
// ─────────────────────────────────────────────────────────────────────────

export interface PerpsPosition {
  /** Signed; positive = long, negative = short, zero = flat. */
  netQuantity: bigint;
  aggregatedEntryPrice: bigint;
}

export async function readPerpsPosition(
  stack: DeployedStack,
  user: Address,
): Promise<PerpsPosition> {
  return (await stack.publicClient.readContract({
    address: stack.addresses.perps,
    abi: stack.abis.perps,
    functionName: "getUserPosition",
    args: [user],
  })) as PerpsPosition;
}

export async function readPerpsOrderIds(
  stack: DeployedStack,
  user: Address,
): Promise<readonly Hex[]> {
  return (await stack.publicClient.readContract({
    address: stack.addresses.perps,
    abi: stack.abis.perps,
    functionName: "getUserOrders",
    args: [user],
  })) as readonly Hex[];
}

export async function readFuturesPositionIds(
  stack: DeployedStack,
  user: Address,
): Promise<readonly Hex[]> {
  return (await stack.publicClient.readContract({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    functionName: "getPositionIds",
    args: [user],
  })) as readonly Hex[];
}

export async function readFuturesOrderIds(
  stack: DeployedStack,
  user: Address,
): Promise<readonly Hex[]> {
  return (await stack.publicClient.readContract({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    functionName: "getOrderIds",
    args: [user],
  })) as readonly Hex[];
}

/** Resolves to true once `user` is flat on perps. */
export async function expectPerpsClosed(
  stack: DeployedStack,
  user: Address,
  timeoutMs = 30_000,
): Promise<void> {
  await waitFor(async () => (await readPerpsPosition(stack, user)).netQuantity === 0n, timeoutMs);
}

/** Resolves to true once `user` has no futures positions. */
export async function expectFuturesClosed(
  stack: DeployedStack,
  user: Address,
  timeoutMs = 30_000,
): Promise<void> {
  await waitFor(async () => (await readFuturesPositionIds(stack, user)).length === 0, timeoutMs);
}

/** Resolves to true once `user` has no open orders on either venue. */
export async function expectNoOpenOrders(
  stack: DeployedStack,
  user: Address,
  timeoutMs = 30_000,
): Promise<void> {
  await waitFor(async () => {
    const [perps, futures] = await Promise.all([
      readPerpsOrderIds(stack, user),
      readFuturesOrderIds(stack, user),
    ]);
    return perps.length === 0 && futures.length === 0;
  }, timeoutMs);
}

// ─────────────────────────────────────────────────────────────────────────
// Liquidation-event ordering helpers
// ─────────────────────────────────────────────────────────────────────────
//
// All four readers return the *earliest* block number a given event was
// emitted at for `user`, or `null` if no matching event was emitted.
// Tests then compare block numbers across helpers to assert the planner's
// invariants (orders-leg before position-leg, worst-leg first, etc).
//
// The perps event indexes `user`; the futures event indexes `participant`.
// viem doesn't auto-translate, so each helper passes the right kwarg.

export const readPerpsPositionLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "perps", "PositionLiquidated", { user: u });

export const readFuturesPositionLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "futures", "PositionLiquidated", { participant: u });

export const readPerpsOrderLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "perps", "OrderLiquidated", { user: u });

export const readFuturesOrderLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "futures", "OrderLiquidated", { participant: u });

/**
 * Earliest block at which `Futures.PositionDeliveryClosed(positionId)` was
 * emitted. Used by the delivery-coordinator e2e tests to confirm the keeper
 * actually sent `closeDelivery` for a specific position id.
 */
export async function readPositionDeliveryClosedBlock(
  stack: DeployedStack,
  positionId: Hex,
): Promise<bigint | null> {
  const logs = await stack.publicClient.getContractEvents({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    eventName: "PositionDeliveryClosed",
    args: { positionId },
    fromBlock: 0n,
  });
  let earliest: bigint | null = null;
  for (const log of logs) {
    if (log.blockNumber === null) continue;
    if (earliest === null || log.blockNumber < earliest) earliest = log.blockNumber;
  }
  return earliest;
}

async function earliestEventBlock(
  stack: DeployedStack,
  venue: "perps" | "futures",
  eventName: "PositionLiquidated" | "OrderLiquidated",
  args: Record<string, Address>,
): Promise<bigint | null> {
  const logs = await stack.publicClient.getContractEvents({
    address: stack.addresses[venue],
    abi: stack.abis[venue],
    eventName,
    args,
    fromBlock: 0n,
  });
  let earliest: bigint | null = null;
  for (const log of logs) {
    if (log.blockNumber === null) continue;
    if (earliest === null || log.blockNumber < earliest) earliest = log.blockNumber;
  }
  return earliest;
}

// ─────────────────────────────────────────────────────────────────────────
// PlanOutcome assertions
// ─────────────────────────────────────────────────────────────────────────

/**
 * Asserts `outcome.kind === "liquidated"` and returns it narrowed. The
 * caller can then read `feeEarned`, `ordersClosed`, `positionsClosed` to
 * verify *how* the planner closed the account (orders-only vs position
 * loop vs both).
 */
export function expectLiquidated(outcome: PlanOutcome): Extract<PlanOutcome, { kind: "liquidated" }> {
  assert.equal(
    outcome.kind,
    "liquidated",
    `expected liquidated outcome, got: ${formatOutcome(outcome)}`,
  );
  return outcome as Extract<PlanOutcome, { kind: "liquidated" }>;
}

export function expectHealthy(outcome: PlanOutcome): Extract<PlanOutcome, { kind: "healthy" }> {
  assert.equal(outcome.kind, "healthy", `expected healthy outcome, got: ${formatOutcome(outcome)}`);
  return outcome as Extract<PlanOutcome, { kind: "healthy" }>;
}

export function expectBadDebt(outcome: PlanOutcome): Extract<PlanOutcome, { kind: "badDebt" }> {
  assert.equal(outcome.kind, "badDebt", `expected badDebt outcome, got: ${formatOutcome(outcome)}`);
  return outcome as Extract<PlanOutcome, { kind: "badDebt" }>;
}

export function expectActioned(outcome: PlanOutcome): void {
  assert.ok(
    outcome.kind === "liquidated" || outcome.kind === "badDebt",
    `expected planner to settle the account (liquidated or badDebt), got: ${formatOutcome(outcome)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * Polls `predicate` every 100ms until it returns truthy or `timeoutMs`
 * elapses. Async predicates are supported; an internal `await` keeps us
 * from re-entering the same RPC call concurrently.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`waitFor: predicate did not pass within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `PlanOutcome` carries `bigint` fields (`mmSurplus`, `feeEarned`) which
 * `JSON.stringify` chokes on. Format manually so failing asserts produce
 * useful diagnostics rather than `TypeError: Do not know how to serialize
 * a BigInt`.
 */
export function formatOutcome(outcome: PlanOutcome | { kind: string; [k: string]: unknown }): string {
  const parts = Object.entries(outcome).map(
    ([k, v]) => `${k}=${typeof v === "bigint" ? `${v}n` : JSON.stringify(v)}`,
  );
  return `{ ${parts.join(", ")} }`;
}

/** Type guard for alert webhook bodies — used by the notifier test. */
export function isCriticalAlert(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "severity" in body &&
    (body as { severity: unknown }).severity === "critical"
  );
}
