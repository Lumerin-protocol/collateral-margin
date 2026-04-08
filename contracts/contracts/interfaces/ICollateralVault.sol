// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ICollateralVault — Interface for the unified collateral vault
/// @notice Both the perps DEX and options engine use this interface to
///         read balances and perform authorized transfers/credits/debits.
/// @notice `collateralToken` is included for integrators (e.g. futures) that must
///         pin the vault to the same ERC20 as their market.
interface ICollateralVault {
    /// @notice Underlying ERC20 the vault custodies.
    function collateralToken() external view returns (IERC20);

    /// @notice User's collateral balance in token decimals.
    function getBalance(address user) external view returns (uint256);

    /// @notice Dedicated account (EOA or contract) for shared protocol insurance.
    ///         Its balance is normal vault receipt tokens — credit via authorized
    ///         `transfer` / `credit` / `depositFor`, same as any account.
    function insuranceFund() external view returns (address);

    /// @notice Receipt-token balance of `insuranceFund`, or zero if unset.
    function insuranceFundBalance() external view returns (uint256);

    /// @notice Transfer balance between two accounts. Authorized callers only.
    function transfer(address from, address to, uint256 amount) external;

    /// @notice Credit (increase) a user's balance. Authorized callers only.
    function credit(address user, uint256 amount) external;

    /// @notice Debit (decrease) a user's balance. Authorized callers only.
    function debit(address user, uint256 amount) external;

    /// @notice Pull collateral from `source`, credit `account`'s balance.
    ///         `source` must have approved this vault. Authorized callers only.
    function depositFor(address source, address account, uint256 amount) external;

    /// @notice Debit `account`'s balance and send collateral to `recipient`.
    ///         Authorized callers only.
    function withdrawTo(address account, address recipient, uint256 amount) external;
}
