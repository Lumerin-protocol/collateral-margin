import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployVaultFixture } from "./fixtures.js";

const { networkHelpers, viem } = await network.getOrCreate();

const FUND_BALANCE = 100_000_000n;
const INSURANCE_DEBT_CAP = 2_000_000_000n;
const WINNER_GAIN = 10_000_000_000n;

/**
 * CF-006: an insurance-fund payout mints the whole shortfall, even past the debt cap.
 * Accepted by user decision: the winner is paid in full, and the cap halt keeps every receipt
 * from leaving the vault until the owner acts. `resume` refuses while debt is above the cap, so
 * the owner must top up, raise the cap, or upgrade to burn fraudulent receipts first.
 */
describe("CF-006 — an over-cap payout is paid in full but cannot leave until the owner acts", () => {
  it("pays the winner in full, halts, and blocks withdrawal until the debt is back under the cap", async () => {
    const { vault, owner, alice, engine } = await networkHelpers.loadFixture(deployVaultFixture);
    const margin = await viem.deployContract("MarginEngineMock", []);
    await margin.write.setVault([vault.address]);
    await vault.write.setMarginEngine([margin.address], { account: owner.account });
    await vault.write.setAuthorizedCaller([engine.account.address, true], {
      account: owner.account,
    });
    await vault.write.setInsuranceDebtCap([INSURANCE_DEBT_CAP], {
      account: owner.account,
    });
    await vault.write.depositInsuranceFund([FUND_BALANCE], {
      account: owner.account,
    });
    const fund = await vault.read.INSURANCE_FUND_ADDR();
    const printed = WINNER_GAIN - FUND_BALANCE;

    const { result: moved } = await vault.simulate.settleTransfer(
      [fund, alice.account.address, WINNER_GAIN],
      { account: engine.account.address },
    );
    await vault.write.settleTransfer([fund, alice.account.address, WINNER_GAIN], {
      account: engine.account,
    });

    assert.equal(moved, WINNER_GAIN, "the winner is paid in full");
    assert.equal(await vault.read.balanceOf([alice.account.address]), WINNER_GAIN);
    assert.equal(await vault.read.insuranceDebt(), printed);
    assert.ok(printed > INSURANCE_DEBT_CAP);
    assert.equal(await vault.read.halted(), true, "debt past the cap must latch the halt");

    await viem.assertions.revertWithCustomError(
      vault.write.withdraw([1n], { account: alice.account }),
      vault,
      "Halted",
    );
    await viem.assertions.revertWithCustomError(
      vault.write.resume({ account: owner.account }),
      vault,
      "DebtAboveCap",
    );

    await vault.write.depositInsuranceFund([printed - INSURANCE_DEBT_CAP], {
      account: owner.account,
    });
    assert.equal(await vault.read.insuranceDebt(), INSURANCE_DEBT_CAP);
    await vault.write.resume({ account: owner.account });
    await vault.write.withdraw([1n], { account: alice.account });
    assert.equal(await vault.read.balanceOf([alice.account.address]), WINNER_GAIN - 1n);
  });
});
