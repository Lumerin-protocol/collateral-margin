// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IPortfolioMarginEngine } from "../interfaces/IPortfolioMarginEngine.sol";

/// @title MarginEngineMock — Minimal mock for CollateralVault withdrawal checks
contract MarginEngineMock is IPortfolioMarginEngine {
    mapping(address => uint256) private _im;

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

    function imSpotShock() external pure returns (uint256) {
        return 0;
    }

    function mmSpotShock() external pure returns (uint256) {
        return 0;
    }
}
