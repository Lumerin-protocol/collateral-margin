// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPointsHook — Venue → points integration surface
/// @notice The two CLOB venues (perps `HashPowerPerpsDEX`, `Futures`) call into a
///         contract implementing this interface from their fill and liquidation
///         paths. The venues import ONLY this interface from collateral-margin and
///         always wrap the calls in `try/catch` so a points-side revert can never
///         block a trade or a liquidation.
interface IPointsHook {
    /// @notice Called once per matched maker/taker pair at fill time.
    /// @dev A single taker `createOrder` can walk the book and match against N
    ///      resting maker orders, producing N `onFill` calls in one transaction.
    /// @param maker     The resting (maker) side of the match.
    /// @param taker     The aggressing (taker) side of the match.
    /// @param notional  Trade notional in collateral-token decimals (e.g. 1e6 == $1).
    /// @param makerFee  Maker fee actually paid (collateral decimals, signed; a
    ///                  rebate would be negative — disallowed while points are live).
    /// @param takerFee  Taker fee actually paid (collateral decimals).
    /// @param makerPrice The resting maker order's price, in the venue's price units.
    /// @param refPrice  A manipulation-resistant reference (oracle) price in the SAME
    ///                  units as `makerPrice`, used for the maker price-improvement
    ///                  multiplier. Pass 0 when no fresh reference is available (e.g. a
    ///                  stale oracle); the hook then applies no bonus (1x) rather than
    ///                  reverting, so a points read can never block a fill.
    function onFill(
        address maker,
        address taker,
        uint256 notional,
        int256 makerFee,
        uint256 takerFee,
        uint256 makerPrice,
        uint256 refPrice
    ) external;

    /// @notice Called when a keeper executes a liquidation on either venue.
    /// @param liquidator The address that executed the liquidation.
    /// @param fee        The liquidator fee earned (collateral decimals); informational.
    function onLiquidation(address liquidator, uint256 fee) external;
}
