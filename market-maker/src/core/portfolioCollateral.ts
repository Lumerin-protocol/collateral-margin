import type { PublicClient } from "viem";
import {
  type CollateralAccount,
  type CollateralSnapshot,
  isBatchableCollateralAccount,
} from "./adapter.ts";

/**
 * Composes one or more venue `CollateralAccount`s into a single portfolio view
 * for the shared `CollateralTracker`.
 *
 * Vault balance and portfolio IM/MM are per-wallet on the shared engine, so
 * they are identical across venues. Venue-specific order margin and unrealized
 * PnL are summed. The pre-trade gate, deposit, and IM-shock hit the shared
 * vault/engine and delegate to the first account.
 *
 * Fast path: when every account exposes a `buildMarginReadPlan()` (the concrete
 * perps/futures accounts do), all venues are fused into ONE multicall — the
 * shared vault/IM/MM/wallet/native reads happen exactly once and only the
 * per-venue order-margin/PnL reads scale with venue count. Falls back to
 * per-account `snapshot()` (one RPC each) for any non-batchable account.
 */
export class PortfolioCollateralAccount implements CollateralAccount {
  private readonly accounts: CollateralAccount[];
  private readonly publicClient: PublicClient;

  constructor(accounts: CollateralAccount[], publicClient: PublicClient) {
    if (accounts.length === 0) {
      throw new Error("PortfolioCollateralAccount requires at least one account");
    }
    this.accounts = accounts;
    this.publicClient = publicClient;
  }

  async snapshot(): Promise<CollateralSnapshot> {
    if (this.accounts.every(isBatchableCollateralAccount)) {
      return this.batchedSnapshot();
    }
    return this.perAccountSnapshot();
  }

  /** Single multicall across all venues; shared reads counted once. */
  private async batchedSnapshot(): Promise<CollateralSnapshot> {
    const batchable = this.accounts.filter(isBatchableCollateralAccount);
    const plans = await Promise.all(batchable.map((a) => a.buildMarginReadPlan()));

    // Shared reads are identical across venues (same wallet/vault/engine/token),
    // so we take them from the first plan and read them just once.
    const shared = plans[0].shared;
    const contracts = [...shared, ...plans.flatMap((p) => p.venue)];
    const results = await this.publicClient.multicall({ allowFailure: false, contracts });

    const sharedResults = results.slice(0, shared.length);
    let offset = shared.length;
    let venueOrderMargin = 0n;
    let venueUnrealizedPnl = 0n;
    let primary: CollateralSnapshot | null = null;

    for (const plan of plans) {
      const venueResults = results.slice(offset, offset + plan.venue.length);
      offset += plan.venue.length;
      const snap = plan.decode([...sharedResults, ...venueResults]);
      if (!primary) primary = snap;
      venueOrderMargin += snap.venueOrderMargin;
      venueUnrealizedPnl += snap.venueUnrealizedPnl;
    }

    return { ...(primary as CollateralSnapshot), venueOrderMargin, venueUnrealizedPnl };
  }

  /** Fallback: one snapshot RPC per account. */
  private async perAccountSnapshot(): Promise<CollateralSnapshot> {
    const snaps = await Promise.all(this.accounts.map((a) => a.snapshot()));
    const primary = snaps[0];
    let venueOrderMargin = 0n;
    let venueUnrealizedPnl = 0n;
    for (const s of snaps) {
      venueOrderMargin += s.venueOrderMargin;
      venueUnrealizedPnl += s.venueUnrealizedPnl;
    }
    return { ...primary, venueOrderMargin, venueUnrealizedPnl };
  }

  imSpotShock(): Promise<bigint> {
    return this.accounts[0].imSpotShock();
  }

  deposit(amount: bigint): Promise<void> {
    return this.accounts[0].deposit(amount);
  }

  canPlace(additionalIM: bigint): Promise<boolean> {
    return this.accounts[0].canPlace(additionalIM);
  }
}
