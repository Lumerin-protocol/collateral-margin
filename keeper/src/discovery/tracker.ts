import {
  getAddress,
  type Address,
  type Hex,
  type Log,
  zeroAddress,
} from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";
import type { ParticipantListener, ParticipantSource } from "./types.ts";
import { CollateralVaultAbi as collateralVaultAbi } from "collateral-margin-abi/CollateralVault.ts";
import { HashPowerPerpsDEXAbi as perpsAbi } from "derivatives-marketplace-abi/HashPowerPerpsDEX.ts";
import { isProtocolAccount } from "../protocolAccounts.ts";

/**
 * Set of perps participants the keeper needs to monitor, added on perps
 * `OrderCreated` / `OrderMatched`. Futures discovery is expiry-scoped and
 * owned by `FuturesExpiryIndex`.
 *
 * Vault `Deposited` / `Transfer` only fire the `changed` listeners. They never
 * add a user: a balance alone cannot be liquidated, and `depositFor(any, 1)`
 * costs only gas, so tracking every depositor lets spam slow every sweep
 * (CF-183). A funded user enters the set on their first perps order.
 *
 * On startup, `backfill(fromBlock)` scans the perps events historically via
 * `getLogs` so the cold-start window doesn't miss participants who traded
 * before the keeper booted. Steady state is carried by the live
 * `watchContractEvent` subscriptions started in `start()`; backfill closes
 * the gap from `fromBlock` up to the head of the watcher.
 *
 * The tracker is a "set of users to consider" — it never decides whether a
 * user is liquidatable. That's the planner's job. Users are not removed when
 * they go flat: an extra `readAccountHealthBatch` read per dormant trader is
 * far cheaper than missing one.
 */
export type TrackerListener = ParticipantListener;

export class ParticipantTracker implements ParticipantSource {
  private readonly users = new Set<Address>();
  private readonly addedListeners = new Set<TrackerListener>();
  private readonly changedListeners = new Set<TrackerListener>();
  /** Disposers returned by `watchContractEvent` — unwatched on `stop()`. */
  private unwatchers: Array<() => void> = [];

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;

  constructor(chain: Chain, config: Config, logger: pino.Logger) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ component: "tracker" });
  }

  /** Subscribes to the vault and perps events above. */
  async start(): Promise<void> {
    this.logger.info("starting RPC event subscriptions");

    // Each `watchContractEvent` returns an unwatcher fn; we call them all on
    // stop(). Vault Transfer covers both `from` and `to` so we don't need to
    // separately subscribe to ERC20 Approval (no balance change).
    this.unwatchers.push(
      this.chain.publicClient.watchContractEvent({
        address: this.config.vault.address,
        abi: collateralVaultAbi,
        eventName: "Deposited",
        onLogs: (logs) => this.onVaultDeposited(logs),
      }),
      this.chain.publicClient.watchContractEvent({
        address: this.config.vault.address,
        abi: collateralVaultAbi,
        eventName: "Transfer",
        onLogs: (logs) => this.onVaultTransfer(logs),
      }),
      this.chain.publicClient.watchContractEvent({
        address: this.config.perps.address,
        abi: perpsAbi,
        eventName: "OrderCreated",
        onLogs: (logs) => this.onPerpsOrderCreated(logs),
      }),
      this.chain.publicClient.watchContractEvent({
        address: this.config.perps.address,
        abi: perpsAbi,
        eventName: "OrderMatched",
        onLogs: (logs) => this.onPerpsOrderMatched(logs),
      }),
    );
  }

  /** Tears down all subscriptions. Idempotent. */
  stop(): void {
    for (const u of this.unwatchers) {
      try {
        u();
      } catch (err) {
        this.logger.warn({ err }, "unwatcher threw — continuing shutdown");
      }
    }
    this.unwatchers = [];
  }

  /**
   * One-shot historical backfill. Scans the perps events `start()`
   * subscribes to from `fromBlock` to the current head via `getLogs`, in
   * chunks of `chunkSize` blocks, and feeds each match through the same
   * handlers the live watcher uses. Run once at startup *after* `start()`
   * has wired the forward subscriptions — the small overlap between the
   * scan head and the watcher's polling cursor is fine, because `add()`
   * dedupes on checksum.
   *
   * Futures history is deliberately excluded: its bounded per-expiry replay
   * lives in `FuturesExpiryIndex`.
   */
  async backfill(fromBlock: bigint, chunkSize: bigint): Promise<void> {
    if (chunkSize <= 0n) {
      throw new Error(`backfill chunkSize must be positive, got ${chunkSize}`);
    }

    const head = await this.chain.publicClient.getBlockNumber();
    if (fromBlock > head) {
      this.logger.warn(
        { fromBlock: fromBlock.toString(), head: head.toString() },
        "backfill fromBlock > head — nothing to do",
      );
      return;
    }

    const before = this.users.size;
    this.logger.info(
      {
        fromBlock: fromBlock.toString(),
        head: head.toString(),
        chunkSize: chunkSize.toString(),
      },
      "backfill: starting",
    );

    // Each source = one event we live-subscribe to in `start()`. We page
    // through the block range independently per source so a single failing
    // RPC call only drops that source's contribution, not the whole pass.
    // The `dispatch` for each source is the SAME function the live watcher
    // calls in `start()` — historical and live logs land in identical code
    // paths, so any future field renames touch exactly one place.
    // Vault events are live-only: they add no users, and a `changed` signal
    // for history is meaningless before anyone subscribes.
    const sources: Array<{
      label: string;
      run: (from: bigint, to: bigint) => Promise<void>;
    }> = [
      {
        label: "perps.OrderCreated",
        run: async (from, to) => {
          const logs = await this.chain.publicClient.getContractEvents({
            address: this.config.perps.address,
            abi: perpsAbi,
            eventName: "OrderCreated",
            fromBlock: from,
            toBlock: to,
          });
          this.onPerpsOrderCreated(logs as unknown as readonly Log[]);
        },
      },
      {
        label: "perps.OrderMatched",
        run: async (from, to) => {
          const logs = await this.chain.publicClient.getContractEvents({
            address: this.config.perps.address,
            abi: perpsAbi,
            eventName: "OrderMatched",
            fromBlock: from,
            toBlock: to,
          });
          this.onPerpsOrderMatched(logs as unknown as readonly Log[]);
        },
      },
    ];

    for (const source of sources) {
      let chunkErrors = 0;
      for (let start = fromBlock; start <= head; start += chunkSize) {
        const end =
          start + chunkSize - 1n > head ? head : start + chunkSize - 1n;
        try {
          await source.run(start, end);
        } catch (err) {
          chunkErrors++;
          this.logger.error(
            {
              err,
              source: source.label,
              from: start.toString(),
              to: end.toString(),
            },
            "backfill chunk failed",
          );
        }
      }
      if (chunkErrors > 0) {
        this.logger.warn(
          { source: source.label, chunkErrors },
          "backfill source completed with chunk errors — some users may be missing until next event",
        );
      }
    }

    const added = this.users.size - before;
    this.logger.info(
      { added, total: this.users.size, head: head.toString() },
      "backfill: complete",
    );
  }

  /**
   * Manually add a user. Used by external callers that need to inject a
   * user (e.g. ad-hoc CLI commands).
   */
  add(user: Address): boolean {
    const checksummed = getAddress(user);
    // The backstop appears as a taker in its own fills; protocol accounts are
    // never liquidatable.
    if (isProtocolAccount(checksummed)) return false;
    if (this.users.has(checksummed)) return false;
    this.users.add(checksummed);
    this.logger.debug(
      { user: checksummed, total: this.users.size },
      "tracker.add",
    );
    for (const l of this.addedListeners) {
      try {
        l(checksummed);
      } catch (err) {
        this.logger.error({ err, user: checksummed }, "added listener threw");
      }
    }
    return true;
  }

  addBatch(users: readonly Address[]): number {
    let added = 0;
    for (const u of users) if (this.add(u)) added++;
    return added;
  }

  /** Returns true if the user was tracked. We rarely call this — see class doc. */
  remove(user: Address): boolean {
    return this.users.delete(getAddress(user));
  }

  list(): Address[] {
    return Array.from(this.users);
  }

  size(): number {
    return this.users.size;
  }

  has(user: Address): boolean {
    return this.users.has(getAddress(user));
  }

  /**
   * Subscribe to add events. Used by the runtime layer to refresh
   * `AccountHealth` and re-rank the queue whenever a new participant is
   * discovered. Returns an unsubscribe function.
   */
  onAdded(listener: TrackerListener): () => void {
    this.addedListeners.add(listener);
    return () => this.addedListeners.delete(listener);
  }

  /**
   * Subscribe to "user state may have changed" events. Fires for the same
   * triggers `onAdded` does, plus any time a tracked user's state could
   * have shifted (vault transfer in/out, perps OrderCreated/Matched,
   * Futures changes are delivered by `FuturesExpiryIndex`.
   *
   * The predictive layer uses this to invalidate and rebuild a user's
   * cached MM snapshot. Listeners must tolerate being called for users
   * they don't track (we don't filter — checking `users.has` here would
   * race with `add`).
   */
  onChanged(listener: TrackerListener): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  /**
   * Internal: fire the `changed` listeners for `user`. Called by every log
   * handler that observes a state-changing event. We swallow exceptions so
   * one bad listener can't poison the watcher.
   */
  private notifyChanged(user: Address): void {
    for (const l of this.changedListeners) {
      try {
        l(user);
      } catch (err) {
        this.logger.error({ err, user }, "changed listener threw");
      }
    }
  }

  // -- log handlers ---------------------------------------------------------
  // One handler per (contract, event) — never branch inside on event kind.
  // Each handler types the `args` shape to the exact event's payload so a
  // future ABI rename surfaces as a compile error here rather than silent
  // data loss. Logs missing `args` (malformed / undecodable) are skipped —
  // better to miss a candidate than to crash the watcher.

  /**
   * Helper used by every log handler: ensure `user` is tracked AND notify
   * the `changed` listeners. Splitting "add" from "changed" lets the
   * predictive layer rebuild a user's snapshot on every relevant event,
   * not just the first one.
   */
  private touch(user: Address): void {
    this.add(user);
    this.notifyChanged(getAddress(user));
  }

  /**
   * `Deposited(address indexed user, uint256 amount, address indexed sender)`.
   * Only `user` (the credited account) is the keeper's concern — `sender`
   * is the funding wallet and doesn't own the resulting balance.
   */
  private onVaultDeposited(logs: readonly Log[]): void {
    type Args = { user?: Address; sender?: Address; amount?: bigint };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.user !== undefined) this.notifyChanged(getAddress(args.user));
    }
  }

  /**
   * `Transfer(address indexed from, address indexed to, uint256 value)`.
   * A balance change on either side can move a tracked user's health.
   */
  private onVaultTransfer(logs: readonly Log[]): void {
    type Args = { from?: Address; to?: Address; value?: bigint };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args === undefined) continue;
      if (args.from !== undefined && args.from !== zeroAddress)
        this.notifyChanged(getAddress(args.from));
      if (args.to !== undefined && args.to !== zeroAddress)
        this.notifyChanged(getAddress(args.to));
    }
  }

  /**
   * `OrderCreated(bytes32 indexed orderId, address indexed participant,
   *               uint256 price, int256 quantity)`.
   * NOTE: the perps event field is `participant`, not `user`.
   */
  private onPerpsOrderCreated(logs: readonly Log[]): void {
    type Args = {
      orderId?: Hex;
      participant?: Address;
      price?: bigint;
      quantity?: bigint;
    };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args?.participant !== undefined) this.touch(args.participant);
    }
  }

  /**
   * `OrderMatched(bytes32 indexed makerOrderId, address indexed maker,
   *               address indexed taker, uint256 tradePrice, ...)`.
   */
  private onPerpsOrderMatched(logs: readonly Log[]): void {
    type Args = { makerOrderId?: Hex; maker?: Address; taker?: Address };
    for (const raw of logs) {
      const args = (raw as unknown as { args?: Args }).args;
      if (args === undefined) continue;
      if (args.maker !== undefined) this.touch(args.maker);
      if (args.taker !== undefined) this.touch(args.taker);
    }
  }
}
