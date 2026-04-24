import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, maxUint256, zeroAddress } from "viem";
import { network } from "hardhat";
import {
  VAULT_AUTH_OPS_ALICE_DEPOSIT,
  deployVaultAuthorizedOperationsFixture,
  deployVaultFixture,
} from "./fixtures.js";

const { viem, networkHelpers } = await network.connect();

/** 1 USDC (6 decimals). Shared across deposit / access-control setup tests. */
const ONE_USDC = 1_000_000n;
/** 0.5 USDC — blocked ERC20 transfer amounts. */
const HALF_USDC = 500_000n;
/** Deliberately larger than Alice's balance in authorized-ops tests. */
const EXCESSIVE_DEBIT = 99_000_000n;

describe("CollateralVault", () => {
  // ── Initialization ──────────────────────────────────────────────────────

  describe("initialization", () => {
    it("sets collateral token", async () => {
      const { vault, usdc } = await networkHelpers.loadFixture(deployVaultFixture);
      const token = await vault.read.collateralToken();
      assert.equal(token.toLowerCase(), usdc.address.toLowerCase());
    });

    it("sets name and symbol", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      assert.equal(await vault.read.name(), "Titan Collateral");
      assert.equal(await vault.read.symbol(), "tCOL");
    });

    it("starts with zero balances", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
    });
  });

  // ── Deposit ─────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("mints receipt tokens and pulls USDC", async () => {
      const { vault, usdc, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const amount = ONE_USDC;

      const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
      await viem.assertions.emitWithArgs(
        vault.write.deposit([amount], { account: alice.account }),
        vault,
        "Deposited",
        [getAddress(alice.account.address), amount, amount],
      );
      const usdcAfter = await usdc.read.balanceOf([alice.account.address]);

      assert.equal(await vault.read.balanceOf([alice.account.address]), amount);
      assert.equal(await vault.read.balanceOf([alice.account.address]), amount);
      assert.equal(usdcBefore - usdcAfter, amount);
    });

    it("accumulates multiple deposits", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const secondDeposit = 2_000_000n;
      const balanceAfter = ONE_USDC + secondDeposit;

      await vault.write.deposit([ONE_USDC], { account: alice.account });
      await viem.assertions.emitWithArgs(
        vault.write.deposit([secondDeposit], { account: alice.account }),
        vault,
        "Deposited",
        [getAddress(alice.account.address), secondDeposit, balanceAfter],
      );
      assert.equal(await vault.read.balanceOf([alice.account.address]), balanceAfter);
    });
  });

  // ── Withdraw ────────────────────────────────────────────────────────────

  describe("withdraw", () => {
    it("burns receipt tokens and returns USDC", async () => {
      const { vault, usdc, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const depositAmount = 5_000_000n;
      const withdrawAmount = 3_000_000n;
      const balanceAfter = 2_000_000n;

      await vault.write.deposit([depositAmount], { account: alice.account });

      const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
      await viem.assertions.emitWithArgs(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), withdrawAmount, balanceAfter],
      );
      const usdcAfter = await usdc.read.balanceOf([alice.account.address]);

      assert.equal(await vault.read.balanceOf([alice.account.address]), balanceAfter);
      assert.equal(usdcAfter - usdcBefore, withdrawAmount);
    });

    it("reverts on zero amount", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([0n], { account: alice.account }),
        vault,
        "ZeroAmount",
      );
    });

    it("reverts on insufficient balance", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([2_000_000n], { account: alice.account }),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("allows full withdrawal when no margin engine", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const depositAmount = 5_000_000n;

      await vault.write.deposit([depositAmount], { account: alice.account });
      await viem.assertions.emitWithArgs(
        vault.write.withdraw([depositAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), depositAmount, 0n],
      );
      assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
    });
  });

  // ── Margin-gated withdrawal ─────────────────────────────────────────────

  describe("margin-gated withdrawal", () => {
    it("blocks withdrawal that would breach margin", async () => {
      const { vault, owner, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const aliceDeposit = 10_000_000n;
      const requiredIm = 8_000_000n;
      const withdrawAmount = 2_000_000n;

      await vault.write.deposit([aliceDeposit], { account: alice.account });

      const mock = await viem.deployContract("MarginEngineMock", []);
      await viem.assertions.emitWithArgs(
        vault.write.setMarginEngine([mock.address], { account: owner.account }),
        vault,
        "MarginEngineSet",
        [getAddress(mock.address)],
      );
      await mock.write.setIM([alice.account.address, requiredIm]);

      await viem.assertions.emitWithArgs(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), withdrawAmount, requiredIm],
      );
      assert.equal(await vault.read.balanceOf([alice.account.address]), requiredIm);

      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([1n], { account: alice.account }),
        vault,
        "WithdrawalWouldBreachMargin",
      );
    });
  });

  // ── ERC20 transfer blocked ──────────────────────────────────────────────

  describe("non-transferable", () => {
    it("reverts on ERC20 transfer", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        // @ts-expect-error — intentionally calling the blocked ERC20 transfer(address,uint256) overload
        vault.write.transfer([bob.account.address, HALF_USDC], { account: alice.account }),
        vault,
        "TransferDisabled",
      );
    });

    it("reverts on ERC20 transferFrom", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });
      await vault.write.approve([bob.account.address, maxUint256], { account: alice.account });
      await viem.assertions.revertWithCustomError(
        // @ts-expect-error — intentionally calling the blocked ERC20 transferFrom(address,address,uint256) overload
        vault.write.transferFrom([alice.account.address, bob.account.address, HALF_USDC], {
          account: bob.account,
        }),
        vault,
        "TransferDisabled",
      );
    });
  });

  // ── Authorized transfer/credit/debit ────────────────────────────────────

  describe("authorized operations", () => {
    it("transfer moves balance between accounts", async () => {
      const { vault, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const transferAmount = 3_000_000n;
      const aliceAfter = 7_000_000n;
      const bobAfter = 3_000_000n;

      await viem.assertions.emitWithArgs(
        vault.write.internalTransfer([alice.account.address, bob.account.address, transferAmount], {
          account: engine.account,
        }),
        vault,
        "Transfer",
        [getAddress(alice.account.address), getAddress(bob.account.address), transferAmount],
      );

      assert.equal(await vault.read.balanceOf([alice.account.address]), aliceAfter);
      assert.equal(await vault.read.balanceOf([bob.account.address]), bobAfter);
    });

    it("transfer reverts on insufficient balance", async () => {
      const { vault, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      await viem.assertions.revertWithCustomError(
        vault.write.internalTransfer(
          [alice.account.address, bob.account.address, EXCESSIVE_DEBIT],
          {
            account: engine.account,
          },
        ),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("credit increases balance", async () => {
      const { vault, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const creditAmount = 5_000_000n;

      await viem.assertions.emitWithArgs(
        vault.write.credit([bob.account.address, creditAmount], { account: engine.account }),
        vault,
        "BalanceCredited",
        [getAddress(bob.account.address), creditAmount],
      );
      assert.equal(await vault.read.balanceOf([bob.account.address]), creditAmount);
    });

    it("debit decreases balance", async () => {
      const { vault, alice, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const debitAmount = 4_000_000n;
      const aliceAfter = VAULT_AUTH_OPS_ALICE_DEPOSIT - debitAmount;

      await viem.assertions.emitWithArgs(
        vault.write.debit([alice.account.address, debitAmount], { account: engine.account }),
        vault,
        "BalanceDebited",
        [getAddress(alice.account.address), debitAmount],
      );
      assert.equal(await vault.read.balanceOf([alice.account.address]), aliceAfter);
    });

    it("debit reverts on insufficient balance", async () => {
      const { vault, alice, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      await viem.assertions.revertWithCustomError(
        vault.write.debit([alice.account.address, EXCESSIVE_DEBIT], { account: engine.account }),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("transfer is no-op for zero amount", async () => {
      const { vault, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      await vault.write.internalTransfer([alice.account.address, bob.account.address, 0n], {
        account: engine.account,
      });
      assert.equal(
        await vault.read.balanceOf([alice.account.address]),
        VAULT_AUTH_OPS_ALICE_DEPOSIT,
      );
    });
  });

  // ── Access control ──────────────────────────────────────────────────────

  describe("access control", () => {
    it("unauthorized caller cannot transfer", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        vault.write.internalTransfer([alice.account.address, bob.account.address, HALF_USDC], {
          account: bob.account,
        }),
        vault,
        "NotAuthorized",
      );
    });

    it("unauthorized caller cannot credit", async () => {
      const { vault, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.credit([bob.account.address, ONE_USDC], { account: bob.account }),
        vault,
        "NotAuthorized",
      );
    });

    it("unauthorized caller cannot debit", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.debit([alice.account.address, ONE_USDC], { account: bob.account }),
        vault,
        "NotAuthorized",
      );
    });

    it("only owner can set authorized caller", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.setAuthorizedCaller([bob.account.address, true], { account: alice.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("only owner can set margin engine", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.setMarginEngine([bob.account.address], { account: alice.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("only owner can withdraw from insurance fund", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([bob.account.address, ONE_USDC], {
          account: alice.account,
        }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("cannot set zero address as authorized caller", async () => {
      const { vault, owner } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.setAuthorizedCaller([zeroAddress, true], { account: owner.account }),
        vault,
        "ZeroAddress",
      );
    });

    it("can revoke authorized caller", async () => {
      const { vault, owner, alice, engine } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.emitWithArgs(
        vault.write.setAuthorizedCaller([engine.account.address, true], {
          account: owner.account,
        }),
        vault,
        "AuthorizedCallerSet",
        [getAddress(engine.account.address), true],
      );
      await viem.assertions.emitWithArgs(
        vault.write.setAuthorizedCaller([engine.account.address, false], {
          account: owner.account,
        }),
        vault,
        "AuthorizedCallerSet",
        [getAddress(engine.account.address), false],
      );

      await viem.assertions.revertWithCustomError(
        vault.write.credit([alice.account.address, ONE_USDC], { account: engine.account }),
        vault,
        "NotAuthorized",
      );
    });
  });

  // ── Insurance fund account ──────────────────────────────────────────────

  describe("insurance fund", () => {
    it("exposes a deterministic vanity address", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      const fund = await vault.read.INSURANCE_FUND_ADDR();
      assert.notEqual(fund, zeroAddress);
    });

    it("starts with zero balance", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      assert.equal(await vault.read.insuranceFundBalance(), 0n);
    });

    it("authorized transfer credits insurance fund and balance view reflects it", async () => {
      const { vault, alice, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const fund = await vault.read.INSURANCE_FUND_ADDR();
      const move = 2_000_000n;
      const aliceAfter = VAULT_AUTH_OPS_ALICE_DEPOSIT - move;

      await vault.write.internalTransfer([alice.account.address, fund, move], {
        account: engine.account,
      });
      assert.equal(await vault.read.balanceOf([alice.account.address]), aliceAfter);
      assert.equal(await vault.read.balanceOf([fund]), move);
      assert.equal(await vault.read.insuranceFundBalance(), move);
    });

    it("owner can withdraw from insurance fund", async () => {
      const { vault, owner, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const fund = await vault.read.INSURANCE_FUND_ADDR();
      const move = 3_000_000n;

      await vault.write.internalTransfer([alice.account.address, fund, move], {
        account: engine.account,
      });
      assert.equal(await vault.read.insuranceFundBalance(), move);

      await viem.assertions.emitWithArgs(
        vault.write.withdrawInsuranceFund([bob.account.address, move], { account: owner.account }),
        vault,
        "InsuranceFundWithdrawn",
        [getAddress(bob.account.address), move],
      );
      assert.equal(await vault.read.insuranceFundBalance(), 0n);
    });

    it("withdrawInsuranceFund reverts on insufficient balance", async () => {
      const { vault, owner, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([bob.account.address, ONE_USDC], {
          account: owner.account,
        }),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("withdrawInsuranceFund reverts on zero amount", async () => {
      const { vault, owner, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([bob.account.address, 0n], { account: owner.account }),
        vault,
        "ZeroAmount",
      );
    });

    it("withdrawInsuranceFund reverts on zero recipient", async () => {
      const { vault, owner } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([zeroAddress, ONE_USDC], { account: owner.account }),
        vault,
        "ERC20InvalidReceiver",
      );
    });
  });

  // ── totalSupply tracks deposits ─────────────────────────────────────────

  describe("totalSupply", () => {
    it("tracks total deposited collateral", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      const aliceDeposit = 5_000_000n;
      const bobDeposit = 3_000_000n;
      const aliceWithdraw = 2_000_000n;
      const totalAfterDeposits = aliceDeposit + bobDeposit;
      const aliceAfterWithdraw = aliceDeposit - aliceWithdraw;
      const totalAfterWithdraw = totalAfterDeposits - aliceWithdraw;

      await viem.assertions.emitWithArgs(
        vault.write.deposit([aliceDeposit], { account: alice.account }),
        vault,
        "Deposited",
        [getAddress(alice.account.address), aliceDeposit, aliceDeposit],
      );
      await viem.assertions.emitWithArgs(
        vault.write.deposit([bobDeposit], { account: bob.account }),
        vault,
        "Deposited",
        [getAddress(bob.account.address), bobDeposit, bobDeposit],
      );
      assert.equal(await vault.read.totalSupply(), totalAfterDeposits);

      await viem.assertions.emitWithArgs(
        vault.write.withdraw([aliceWithdraw], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), aliceWithdraw, aliceAfterWithdraw],
      );
      assert.equal(await vault.read.totalSupply(), totalAfterWithdraw);
    });
  });
});
