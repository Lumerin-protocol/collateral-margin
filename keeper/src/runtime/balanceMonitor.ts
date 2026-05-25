import { formatEther } from "viem";
import type pino from "pino";
import type { Chain } from "../chain.ts";
import type { Config } from "../config.ts";

/**
 * Periodically polls the keeper signer's native gas-token balance and
 * surfaces it through the same logger every other module uses, so an
 * operator who watches the keeper's tail (or pipes it to Loki / CloudWatch)
 * has a clear "is the wallet about to run out of gas?" signal without
 * having to hop into a block explorer.
 *
 * Severity ladder (mirrors how dashboards usually classify gas alerts):
 *
 *   - balance >= low  → INFO  ("balance OK")  — single source of truth
 *     for "the keeper saw N gwei at time T", useful for graphing.
 *   - balance <  low  → WARN  ("balance low") — operator should top up
 *     within the next few hours; nothing is failing yet.
 *   - balance <  crit → ERROR ("balance critical") — next handful of
 *     liquidations / settlements will likely revert with
 *     "insufficient funds for gas". Page on-call.
 *
 * Defaults are sized for Base sepolia / mainnet at ~current gas:
 *   low      = 10 mETH (≈ a few hundred mid-sized txs of headroom)
 *   critical =  1 mETH (≈ a few txs left, top up NOW)
 *
 * The monitor never throws — RPC blips are logged at warn and the next
 * tick retries. Stop is idempotent so the same shutdown sequence used
 * for every other component works.
 */
export class BalanceMonitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  private readonly chain: Chain;
  private readonly config: Config;
  private readonly logger: pino.Logger;

  constructor(chain: Chain, config: Config, logger: pino.Logger) {
    this.chain = chain;
    this.config = config;
    this.logger = logger.child({ component: "balanceMonitor" });
  }

  /** Reads the balance once, logs at the appropriate level, and returns it. */
  async check(): Promise<bigint | undefined> {
    let balance: bigint;
    try {
      balance = await this.chain.publicClient.getBalance({
        address: this.chain.account.address,
      });
    } catch (err) {
      // RPC hiccup — don't crash the keeper, the next tick will retry.
      // Log warn (not error) because a single failed read isn't itself an
      // operational issue; persistent failures will keep firing this log
      // and an `eth_getBalance` outage is usually visible in other module
      // logs anyway.
      this.logger.warn(
        { err, address: this.chain.account.address },
        "balance check failed — will retry next tick",
      );
      return undefined;
    }

    const ctx = {
      address: this.chain.account.address,
      balanceWei: balance.toString(),
      balanceEth: formatEther(balance),
      lowThresholdEth: formatEther(this.config.runtime.balanceLowWei),
      criticalThresholdEth: formatEther(this.config.runtime.balanceCriticalWei),
    };

    if (balance < this.config.runtime.balanceCriticalWei) {
      this.logger.error(
        ctx,
        "keeper signer gas balance CRITICAL — top up now or settlements/liquidations will start reverting with insufficient funds",
      );
    } else if (balance < this.config.runtime.balanceLowWei) {
      this.logger.warn(
        ctx,
        "keeper signer gas balance low — top up soon",
      );
    } else {
      this.logger.info(ctx, "keeper signer gas balance OK");
    }
    return balance;
  }

  /**
   * Performs an immediate check, then schedules periodic polls at
   * `runtime.balanceCheckIntervalMs`. Idempotent — a second call is a
   * no-op so callers don't need to guard against double-start (matches
   * the pattern used by every other long-running component).
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Eager check at boot so an empty wallet is loud immediately, not
    // one full interval later (default 5 min — too long to wait for the
    // first signal during a deploy).
    await this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.config.runtime.balanceCheckIntervalMs);
    // Don't keep the process alive solely for the balance-poll loop —
    // shutdown should proceed even if this timer is mid-cycle.
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
}
