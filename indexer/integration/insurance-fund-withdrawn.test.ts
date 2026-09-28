import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, FUND, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleInsuranceFundWithdrawn", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("reduces protocol capital and stays out of the user withdrawal total", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, alice } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.depositInsuranceFund([100n], { account: owner.account, chain: null });
    await vault.write.withdrawInsuranceFund([alice.account.address, 40n], {
      account: owner.account,
      chain: null,
    });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0"), read("VaultUser", FUND)]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.insuranceFundWithdrawn), "40");
    assert.equal(num(state.insuranceCapital), "60");
    assert.equal(num(state.insuranceFundBalance), "60");
    assert.equal(num(state.totalWithdrawn), "0");
    assert.equal(num(state.insuranceDebt), "0");

    const withdrawals = snap.saved("VaultWithdrawal");
    assert.equal(withdrawals.length, 1);
    assert.equal(withdrawals[0]?.isInsuranceFund, true);
    assert.equal(lower(withdrawals[0]?.user), FUND);
    assert.equal(lower(withdrawals[0]?.recipient), alice.account.address.toLowerCase());
    assert.equal(num(withdrawals[0]?.amount), "40");
    assert.equal(snap.saved("InsuranceDebtEvent").length, 0);
  });
});
