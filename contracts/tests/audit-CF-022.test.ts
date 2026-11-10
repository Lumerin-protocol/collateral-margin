import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployVaultFixture } from "./fixtures.js";

const { viem, networkHelpers } = await network.getOrCreate();

const MAINNET_FUND_BALANCE = 143_273n;
const INSURANCE_DEBT_CAP = 2_000_000_000n;
const ZERO_SUM_PNL = 3_000_000_000n;

/**
 * CF-022: venues realize each leg against the insurance fund, winner first. A winner's gain above
 * the fund balance plus cap headroom latches the halt, and the loser's equal payment later in the
 * same transaction repays the debt but leaves every withdrawal and order frozen.
 */
describe("CF-022 — a zero-sum transaction cannot leave the vault halted", () => {
  it("clears the cap halt when the loser repays the winner's borrow in the same transaction", async () => {
    const { vault, owner, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
    const harness = await viem.deployContract("InsuranceDebtHarness", []);

    await vault.write.setAuthorizedCaller([harness.address, true], { account: owner.account });
    await vault.write.setInsuranceDebtCap([INSURANCE_DEBT_CAP], { account: owner.account });
    await vault.write.depositInsuranceFund([MAINNET_FUND_BALANCE], { account: owner.account });
    await vault.write.deposit([ZERO_SUM_PNL], { account: bob.account });

    await harness.write.settleWinnerThenLoser([
      vault.address,
      alice.account.address,
      bob.account.address,
      ZERO_SUM_PNL,
    ]);

    assert.equal(await vault.read.balanceOf([alice.account.address]), ZERO_SUM_PNL);
    assert.equal(await vault.read.balanceOf([bob.account.address]), 0n);
    assert.equal(await vault.read.insuranceFundBalance(), MAINNET_FUND_BALANCE);
    assert.equal(await vault.read.insuranceDebt(), 0n);
    assert.equal(await vault.read.halted(), false, "a repaid same-transaction borrow must not halt the vault");
  });
});
