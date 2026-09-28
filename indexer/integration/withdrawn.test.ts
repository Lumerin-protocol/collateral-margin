import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { accountOf, deployVaultFixture, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleWithdrawn", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("counts a self withdrawal and the receipt burn", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([100n], { account: alice.account, chain: null });
    await vault.write.withdraw([40n], { account: alice.account, chain: null });

    const aliceAddr = alice.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0"), read("VaultUser", aliceAddr)]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.totalWithdrawn), "40");
    assert.equal(num(state.withdrawalCount), "1");
    assert.equal(num(state.totalSupply), "60");
    assert.equal(num(state.insuranceDebt), "0");

    const aliceUser = snap.entity("VaultUser", aliceAddr) ?? accountOf(snap.saved("VaultUser"), aliceAddr);
    assert.ok(aliceUser);
    assert.equal(num(aliceUser.balance), "60");
    assert.equal(num(aliceUser.totalWithdrawn), "40");

    const withdrawals = snap.saved("VaultWithdrawal");
    assert.equal(withdrawals.length, 1);
    assert.equal(lower(withdrawals[0]?.user), aliceAddr);
    assert.equal(lower(withdrawals[0]?.recipient), aliceAddr);
    assert.equal(num(withdrawals[0]?.amount), "40");
    assert.equal(withdrawals[0]?.isInsuranceFund, false);
  });

  it("burns the caller's receipts and records who received the collateral", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([100n], { account: alice.account, chain: null });
    await vault.write.internalTransfer([alice.account.address, engine.account.address, 40n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.withdrawTo([bob.account.address, 40n], { account: engine.account, chain: null });

    const engineAddr = engine.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0"), read("VaultUser", engineAddr)]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.totalWithdrawn), "40");
    assert.equal(num(state.withdrawalCount), "1");
    assert.equal(num(state.totalSupply), "60");

    const withdrawals = snap.saved("VaultWithdrawal");
    assert.equal(withdrawals.length, 1);
    assert.equal(lower(withdrawals[0]?.user), engineAddr);
    assert.equal(lower(withdrawals[0]?.recipient), bob.account.address.toLowerCase());
    assert.equal(num(withdrawals[0]?.amount), "40");
    assert.equal(withdrawals[0]?.isInsuranceFund, false);

    const engineUser = snap.entity("VaultUser", engineAddr) ?? accountOf(snap.saved("VaultUser"), engineAddr);
    assert.ok(engineUser);
    assert.equal(num(engineUser.balance), "0");
    assert.equal(num(engineUser.totalWithdrawn), "40");
  });
});
