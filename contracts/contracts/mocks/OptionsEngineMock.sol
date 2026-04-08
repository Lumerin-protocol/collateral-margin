// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IOptionsEnginePortfolioView } from "../interfaces/IOptionsEnginePortfolioView.sol";

/// @title OptionsEngineMock — Minimal mock for PortfolioMarginEngine tests
contract OptionsEngineMock is IOptionsEnginePortfolioView {
    struct Greeks {
        int256 netDelta;
        uint256 netGamma;
        uint256 netVega;
    }

    mapping(address => Greeks) private _greeks;
    mapping(address => uint256) private _reserved;

    function setNetGreeks(address user, int256 delta, uint256 gamma, uint256 vega) external {
        _greeks[user] = Greeks(delta, gamma, vega);
    }

    function setReservedMargin(address user, uint256 amount) external {
        _reserved[user] = amount;
    }

    function getNetGreeks(address user) external view returns (int256, uint256, uint256) {
        Greeks memory g = _greeks[user];
        return (g.netDelta, g.netGamma, g.netVega);
    }

    function getOptionsReservedMargin(address user) external view returns (uint256) {
        return _reserved[user];
    }
}
