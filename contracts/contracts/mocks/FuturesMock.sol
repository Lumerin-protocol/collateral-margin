// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IFutures } from "../interfaces/IFutures.sol";

/// @title FuturesMock — Minimal mock of the Futures contract for PME tests
/// @notice Direct analogue of `PerpsDEXMock`: lets tests pin the per-user
///         IFutures view outputs (`getNetPositionDelta`,
///         `getOrderMargin`, `getUnrealizedPnl`) and the
///         shared market price. All views default to zero so a fresh mock
///         is a no-op contributor to portfolio margin.
contract FuturesMock is IFutures {
    mapping(address => int256) private _netDelta;
    mapping(address => uint256) private _orderMargin;
    mapping(address => int256) private _unrealizedPnl;
    uint256 private _marketPrice;

    function decimals() external pure returns (uint8) {
        return 6; // USDC
    }

    function setMarketPrice(uint256 price) external {
        _marketPrice = price;
    }

    function getMarketPrice() external view returns (uint256) {
        return _marketPrice;
    }

    function setNetPositionDelta(address user, int256 delta) external {
        _netDelta[user] = delta;
    }

    function getNetPositionDelta(address user) external view returns (int256) {
        return _netDelta[user];
    }

    function setOrderMargin(address user, uint256 om) external {
        _orderMargin[user] = om;
    }

    function getOrderMargin(address user) external view returns (uint256) {
        return _orderMargin[user];
    }

    function setUnrealizedPnl(address user, int256 pnl) external {
        _unrealizedPnl[user] = pnl;
    }

    function getUnrealizedPnl(address user) external view returns (int256) {
        return _unrealizedPnl[user];
    }
}
