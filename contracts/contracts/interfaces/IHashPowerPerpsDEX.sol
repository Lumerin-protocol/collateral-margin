// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IHashPowerPerpsDEX — Read interface for perps + options integration
/// @notice Exposes view functions from HashPowerPerpsDEX needed by the
///         portfolio margin engine for cross-product margin calculation.
interface IHashPowerPerpsDEX {
    struct Position {
        int256 netQuantity;
        uint256 aggregatedEntryPrice;
    }

    /// @notice User's net perp position.
    function getUserPosition(address user) external view returns (Position memory);

    /// @notice Unrealized PnL at current oracle price (includes pending funding).
    function getUnrealizedPnl(address user) external view returns (int256);

    /// @notice Initial margin required for the user's perp position + resting orders.
    function getInitialMargin(address user) external view returns (uint256);

    /// @notice Maintenance margin required for the user's perp position + resting orders.
    function getMaintenanceMargin(address user) external view returns (uint256);

    /// @notice Resting-order margin component only (excludes position margin).
    function getOrderMargin(address user) external view returns (uint256);

    /// @notice Pending (unsettled) funding. Positive = user owes.
    function getPendingFunding(address user) external view returns (int256);

    /// @notice Whether the user's perp account is liquidatable.
    function isLiquidatable(address user) external view returns (bool);

    /// @notice Perp quantity decimals (6).
    function QUANTITY_DECIMALS() external view returns (uint8);

    /// @notice Current oracle-derived spot price (in token decimals).
    function getMarketPrice() external view returns (uint256);

    /// @notice Token decimals of the collateral token used by the DEX.
    function decimals() external view returns (uint8);
}
