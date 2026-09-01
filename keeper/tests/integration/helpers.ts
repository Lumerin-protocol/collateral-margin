import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import type { PlanOutcome } from "../../src/coordinator/planner.ts";
import type { KeeperHarness } from "./buildKeeper.ts";
import type { DeployedStack } from "./deployStack.ts";
import { PerpsPositionAbi } from "../../src/venues/perpsPositionAbi.ts";

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
 * Participant discovery is event-driven — there's a small RPC-poll delay
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
  await waitFor(() => keeper.participants.has(user), timeoutMs);
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
  netEntryValue: bigint;
}

export async function readPerpsPosition(
  stack: DeployedStack,
  user: Address,
): Promise<PerpsPosition> {
  return (await stack.publicClient.readContract({
    address: stack.addresses.perps,
    abi: PerpsPositionAbi,
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

/** Active delivery dates for a user's unilateral futures aggregates. */
export async function readFuturesActiveDates(
  stack: DeployedStack,
  user: Address,
): Promise<readonly bigint[]> {
  return (await stack.publicClient.readContract({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    functionName: "getActiveExpirationDates",
    args: [user],
  })) as readonly bigint[];
}

/** @deprecated alias — returns active delivery dates (no longer lot ids). */
export async function readFuturesPositionIds(
  stack: DeployedStack,
  user: Address,
): Promise<readonly Hex[]> {
  const dates = await readFuturesActiveDates(stack, user);
  // Encode expirationAt as bytes32 for callers that still treat them as Hex ids.
  return dates.map((d) => `0x${d.toString(16).padStart(64, "0")}` as Hex);
}

/**
 * Decodes Hex-encoded expirationAt values (from `readFuturesPositionIds`) back
 * to bigint expiries. Kept for multi-expiry balancing tests.
 */
export async function readFuturesLotExpiries(
  _stack: DeployedStack,
  ids: readonly Hex[],
): Promise<Map<Hex, bigint>> {
  return new Map(ids.map((id) => [id, BigInt(id)] as const));
}

export async function readFuturesOrderIds(
  stack: DeployedStack,
  user: Address,
): Promise<readonly Hex[]> {
  const expirationAts = (await stack.publicClient.readContract({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    functionName: "getExpirationDates",
  })) as readonly bigint[];
  if (expirationAts.length === 0) return [];

  const perExpiry = await Promise.all(
    expirationAts.map(
      (expirationAt) =>
        stack.publicClient.readContract({
          address: stack.addresses.futures,
          abi: stack.abis.futures,
          functionName: "getUserOrdersAtExpiration",
          args: [user, expirationAt],
        }) as Promise<readonly Hex[]>,
    ),
  );

  const orderIds: Hex[] = [];
  for (const ids of perExpiry) {
    for (const id of ids) orderIds.push(id);
  }
  return orderIds;
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

export interface AccountMargins {
  balance: bigint;
  imRequired: bigint;
  mmRequired: bigint;
}

/**
 * Reads `(balanceOf, computePortfolioIM, computePortfolioMM)` for `user` — the
 * on-chain source of truth the liquidation predicates (and the end-of-tx
 * `OverLiquidation` guard on `liquidatePositions` / perps `liquidatePosition`)
 * resolve back to.
 * Used by `expectReducedToImBuffer` to assert the account landed inside the
 * `[MM, IM]` band after a batched liquidation. Uses three parallel
 * `readContract` calls (the test's public client has no multicall3 configured,
 * matching every other reader in this file).
 */
export async function readAccountMargins(
  stack: DeployedStack,
  user: Address,
): Promise<AccountMargins> {
  const [balance, imRequired, mmRequired] = await Promise.all([
    stack.publicClient.readContract({
      address: stack.addresses.vault,
      abi: stack.abis.vault,
      functionName: "balanceOf",
      args: [user],
    }) as Promise<bigint>,
    stack.publicClient.readContract({
      address: stack.addresses.pme,
      abi: stack.abis.pme,
      functionName: "computePortfolioIM",
      args: [user],
    }) as Promise<bigint>,
    stack.publicClient.readContract({
      address: stack.addresses.pme,
      abi: stack.abis.pme,
      functionName: "computePortfolioMM",
      args: [user],
    }) as Promise<bigint>,
  ]);
  return { balance, imRequired, mmRequired };
}

/**
 * Asserts the account was liquidated *down to the IM buffer* — i.e. it now
 * sits inside the `[MM, IM]` band:
 *
 *   - `balance >= computePortfolioMM(user)`  → healthy (not re-liquidatable)
 *   - `balance <= computePortfolioIM(user)`  → NOT over-liquidated (the
 *     contract reverts `OverLiquidation` when a partial would leave balance
 *     above IM)
 *
 * Polls until the batched liquidation tx has confirmed (balance drops into or
 * below the IM band) and then makes the hard band assertions with BigInt-safe
 * diagnostics. This is the core acceptance predicate for the close-to-IM
 * behaviour — a subset liquidation must leave the account healthy with a real
 * buffer, not scraping the MM floor and not blown past IM.
 */
export async function expectReducedToImBuffer(
  stack: DeployedStack,
  user: Address,
  timeoutMs = 30_000,
): Promise<AccountMargins> {
  await waitFor(async () => {
    const m = await readAccountMargins(stack, user);
    return m.balance >= m.mmRequired && m.balance <= m.imRequired;
  }, timeoutMs);

  const m = await readAccountMargins(stack, user);
  assert.ok(
    m.balance >= m.mmRequired,
    `expected balance >= MM (healthy after liquidation), got balance=${m.balance}n mm=${m.mmRequired}n`,
  );
  assert.ok(
    m.balance <= m.imRequired,
    `expected balance <= IM (not over-liquidated past the buffer), got balance=${m.balance}n im=${m.imRequired}n`,
  );
  return m;
}

/**
 * Every block a `Futures.PositionLiquidated` event was emitted for `user`.
 * Kept as a list so tests can assert a batched liquidation collapses into a
 * single block (anti-churn).
 */
export async function readFuturesLotLiquidatedBlocks(
  stack: DeployedStack,
  user: Address,
): Promise<bigint[]> {
  const logs = await stack.publicClient.getContractEvents({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    eventName: "PositionLiquidated",
    args: { user },
    fromBlock: 0n,
  });
  const blocks: bigint[] = [];
  for (const log of logs) {
    if (log.blockNumber !== null) blocks.push(log.blockNumber);
  }
  return blocks;
}

/** Absolute contracts closed across all PositionLiquidated events for `user`. */
export async function readFuturesClosedQuantity(
  stack: DeployedStack,
  user: Address,
): Promise<bigint> {
  const logs = await stack.publicClient.getContractEvents({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    eventName: "PositionLiquidated",
    args: { user },
    fromBlock: 0n,
  });
  let sum = 0n;
  for (const log of logs) {
    const q = (log.args as { closedQuantity?: bigint }).closedQuantity;
    if (q === undefined) continue;
    sum += q < 0n ? -q : q;
  }
  return sum;
}

export async function readFuturesNetQuantity(
  stack: DeployedStack,
  user: Address,
  expirationAt: bigint,
): Promise<bigint> {
  const pos = (await stack.publicClient.readContract({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    functionName: "getUserPosition",
    args: [user, expirationAt],
  })) as { netQuantity: bigint };
  return pos.netQuantity;
}

/**
 * Asserts every supplied block number is identical — i.e. the events all rode
 * a single transaction/block. `label` names the batched call for diagnostics.
 * Mirrors the multicall batching invariant asserted in the delivery test.
 */
export function assertSingleBlock(blocks: readonly bigint[], label: string): void {
  assert.ok(blocks.length > 0, `${label}: expected at least one event block`);
  const unique = new Set(blocks.map((b) => b.toString()));
  assert.equal(
    unique.size,
    1,
    `${label}: expected all events in a single block (batched), got ${unique.size} distinct blocks: ${[...unique].join(", ")}`,
  );
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
// Both venues index liquidations on `user` in 3.0.

export const readPerpsPositionLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "perps", "PositionLiquidated", { user: u });

export const readFuturesPositionLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "futures", "PositionLiquidated", { user: u });

export const readPerpsOrderLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "perps", "OrderLiquidated", { user: u });

export const readFuturesOrderLiquidationBlock = (s: DeployedStack, u: Address) =>
  earliestEventBlock(s, "futures", "OrderLiquidated", { user: u });

/**
 * Earliest block at which `Futures.PositionSettled(user, expirationAt)` was
 * emitted. `expirationAtHex` is the bytes32 encoding from `readFuturesPositionIds`.
 */
export async function readLotClosedBlock(
  stack: DeployedStack,
  user: Address,
  expirationAtHex: Hex,
): Promise<bigint | null> {
  const expirationAt = BigInt(expirationAtHex);
  const logs = await stack.publicClient.getContractEvents({
    address: stack.addresses.futures,
    abi: stack.abis.futures,
    eventName: "PositionSettled",
    args: { user, expirationAt },
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
