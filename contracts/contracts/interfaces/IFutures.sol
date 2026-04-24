// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IFutures — Portfolio-margin view interface for the Futures contract
/// @notice Exposes the three view functions needed by `PortfolioMarginEngine` to
///         incorporate hashrate futures into cross-product margin calculation.
///
///         Delta convention (WAD = 1e18):
///           A long position of 1 contract over D delivery days contributes
///           delta = D * WAD (token-decimals of PnL per token-decimal move in
///           the daily hashrate price), matching the scaling used for perp delta.
interface IFutures {
    /// @notice Net linear delta of all *active positions* (WAD-scaled, signed).
    ///         Positive = net long exposure; negative = net short.
    ///         Only counts matched positions, not resting orders (those are
    ///         captured via `getFuturesOrderMargin`).
    function getNetPositionDelta(address participant) external view returns (int256);

    /// @notice Minimum margin locked by resting orders (token decimals).
    ///         Mirrors `getOrderMargin` in IHashPowerPerpsDEX: it is the
    ///         maintenance-margin-less-unrealized-PnL component for unmatched
    ///         orders, clamped to zero (orders can't produce a net credit).
    function getFuturesOrderMargin(address participant) external view returns (uint256);

    /// @notice Aggregate unrealized PnL across active positions (token decimals).
    ///         Positive = mark-to-market gain; negative = mark-to-market loss.
    function getFuturesUnrealizedPnl(address participant) external view returns (int256);

    /// @notice Current oracle-derived hashrate spot price (token decimals).
    ///         Used as a fallback price source when no perps DEX is registered.
    function getMarketPrice() external view returns (uint256);

    /// @notice Decimals of the collateral token (e.g. 6 for USDC, 18 for DAI).
    function decimals() external view returns (uint8);
}
