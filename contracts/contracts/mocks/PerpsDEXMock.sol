// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralVault } from "../interfaces/ICollateralVault.sol";
import { ILinearMarket } from "../interfaces/ILinearMarket.sol";

/// @title PerpsDEXMock — Minimal mock of HashPowerPerpsDEX for options integration tests
contract PerpsDEXMock is ILinearMarket {
    struct Position {
        int256 netQuantity;
        uint256 aggregatedEntryPrice;
    }

    uint8 public constant QUANTITY_DECIMALS = 6;

    /// @dev Real products pin this immutably at construction; settable here so tests can
    ///      deploy the mock before the vault exists. Must be set before the mock is
    ///      registered with a PortfolioMarginEngine.
    ICollateralVault public vault;

    function setVault(ICollateralVault _vault) external {
        vault = _vault;
    }

    mapping(address => Position) private _positions;
    mapping(address => uint256) private _balances;
    mapping(address => int256) private _unrealizedPnl;
    mapping(address => uint256) private _maintenanceMargin;
    mapping(address => int256) private _pendingFunding;
    mapping(address => uint256) private _buyOrderDelta;
    mapping(address => uint256) private _sellOrderDelta;
    mapping(address => uint256) private _buyOrderFillLoss;
    mapping(address => uint256) private _sellOrderFillLoss;
    bool private _riskViewDisabled;

    function setUserPosition(address user, int256 qty, uint256 entryPrice) external {
        _positions[user] = Position(qty, entryPrice);
    }

    function setBalance(address user, uint256 bal) external {
        _balances[user] = bal;
    }

    function setUnrealizedPnl(address user, int256 pnl) external {
        _unrealizedPnl[user] = pnl;
    }

    /// @dev Only MM is modelled: it is the threshold `isLiquidatable` compares balance against.
    function setMaintenanceMargin(address user, uint256 mm) external {
        _maintenanceMargin[user] = mm;
    }

    function getUserPosition(address user) external view returns (Position memory) {
        return _positions[user];
    }

    /// @dev Mirrors HashPowerPerpsDEX.getNetPositionDelta: qty scaled by
    ///      10^collateralDecimals / 10^QUANTITY_DECIMALS (both 6 here).
    function getNetPositionDelta(address user) external view returns (int256) {
        return _positions[user].netQuantity * 1e6 / int256(10 ** QUANTITY_DECIMALS);
    }

    function getRiskView(address user) external view returns (RiskView memory) {
        if (_riskViewDisabled) revert();
        return RiskView({
            netPositionDelta: _positions[user].netQuantity * 1e6 / int256(10 ** QUANTITY_DECIMALS),
            unrealizedPnl: _unrealizedPnl[user],
            pendingFunding: _pendingFunding[user],
            buyOrderDelta: _buyOrderDelta[user],
            sellOrderDelta: _sellOrderDelta[user],
            buyOrderFillLoss: _buyOrderFillLoss[user],
            sellOrderFillLoss: _sellOrderFillLoss[user]
        });
    }

    function getUnrealizedPnl(address user) external view returns (int256) {
        return _unrealizedPnl[user];
    }

    function getPendingFunding(address user) external view returns (int256) {
        return _pendingFunding[user];
    }

    function setPendingFunding(address user, int256 pf) external {
        _pendingFunding[user] = pf;
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

    function setRiskViewDisabled(bool disabled) external {
        _riskViewDisabled = disabled;
    }

    function hasRestingOrderDelta(address user) external view returns (bool) {
        return _buyOrderDelta[user] != 0 || _sellOrderDelta[user] != 0;
    }

    function isLiquidatable(address user) external view returns (bool) {
        if (_positions[user].netQuantity == 0) return false;
        return _balances[user] < _maintenanceMargin[user];
    }
}
