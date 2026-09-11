// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralVault } from "../interfaces/ICollateralVault.sol";
import { IPortfolioMarginEngine } from "../interfaces/IPortfolioMarginEngine.sol";

/// @title MarginEngineMock — Minimal mock for CollateralVault withdrawal checks
contract MarginEngineMock is IPortfolioMarginEngine {
    /// @dev The real engine pins this in its initializer; settable here so tests can
    ///      deploy the mock before the vault exists. Must be set before the mock is
    ///      handed to a product's `setPortfolioMargin`.
    ICollateralVault public vault;

    mapping(address => uint256) private _im;

    function setVault(ICollateralVault _vault) external {
        vault = _vault;
    }

    function setIM(address user, uint256 amount) external {
        _im[user] = amount;
    }

    function computePortfolioIM(address user) external view returns (uint256) {
        return _im[user];
    }

    function computePortfolioMM(address user) external pure returns (uint256) {
        user;
        return 0;
    }

    function computePortfolioMargins(address user) external view returns (uint256 im, uint256 mm) {
        return (_im[user], 0);
    }

    /// @dev Consistent with the zero shock below: this mock never charges order margin.
    function linearOrderMargin(uint256) external pure returns (uint256) {
        return 0;
    }

    /// @dev Same reasoning as `linearOrderMargin`: with no shock, resting orders are free.
    function orderMarginOf(address) external pure returns (uint256) {
        return 0;
    }

    /// @dev Consistent with the zero shock: this mock models no resting orders at all.
    function hasRestingOrderDelta(address) external pure returns (bool) {
        return false;
    }

    /// @dev MM is always zero here, and a balance below zero is impossible.
    function isLiquidatable(address) external pure returns (bool) {
        return false;
    }

    function imSpotShock() external pure returns (uint256) {
        return 0;
    }

    function mmSpotShock() external pure returns (uint256) {
        return 0;
    }
}
