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

    /// @notice Constant vanity address that holds liquidation leftovers as explicit positions.
    function BACKSTOP_ADDR() external pure returns (address);

    /// @notice Unwind band (bps around the mark) and caller fee (bps of notional) for `unwindBackstop`.
    function backstopParams() external view returns (uint16 unwindBandBps, uint16 unwindFeeBps);

    /// @notice Transfer balance between two accounts. Authorized callers only.
    function internalTransfer(address from, address to, uint256 amount) external;

    /// @notice Settle a transfer that may come up short. Authorized callers only.
    /// @dev A trader payer moves `min(balance, amount)` and the rest is bad debt.
    ///      The insurance fund pays in full, borrowing any shortfall from the pool.
    /// @return moved Amount credited to `to`.
    function settleTransfer(address from, address to, uint256 amount) external returns (uint256 moved);

    /// @notice Transfer balance between two accounts, reverting if the sender breaches portfolio margin. Authorized callers only.
    function internalTransferWithMarginCheck(address from, address to, uint256 amount) external;

    /// @notice True once a borrow crossed the effective debt cap, the owner halted, or the margin engine was removed while debt was outstanding.
    function halted() external view returns (bool);

    /// @notice Trader losses the insurance capital does not cover. The top-up the pool is owed.
    function uncoveredLoss() external view returns (uint256);

    /// @notice Debt backed by losers who have not closed yet.
    function timingDebt() external view returns (uint256);

    /// @notice Withdraw collateral tokens; burns receipt tokens.
    ///         Reverts if the withdrawal would breach portfolio margin requirements.
    function withdrawTo(address recipient, uint256 amount) external;
}
