// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault } from "../CollateralVault.sol";

/// @title InsuranceDebtHarness — one-transaction batches for insurance-debt tests.
/// @dev The harness is the authorized caller, so `settleTransfer` attributes bad debt to it.
contract InsuranceDebtHarness {
    function approveAndDeposit(IERC20 token, CollateralVault vault, uint256 amount) external {
        token.approve(address(vault), amount);
        vault.deposit(amount);
    }

    /// @notice Two settlements in one transaction. The second still runs after the first latches a halt.
    function settleTwice(
        CollateralVault vault,
        address from,
        address to,
        uint256 first,
        uint256 second
    ) external returns (uint256 a, uint256 b) {
        a = vault.settleTransfer(from, to, first);
        b = vault.settleTransfer(from, to, second);
    }

    /// @notice A zero-sum fill in one transaction: the fund pays the winner first, then the loser pays the fund.
    function settleWinnerThenLoser(
        CollateralVault vault,
        address winner,
        address loser,
        uint256 amount
    ) external {
        vault.settleTransfer(vault.INSURANCE_FUND_ADDR(), winner, amount);
        vault.settleTransfer(loser, vault.INSURANCE_FUND_ADDR(), amount);
    }

    /// @notice Borrow, then try to withdraw in the same transaction. The withdrawal reverts the borrow.
    function settleThenWithdraw(
        CollateralVault vault,
        address from,
        address to,
        uint256 amount,
        uint256 withdrawAmount
    ) external {
        vault.settleTransfer(from, to, amount);
        vault.withdraw(withdrawAmount);
    }
}
