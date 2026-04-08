// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPortfolioMarginEngine — Interface for cross-product margin checks
/// @notice Used by product engines (perps DEX, options engine) to delegate
///         margin validation to the portfolio-level margin engine.
interface IPortfolioMarginEngine {
    /// @notice Portfolio Initial Margin in token decimals.
    function computePortfolioIM(address user) external view returns (uint256);

    /// @notice Portfolio Maintenance Margin in token decimals.
    function computePortfolioMM(address user) external view returns (uint256);

    /// @notice IM spot shock as WAD fraction (e.g. 0.10e18 = 10%).
    function imSpotShock() external view returns (uint256);

    /// @notice MM spot shock as WAD fraction (e.g. 0.05e18 = 5%).
    function mmSpotShock() external view returns (uint256);
}
