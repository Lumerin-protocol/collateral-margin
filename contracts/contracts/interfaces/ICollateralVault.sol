// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ICollateralVault — Interface for the unified collateral vault
/// @notice Both the perps DEX and options engine use this interface to
///         read balances and perform authorized transfers/credits/debits.
/// @notice `collateralToken` is included for integrators (e.g. futures) that must
///         pin the vault to the same ERC20 as their market.
/// @dev Extends IERC20 so callers can use the standard `balanceOf` for balance queries.
interface ICollateralVault is IERC20 {
    /// @notice Underlying ERC20 the vault custodies.
    function collateralToken() external view returns (IERC20);

    /// @notice Constant vanity address used as the shared insurance fund ledger account.
    function INSURANCE_FUND_ADDR() external pure returns (address);

    /// @notice Transfer balance between two accounts. Authorized callers only.
    function internalTransfer(address from, address to, uint256 amount) external;

    /// @notice Transfer balance between two accounts, reverting if the sender breaches portfolio margin. Authorized callers only.
    function internalTransferWithMarginCheck(address from, address to, uint256 amount) external;

    /// @notice Withdraw collateral tokens; burns receipt tokens.
    ///         Reverts if the withdrawal would breach portfolio margin requirements.
    function withdrawTo(address recipient, uint256 amount) external;
}
