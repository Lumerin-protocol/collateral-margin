// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICollateralVault} from "./ICollateralVault.sol";

/// @title IOptionsEnginePortfolioView — Options surface used by PortfolioMarginEngine
/// @notice Implemented by `OptionMarginEngine` in the perps package; keeps this package
///         independent of concrete options logic.
interface IOptionsEnginePortfolioView {
    /// @notice The collateral vault this engine settles into.
    /// @dev Read by `PortfolioMarginEngine.setOptions` to pin the engine to the engine's
    ///      own vault. See `ILinearMarket.vault`.
    function vault() external view returns (ICollateralVault);

    function getNetGreeks(address user) external view returns (int256 netDelta, int256 netGamma, int256 netVega);

    function getOptionsReservedMargin(address user) external view returns (uint256);
}
