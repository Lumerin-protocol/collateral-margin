/**
 * handleTransfer classifies receipt logs: internal moves, borrows, and repayments.
 * The matchstick runner does not load subgraph context, so callers land in OTHER.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { accountOf, deployVaultFixture, FUND, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleTransfer", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("records an internal move and attributes it to OTHER", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([100n], { account: alice.account, chain: null });
    await vault.write.deposit([20n], { account: alice.account, chain: null });
    await vault.write.internalTransfer([alice.account.address, bob.account.address, 35n], {
      account: engine.account,
      chain: null,
    });

    const aliceAddr = alice.account.address.toLowerCase();
    const bobAddr = bob.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([
      read("Vault", "0"),
      read("VaultUser", aliceAddr),
      read("VaultUser", bobAddr),
    ]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.internalTransferCount), "1");
    assert.equal(num(state.insuranceDebt), "0");

    const aliceUser = snap.entity("VaultUser", aliceAddr) ?? accountOf(snap.saved("VaultUser"), aliceAddr);
    const bobUser = snap.entity("VaultUser", bobAddr) ?? accountOf(snap.saved("VaultUser"), bobAddr);
    assert.ok(aliceUser);
    assert.ok(bobUser);
    assert.equal(num(aliceUser.balance), "85");
    assert.equal(num(bobUser.balance), "35");
    assert.equal(num(aliceUser.netInternalIn), "-35");
    assert.equal(num(bobUser.netInternalIn), "35");
    assert.equal(num(aliceUser.netFromOther), "-35");
    assert.equal(num(bobUser.netFromOther), "35");
    assert.equal(num(aliceUser.netFromPerps), "0");
    assert.equal(num(bobUser.netFromOptions), "0");

    const transfers = snap.saved("VaultInternalTransfer");
    assert.equal(transfers.length, 1);
    assert.equal(lower(transfers[0]?.from), aliceAddr);
    assert.equal(lower(transfers[0]?.to), bobAddr);
    assert.equal(num(transfers[0]?.amount), "35");
    assert.equal(transfers[0]?.callerCategory, "OTHER");
    assert.equal(snap.saved("InsuranceDebtEvent").length, 0);
  });

  it("moves an existing fund balance without opening debt", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.depositInsuranceFund([50n], { account: owner.account, chain: null });
    await vault.write.settleTransfer([FUND, bob.account.address, 20n], {
      account: engine.account,
      chain: null,
    });

    const bobAddr = bob.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([
      read("Vault", "0"),
      read("VaultUser", bobAddr),
      read("VaultUser", FUND),
    ]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.insuranceDebt), "0");
    assert.equal(num(state.insuranceFundBalance), "30");
    assert.equal(snap.saved("InsuranceDebtEvent").length, 0);

    const bobUser = snap.entity("VaultUser", bobAddr) ?? accountOf(snap.saved("VaultUser"), bobAddr);
    const fundUser = snap.entity("VaultUser", FUND) ?? accountOf(snap.saved("VaultUser"), FUND);
    assert.ok(bobUser);
    assert.ok(fundUser);
    assert.equal(num(bobUser.balance), "20");
    assert.equal(num(fundUser.balance), "30");
  });

  it("repays only the amount that reached the fund", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.settleTransfer([FUND, bob.account.address, 40n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.deposit([15n], { account: alice.account, chain: null });
    await vault.write.settleTransfer([alice.account.address, FUND, 15n], {
      account: engine.account,
      chain: null,
    });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.insuranceDebt), "25");
    assert.equal(num(state.insuranceDebtBorrowedTotal), "40");
    assert.equal(num(state.insuranceDebtRepaidTotal), "15");
    assert.equal(num(state.timingDebt), "25");
    assert.equal(num(state.uncoveredLoss), "0");
    assert.equal(num(state.insuranceFundBalance), "0");

    assert.deepEqual(
      snap.saved("InsuranceDebtEvent").map((row) => [row.kind, num(row.amount), num(row.debtAfter)]),
      [
        ["BORROW", "40", "40"],
        ["REPAY", "15", "25"],
      ],
    );
  });

  it("borrows on an unmarked mint and repays on each fund burn through a settlement cycle", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, alice, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([50n], { account: alice.account, chain: null });
    await vault.write.settleTransfer([FUND, bob.account.address, 20n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.settleTransfer([alice.account.address, FUND, 60n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.settleTransfer([FUND, owner.account.address, 40n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.depositInsuranceFund([10n], { account: owner.account, chain: null });

    const aliceAddr = alice.account.address.toLowerCase();
    const bobAddr = bob.account.address.toLowerCase();
    const ownerAddr = owner.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([
      read("Vault", "0"),
      read("VaultUser", aliceAddr),
      read("VaultUser", bobAddr),
      read("VaultUser", ownerAddr),
      read("VaultUser", FUND),
    ]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.insuranceDebt), "0");
    assert.equal(num(state.insuranceDebtBorrowedTotal), "30");
    assert.equal(num(state.insuranceDebtRepaidTotal), "30");
    assert.equal(num(state.timingDebt), "0");
    assert.equal(num(state.uncoveredLoss), "0");
    assert.equal(num(state.insuranceFundBalance), "0");
    assert.equal(num(state.totalSupply), "60");
    assert.equal(num(state.pendingDepositAmount), "0");

    assert.deepEqual(
      snap.saved("InsuranceDebtEvent").map((row) => [row.kind, num(row.amount), num(row.debtAfter)]),
      [
        ["BORROW", "20", "20"],
        ["REPAY", "20", "0"],
        ["BORROW", "10", "10"],
        ["REPAY", "10", "0"],
      ],
    );

    const bobUser = snap.entity("VaultUser", bobAddr) ?? accountOf(snap.saved("VaultUser"), bobAddr);
    const ownerUser = snap.entity("VaultUser", ownerAddr) ?? accountOf(snap.saved("VaultUser"), ownerAddr);
    const fundUser = snap.entity("VaultUser", FUND) ?? accountOf(snap.saved("VaultUser"), FUND);
    assert.ok(bobUser);
    assert.ok(ownerUser);
    assert.ok(fundUser);
    assert.equal(num(bobUser.balance), "20");
    assert.equal(num(bobUser.netFromOther), "20");
    assert.equal(num(ownerUser.balance), "40");
    assert.equal(num(ownerUser.netFromOther), "40");
    assert.equal(num(fundUser.balance), "0");
  });
});
