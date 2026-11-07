// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILinearMarket} from "./ILinearMarket.sol";

/// @title ILinearMarketExposure — linear-market margin inputs valued at the market's own mark
/// @notice Supersedes `ILinearMarket.getRiskView` for the engine. A market's mark need not be
///         the index the engine stresses (it can anticipate a scheduled step in the index), so
///         the market reports what its contracts are worth at its mark and the engine shocks
///         that by a percentage: the market needs no index, the engine no mark.
///
///         Exposure convention: signed value at the mark, in token decimals, so that
///             PnL of an index move by a fraction x (WAD) = exposure × x / WAD,
///         exact while the mark moves in proportion to the index. With mark = index it equals
///         `delta × index`, the engine's requirement through `getRiskView`.
interface ILinearMarketExposure is ILinearMarket {
    /// @param netPositionExposure Σ signed contracts × mark over active positions (token
    ///        decimals). Positive = net long.
    /// @param unrealizedPnl As `RiskView.unrealizedPnl`.
    /// @param pendingFunding As `RiskView.pendingFunding`.
    /// @param buyOrderExposure Exposure the account would add if every resting bid filled:
    ///        Σ|q| over bids × the mark of the contract bought, unsigned (token decimals).
    /// @param sellOrderExposure The same over asks, unsigned; the engine subtracts it.
    /// @param buyOrderFillLoss As `RiskView.buyOrderFillLoss`.
    /// @param sellOrderFillLoss As `RiskView.sellOrderFillLoss`.
    struct ExposureView {
        int256 netPositionExposure;
        int256 unrealizedPnl;
        int256 pendingFunding;
        uint256 buyOrderExposure;
        uint256 sellOrderExposure;
        uint256 buyOrderFillLoss;
        uint256 sellOrderFillLoss;
    }

    /// @notice All per-user margin inputs at the market's mark (see ExposureView).
    /// @dev The engine reads this first. A market without it reverts with no data, and the
    ///      engine then reads `getRiskView` and values its deltas at the index.
    function getExposureView(address user) external view returns (ExposureView memory);
}
