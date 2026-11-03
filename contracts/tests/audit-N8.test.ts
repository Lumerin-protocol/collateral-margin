import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";
import { deployPortfolioMarginEngineStack, deployVaultFixture } from "./fixtures.js";

const conn = await network.getOrCreate();
const { viem, networkHelpers } = conn;

const MAINNET_FUND_BALANCE = 143_273n;
const INSURANCE_DEBT_CAP = 2_000_000_000n;
const ZERO_SUM_PNL = 3_000_000_000n;

async function deployVaultWithEngineFixture(c: NetworkConnection) {
  const ctx = await deployVaultFixture(c);
  const { pme } = await deployPortfolioMarginEngineStack(c, ctx.vault.address);
  await ctx.vault.write.setMarginEngine([pme.address], { account: ctx.owner.account });
  return ctx;
}

/**
 * N8: the CF-022 same-transaction resume must only undo the cap halt. If the owner halts after a
 * borrow latched the cap halt, `halt()` is a no-op and a later repayment in the same transaction
 * resumed the vault anyway.
 */
describe("N8 — an owner halt survives a same-transaction repayment", () => {
  it("stays halted when the owner halts between the winner's borrow and the loser's payment", async () => {
    const { vault, owner, alice, bob } = await networkHelpers.loadFixture(deployVaultWithEngineFixture);
    const harness = await viem.deployContract("InsuranceDebtHarness", []);

    await vault.write.setAuthorizedCaller([harness.address, true], { account: owner.account });
    await vault.write.setInsuranceDebtCap([INSURANCE_DEBT_CAP], { account: owner.account });
    await vault.write.depositInsuranceFund([MAINNET_FUND_BALANCE], { account: owner.account });
    await vault.write.deposit([ZERO_SUM_PNL], { account: bob.account });
    await vault.write.transferOwnership([harness.address], { account: owner.account });

    await harness.write.settleWinnerHaltThenLoser([
      vault.address,
      alice.account.address,
      bob.account.address,
      ZERO_SUM_PNL,
    ]);

    assert.equal(await vault.read.effectiveInsuranceDebtCap(), INSURANCE_DEBT_CAP);
    assert.equal(await vault.read.insuranceDebt(), 0n);
    assert.equal(await vault.read.halted(), true, "an owner halt must survive the repayment");
  });
});
