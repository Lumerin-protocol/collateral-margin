import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployVaultFixture } from "./fixtures.js";

const { networkHelpers } = await network.getOrCreate();

const MAINNET_FUND_BALANCE = 143_273n;
const INSURANCE_DEBT_CAP = 2_000_000_000n;
const BACKSTOP_GAIN = 3_000_000_000n;

/**
 * X3-R3A-1: the protocol backstop is an internal risk ledger, but a realized gain is
 * currently paid like an external winner. When the fund is short, the vault mints the
 * remainder as insurance debt and a permissionless backstop unwind can latch the global halt.
 */
describe("X3-R3A-1 — backstop gains cannot borrow from the insurance fund", () => {
  it("pays only real fund balance without minting debt or halting the vault", async () => {
    const { vault, owner, engine } = await networkHelpers.loadFixture(deployVaultFixture);
    const fund = await vault.read.INSURANCE_FUND_ADDR();
    const backstop = await vault.read.BACKSTOP_ADDR();

    await vault.write.setAuthorizedCaller([engine.account.address, true], {
      account: owner.account,
    });
    await vault.write.setInsuranceDebtCap([INSURANCE_DEBT_CAP], {
      account: owner.account,
    });
    await vault.write.depositInsuranceFund([MAINNET_FUND_BALANCE], {
      account: owner.account,
    });

    const { result: moved } = await vault.simulate.settleTransfer(
      [fund, backstop, BACKSTOP_GAIN],
      { account: engine.account.address },
    );
    await vault.write.settleTransfer([fund, backstop, BACKSTOP_GAIN], {
      account: engine.account,
    });

    assert.equal(moved, MAINNET_FUND_BALANCE, "only real insurance capital may be paid");
    assert.equal(await vault.read.balanceOf([backstop]), MAINNET_FUND_BALANCE);
    assert.equal(await vault.read.insuranceFundBalance(), 0n);
    assert.equal(await vault.read.insuranceDebt(), 0n, "the internal ledger must not borrow");
    assert.equal(await vault.read.halted(), false, "an internal payout must not halt the vault");
  });
});
