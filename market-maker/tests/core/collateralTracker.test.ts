import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { CollateralTracker } from "../../src/core/collateralTracker.ts";
import type { CollateralAccount, CollateralSnapshot } from "../../src/core/adapter.ts";

const logger = pino({ level: "silent" });

function makeAccount(initial: Partial<CollateralSnapshot>): {
  account: CollateralAccount;
  deposits: bigint[];
  setBalance: (b: bigint) => void;
} {
  let snap: CollateralSnapshot = {
    vaultBalance: 0n,
    portfolioIM: 0n,
    portfolioMM: 0n,
    venueOrderMargin: 0n,
    venueUnrealizedPnl: 0n,
    walletTokenBalance: 0n,
    nativeBalance: 0n,
    collateralToken: "0x0000000000000000000000000000000000000001",
    ...initial,
  };
  const deposits: bigint[] = [];
  const account: CollateralAccount = {
    snapshot: async () => snap,
    imSpotShock: async () => 0n,
    deposit: async (amount) => {
      deposits.push(amount);
      snap = { ...snap, walletTokenBalance: snap.walletTokenBalance - amount, vaultBalance: snap.vaultBalance + amount };
    },
    canPlace: async () => true,
  };
  return { account, deposits, setBalance: (b) => { snap = { ...snap, walletTokenBalance: b }; } };
}

describe("CollateralTracker.maybeTopUp", () => {
  let env: ReturnType<typeof makeAccount>;
  beforeEach(() => {
    env = makeAccount({});
  });

  it("does nothing when autoDeposit is disabled", async () => {
    env.setBalance(100_000_000n);
    const t = new CollateralTracker(env.account, { autoDeposit: false, autoDepositMinAmount: 0n }, logger);
    await t.update();
    await t.maybeTopUp();
    assert.deepStrictEqual(env.deposits, []);
  });

  it("skips deposit when balance is below minAmount (dust filter)", async () => {
    env.setBalance(500_000n); // 0.5 USDC
    const t = new CollateralTracker(
      env.account,
      { autoDeposit: true, autoDepositMinAmount: 1_000_000n }, // 1 USDC
      logger,
    );
    await t.update();
    await t.maybeTopUp();
    assert.deepStrictEqual(env.deposits, []);
  });

  it("sweeps the full wallet balance when threshold is met and no max", async () => {
    env.setBalance(50_000_000n); // 50 USDC
    const t = new CollateralTracker(
      env.account,
      { autoDeposit: true, autoDepositMinAmount: 1_000_000n },
      logger,
    );
    await t.update();
    await t.maybeTopUp();
    assert.deepStrictEqual(env.deposits, [50_000_000n]);
  });

  it("caps deposit so the vault balance does not exceed maxCollateralAmount", async () => {
    env = makeAccount({ vaultBalance: 30_000_000n }); // 30 USDC already in vault
    env.setBalance(500_000_000n); // 500 USDC in wallet
    const t = new CollateralTracker(
      env.account,
      {
        autoDeposit: true,
        autoDepositMinAmount: 1_000_000n,
        maxCollateralAmount: 100_000_000n, // ceiling: 100 USDC total in vault
      },
      logger,
    );
    await t.update();
    await t.maybeTopUp();
    // headroom = 100 − 30 = 70 USDC
    assert.deepStrictEqual(env.deposits, [70_000_000n]);
  });

  it("deposits full wallet balance when vault is well below maxCollateralAmount", async () => {
    env = makeAccount({ vaultBalance: 10_000_000n }); // 10 USDC in vault
    env.setBalance(40_000_000n); // 40 USDC in wallet
    const t = new CollateralTracker(
      env.account,
      {
        autoDeposit: true,
        autoDepositMinAmount: 1_000_000n,
        maxCollateralAmount: 100_000_000n,
      },
      logger,
    );
    await t.update();
    await t.maybeTopUp();
    // headroom = 90 USDC, wallet = 40 USDC → deposit full wallet
    assert.deepStrictEqual(env.deposits, [40_000_000n]);
  });

  it("skips deposit when vault is already at or above maxCollateralAmount", async () => {
    env = makeAccount({ vaultBalance: 100_000_000n }); // already at ceiling
    env.setBalance(50_000_000n);
    const t = new CollateralTracker(
      env.account,
      {
        autoDeposit: true,
        autoDepositMinAmount: 1_000_000n,
        maxCollateralAmount: 100_000_000n,
      },
      logger,
    );
    await t.update();
    await t.maybeTopUp();
    assert.deepStrictEqual(env.deposits, []);
  });
});
