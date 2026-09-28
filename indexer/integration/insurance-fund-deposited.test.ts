import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, FUND, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleInsuranceFundDeposited", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("adds protocol capital and stays out of the user deposit total", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.depositInsuranceFund([100n], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.insuranceFundDeposited), "100");
    assert.equal(num(state.insuranceCapital), "100");
    assert.equal(num(state.insuranceFundBalance), "100");
    assert.equal(num(state.totalDeposited), "0");
    assert.equal(num(state.uncoveredLoss), "0");
    assert.equal(num(state.insuranceDebt), "0");

    const deposits = snap.saved("VaultDeposit");
    assert.equal(deposits.length, 1);
    assert.equal(deposits[0]?.isInsuranceFund, true);
    assert.equal(lower(deposits[0]?.user), FUND);
    assert.equal(lower(deposits[0]?.sender), owner.account.address.toLowerCase());
    assert.equal(snap.saved("InsuranceDebtEvent").length, 0);
  });

  it("counts a top-up as capital after that deposit repays open debt", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.settleTransfer([FUND, bob.account.address, 10n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.depositInsuranceFund([10n], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.insuranceFundDeposited), "10");
    assert.equal(num(state.insuranceCapital), "10");
    assert.equal(num(state.insuranceDebt), "0");
    assert.equal(num(state.uncoveredLoss), "0");
    assert.equal(num(state.insuranceFundBalance), "0");
    assert.equal(num(state.totalDeposited), "0");
  });
});
