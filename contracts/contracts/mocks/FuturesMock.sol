// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralVault } from "../interfaces/ICollateralVault.sol";
import { ILinearMarket } from "../interfaces/ILinearMarket.sol";

/// @title FuturesMock — Minimal mock of the Futures contract for PME tests
/// @notice Direct analogue of `PerpsDEXMock`: lets tests pin the per-user
///         ILinearMarket view outputs (`getNetPositionDelta`, the per-side order
///         delta / fill loss, `getUnrealizedPnl`). All views default to zero
///         so a fresh mock is a no-op contributor to portfolio margin.
contract FuturesMock is ILinearMarket {
    mapping(address => int256) private _netDelta;
    mapping(address => int256) private _unrealizedPnl;
    mapping(address => int256) private _pendingFunding;
    mapping(address => uint256) private _buyOrderDelta;
    mapping(address => uint256) private _sellOrderDelta;
    mapping(address => uint256) private _buyOrderFillLoss;
    mapping(address => uint256) private _sellOrderFillLoss;

    /// @dev See `PerpsDEXMock.vault`. Must be set before registering with a PME.
    ICollateralVault public vault;

    function setVault(ICollateralVault _vault) external {
        vault = _vault;
    }

    function setNetPositionDelta(address user, int256 delta) external {
        _netDelta[user] = delta;
    }

    function getNetPositionDelta(address user) external view returns (int256) {
        return _netDelta[user];
    }

    /// @dev Per-side order delta uses the same 10^collateralDecimals scale as
    ///      `netPositionDelta`; fill losses are token decimals.
    function setOrderDeltas(address user, uint256 buyDelta, uint256 sellDelta) external {
        _buyOrderDelta[user] = buyDelta;
        _sellOrderDelta[user] = sellDelta;
    }

    function setOrderFillLosses(address user, uint256 buyLoss, uint256 sellLoss) external {
        _buyOrderFillLoss[user] = buyLoss;
        _sellOrderFillLoss[user] = sellLoss;
    }

    function setUnrealizedPnl(address user, int256 pnl) external {
        _unrealizedPnl[user] = pnl;
    }

    function getUnrealizedPnl(address user) external view returns (int256) {
        return _unrealizedPnl[user];
    }

    /// @dev Real futures have no funding mechanism and always return 0;
    ///      settable here so tests can exercise the PME's funding path.
    function setPendingFunding(address user, int256 pf) external {
        _pendingFunding[user] = pf;
    }

    function getPendingFunding(address user) external view returns (int256) {
        return _pendingFunding[user];
    }

    function getRiskView(address user) external view returns (RiskView memory) {
        return RiskView({
            netPositionDelta: _netDelta[user],
            unrealizedPnl: _unrealizedPnl[user],
            pendingFunding: _pendingFunding[user],
            buyOrderDelta: _buyOrderDelta[user],
            sellOrderDelta: _sellOrderDelta[user],
            buyOrderFillLoss: _buyOrderFillLoss[user],
            sellOrderFillLoss: _sellOrderFillLoss[user]
        });
    }
}
