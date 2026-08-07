import { type Address, type Hex } from "viem";
import type pino from "pino";
import { FuturesAbi } from "futures-marketplace-abi/Futures.ts";
import { withUnstickRetry } from "../tx/unstick.ts";
import { formatGasCost } from "../tx/gasCost.ts";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";
import type { ParticipantTracker } from "../discovery/tracker.ts";

/**
 * Periodic sweep that closes expired Futures orders via the permissionless
 * `Futures.removeOutdatedOrder(orderId)` entrypoint.
 *
 * Why this lives in the keeper at all: as of Futures v2.11.0 `createOrder` /
 * `createOrders` no longer auto-sweep the caller's stale orders on the hot
 * path (it was costing ~50-100k gas per placement just to walk an empty
 * expired list). Cleanup is now an explicit, permissionless cron job — and
 * the keeper is the natural operator for it because:
 *
 *   1. It already discovers participants (`ParticipantTracker`).
 *   2. It already has the signer + tx-retry plumbing (`withUnstickRetry`).
 *   3. Expired orders pin the owner against `MAX_ORDERS_PER_PARTICIPANT`
 *      and leave dead price levels on the book. Letting them rot makes
 *      every health probe and book read slightly slower forever.
 *
 * Today the keeper eats the gas with no on-chain reward — see the
 * `TODO(keeper-incentive)` block in `Futures.sol` next to `removeOutdatedOrder`
 * for a sketch of a maker-fee-escrow bounty that could pay for this work.
 *
 * Hot path:
 *
 *   tick → for each tracked user:
 *           1. readContract `getUserOrders(user)` — empty? skip
 *           2. multicall `getOrder(id)` for each id → filter expired
 *           3. one `Futures.removeOutdatedOrders([id1, ...])` write
 *              (capped at `outdatedOrders.maxBatchSize`; larger user-side
 *              fan-outs are split into N batches, each its own tx).
 *
 * The typed batch skips stale and not-yet-expired ids on-chain, so a user
 * cancellation or competing keeper cannot revert unrelated cleanup work.
 *
 * Non-futures venues (perps) don't have order expiry so this module is
 * Futures-only by design.
 */

const FUTURES_REMOVE_OUTDATED_ORDERS_ABI = [
  {
    type: "function",
    name: "removeOutdatedOrders",
    stateMutability: "nonpayable",
    inputs: [{ name: "_orderIds", type: "bytes32[]" }],
    outputs: [{ name: "removed", type: "uint256" }],
  },
] as const;

interface ExpiredOrder {
  user: Address;
  orderId: Hex;
  expirationAt: bigint;
}

export class OutdatedOrderSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inflightSweep = false;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly tracker: ParticipantTracker;
  private readonly logger: pino.Logger;
  private readonly ethUsdFeed: EthUsdFeed | undefined;

  constructor(
    chain: Chain,
    config: Config,
    tracker: ParticipantTracker,
    logger: pino.Logger,
    ethUsdFeed?: EthUsdFeed,
  ) {
    this.chain = chain;
    this.config = config;
    this.tracker = tracker;
    this.logger = logger.child({ component: "outdatedOrderSweeper" });
    // Optional ETH/USD source for `gasCostUsd` on confirmed-tx logs.
    this.ethUsdFeed = ethUsdFeed;
  }

  /**
   * Run a single sweep cycle to completion. Public for tests. Idempotent
   * across concurrent calls — a second invocation while one is in flight
   * is dropped (we don't want overlapping sweeps racing on the same nonce).
   */
  async runSweep(): Promise<number> {
    if (this.inflightSweep) {
      this.logger.debug("sweep skipped — previous sweep still running");
      return 0;
    }
    this.inflightSweep = true;
    try {
      const users = this.tracker.list();
      if (users.length === 0) return 0;

      // Pull the chain's view of "now" rather than `Date.now()`. Block
      // timestamps lag wall clock by up to a slot (~2s on Base), and the
      // contract's `OrderNotExpired` guard uses `block.timestamp` — using
      // the same clock here keeps us from broadcasting txs that'll just
      // revert during the brief window around expiry.
      const blockTimestamp = await this.readBlockTimestamp();
      if (blockTimestamp === undefined) return 0;

      const expired = await this.discoverExpired(users, blockTimestamp);
      if (expired.length === 0) {
        this.logger.debug(
          { tracked: users.length },
          "sweep clean — no expired orders",
        );
        return 0;
      }

      this.logger.info(
        { tracked: users.length, expired: expired.length },
        "sweep: closing expired orders",
      );

      const max = Math.max(1, this.config.outdatedOrders.maxBatchSize);
      let closed = 0;
      for (let i = 0; i < expired.length; i += max) {
        const slice = expired.slice(i, i + max);
        try {
          closed += await this.closeBatch(slice);
        } catch (err) {
          this.logger.error(
            { err, batchSize: slice.length },
            "sweep: batch threw — continuing with next batch",
          );
        }
      }
      return closed;
    } catch (err) {
      this.logger.warn({ err }, "sweep failed — will retry next tick");
      return 0;
    } finally {
      this.inflightSweep = false;
    }
  }

  /**
   * Immediate sweep at boot (catches stale orders that built up while the
   * keeper was down), then periodic polls at
   * `outdatedOrders.sweepIntervalMs`. Idempotent — repeated calls are a
   * no-op so the standard wiring sequence in `index.ts` doesn't need
   * special-cased guards.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Fire one eager sweep so an operator deploying after a long outage
    // doesn't have to wait a full interval to see the backlog drained.
    await this.runSweep();
    this.timer = setInterval(() => {
      void this.runSweep();
    }, this.config.outdatedOrders.sweepIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async readBlockTimestamp(): Promise<bigint | undefined> {
    try {
      const block = await this.chain.publicClient.getBlock({
        blockTag: "latest",
      });
      return block.timestamp;
    } catch (err) {
      this.logger.warn({ err }, "getBlock(latest) failed — skipping sweep");
      return undefined;
    }
  }

  /**
   * For each tracked user, read its order ids and hydrate to find
   * `expirationAt < blockTimestamp`. Per-user RPC failure is logged and
   * skipped — one bad address (e.g. recently dropped from the tracker)
   * shouldn't block the rest of the sweep.
   */
  private async discoverExpired(
    users: readonly Address[],
    blockTimestamp: bigint,
  ): Promise<ExpiredOrder[]> {
    const expired: ExpiredOrder[] = [];

    for (const user of users) {
      let orderIds: readonly Hex[];
      try {
        orderIds = (await this.chain.publicClient.readContract({
          address: this.config.futures.address,
          abi: FuturesAbi,
          functionName: "getUserOrders",
          args: [user],
        })) as readonly Hex[];
      } catch (err) {
        this.logger.warn(
          { err, user },
          "getUserOrders failed — skipping user this sweep",
        );
        continue;
      }
      if (orderIds.length === 0) continue;

      let orders: ReadonlyArray<{ expirationAt: bigint }>;
      try {
        orders = (await this.chain.publicClient.multicall({
          contracts: orderIds.map((id) => ({
            address: this.config.futures.address,
            abi: FuturesAbi,
            functionName: "getOrder" as const,
            args: [id] as const,
          })),
          allowFailure: false,
        })) as ReadonlyArray<{ expirationAt: bigint }>;
      } catch (err) {
        this.logger.warn(
          { err, user, orderCount: orderIds.length },
          "multicall(getOrder) failed — skipping user this sweep",
        );
        continue;
      }

      for (let i = 0; i < orderIds.length; i++) {
        const order = orders[i];
        const orderId = orderIds[i] as Hex;
        if (order === undefined) continue;
        // Matches the contract guard: `expirationAt >= block.timestamp` reverts
        // `OrderNotExpired`. Use strict-less-than here so we don't broadcast
        // a tx in the very-edge case `expirationAt == blockTimestamp` (next
        // block will satisfy it cleanly).
        if (order.expirationAt < blockTimestamp) {
          expired.push({ user, orderId, expirationAt: order.expirationAt });
        }
      }
    }
    return expired;
  }

  /**
   * Sends one race-tolerant `removeOutdatedOrders(ids)` write. The contract
   * skips stale/live ids and preserves every valid cleanup in the batch.
   */
  private async closeBatch(batch: readonly ExpiredOrder[]): Promise<number> {
    if (batch.length === 0) return 0;

    if (this.config.keeper.dryRun) {
      this.logger.info(
        { batchSize: batch.length },
        "[dryRun] would call Futures.removeOutdatedOrders",
      );
      return 0;
    }

    const orderIds = batch.map((entry) => entry.orderId);

    type WriteParams = Parameters<
      typeof this.chain.walletClient.writeContract
    >[0];
    let hash: Hex;
    try {
      // Same wallet that liquidates / settles — if a previous run left a
      // stuck pending tx in the mempool we need to clear it before this
      // sweep can broadcast. `withUnstickRetry` handles the common case
      // automatically; anything still broken after that surfaces normally.
      hash = await withUnstickRetry(this.chain, this.logger, () =>
        this.chain.walletClient.writeContract({
          address: this.config.futures.address,
          abi: FUTURES_REMOVE_OUTDATED_ORDERS_ABI,
          functionName: "removeOutdatedOrders",
          args: [orderIds],
          account: this.chain.account,
          chain: this.chain.walletClient.chain ?? null,
        } as unknown as WriteParams),
      );
    } catch (err) {
      // Transient tx-submission failure → next sweep retries. We don't
      // want unhandled rejection on the setInterval-fired path to crash
      // the keeper, so always swallow and log.
      this.logger.warn(
        { err, batchSize: batch.length },
        "tx submission failed — sweep will retry",
      );
      return 0;
    }

    const receipt = await this.chain.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: this.config.coordinator.confirmationBlocks,
    });
    this.logger.info(
      {
        hash,
        blockNumber: receipt.blockNumber.toString(),
        batchSize: batch.length,
        ...formatGasCost(receipt, this.ethUsdFeed),
      },
      "removeOutdatedOrders confirmed",
    );
    return batch.length;
  }
}
