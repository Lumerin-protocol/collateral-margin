// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IOptionsEnginePortfolioView — Options surface used by PortfolioMarginEngine
/// @notice Implemented by `OptionMarginEngine` in the perps package; keeps this package
///         independent of concrete options logic.
interface IOptionsEnginePortfolioView {
    function getNetGreeks(address user) external view returns (int256 netDelta, uint256 netGamma, uint256 netVega);

    function getOptionsReservedMargin(address user) external view returns (uint256);
}
