import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { accountOf, deployVaultFixture, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleDeposited", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("counts a self deposit and leaves the following mint out of insurance debt", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([100n], { account: alice.account, chain: null });

    const aliceAddr = alice.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0"), read("VaultUser", aliceAddr)]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.totalDeposited), "100");
    assert.equal(num(state.depositCount), "1");
    assert.equal(num(state.insuranceDebt), "0");
    assert.equal(num(state.pendingDepositAmount), "0");

    const aliceUser = snap.entity("VaultUser", aliceAddr) ?? accountOf(snap.saved("VaultUser"), aliceAddr);
    assert.ok(aliceUser);
    assert.equal(num(aliceUser.balance), "100");
    assert.equal(num(aliceUser.totalDeposited), "100");

    const deposits = snap.saved("VaultDeposit");
    assert.equal(deposits.length, 1);
    assert.equal(lower(deposits[0]?.user), aliceAddr);
    assert.equal(lower(deposits[0]?.sender), aliceAddr);
    assert.equal(deposits[0]?.isInsuranceFund, false);
    assert.equal(num(deposits[0]?.amount), "100");
    assert.equal(snap.saved("InsuranceDebtEvent").length, 0);
  });

  it("credits the recipient and records the account that supplied the collateral", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, bob } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.depositFor([bob.account.address, 70n], { account: owner.account, chain: null });

    const bobAddr = bob.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0"), read("VaultUser", bobAddr)]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.totalDeposited), "70");
    assert.equal(num(state.depositCount), "1");
    assert.equal(num(state.insuranceDebt), "0");

    const bobUser = snap.entity("VaultUser", bobAddr) ?? accountOf(snap.saved("VaultUser"), bobAddr);
    assert.ok(bobUser);
    assert.equal(num(bobUser.balance), "70");
    assert.equal(num(bobUser.totalDeposited), "70");
    assert.equal(num(bobUser.netFromOther), "0");

    const deposits = snap.saved("VaultDeposit");
    assert.equal(deposits.length, 1);
    assert.equal(lower(deposits[0]?.user), bobAddr);
    assert.equal(lower(deposits[0]?.sender), owner.account.address.toLowerCase());
    assert.equal(deposits[0]?.isInsuranceFund, false);
    assert.equal(snap.saved("InsuranceDebtEvent").length, 0);
  });
});
