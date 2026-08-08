// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICollateralVault} from "./ICollateralVault.sol";

/// @title IPortfolioMarginEngine — Interface for cross-product margin checks
/// @notice Used by product engines (perps DEX, options engine) to delegate
///         margin validation to the portfolio-level margin engine.
interface IPortfolioMarginEngine {
    /// @notice The collateral vault this engine aggregates balances from.
    /// @dev Read by the products' `setPortfolioMargin` to pin the engine to the product's
    ///      own vault. An engine sizing margin against a different ledger would gate
    ///      trades on balances the product never debits. Mirrors `ILinearMarket.vault`.
    function vault() external view returns (ICollateralVault);

    /// @notice Portfolio Initial Margin in token decimals.
    function computePortfolioIM(address user) external view returns (uint256);

    /// @notice Portfolio Maintenance Margin in token decimals.
    function computePortfolioMM(address user) external view returns (uint256);

    /// @notice Portfolio Initial and Maintenance Margin from one shared market snapshot.
    function computePortfolioMargins(address user) external view returns (uint256 im, uint256 mm);

    /// @notice Margin charged against a delta-one resting order's notional (both token
    ///         decimals).
    /// @dev Lets a market size order margin from the engine's risk knob without importing
    ///      the engine's WAD fixed-point scale, so the shock and the scale it is expressed
    ///      in can never drift apart across contracts.
    ///
    ///      Linear products only — a notional cannot express the delta/gamma/vega an
    ///      option's margin depends on. Options size resting orders through their own
    ///      engine and report the total via `IOptionsEnginePortfolioView`.
    function linearOrderMargin(uint256 notional) external view returns (uint256);

    /// @notice Incremental portfolio IM attributable to the user's resting orders
    ///         (token decimals): IM as charged, less IM with no orders resting.
    /// @dev The display figure for "margin locked by my orders". Exact and cross-product,
    ///      so it can read zero for an order that offsets exposure at another venue.
    ///      Not additive across orders — the stress term it differences is convex.
    function orderMarginOf(address user) external view returns (uint256);

    /// @notice Whether any registered linear market reports resting order delta for `user`.
    /// @dev The orders-first gate on position liquidation. A venue can only see its own
    ///      book, but margin is portfolio-level: a position on one venue offsets resting
    ///      orders on another, so closing it leaves the opposing leg unopposed and *raises*
    ///      the requirement the liquidation was meant to relieve. Gating each venue on this
    ///      instead of its own order index makes the check match the scope of the margin.
    ///
    ///      Keyed on delta rather than order count so an order carrying no risk — an expired
    ///      futures order still sitting in its participant index — cannot deadlock
    ///      liquidation. Cancelling orders stays ungated; it is the remedy this gate points at.
    function hasRestingOrderDelta(address user) external view returns (bool);

    /// @notice IM spot shock as WAD fraction (e.g. 0.10e18 = 10%).
    function imSpotShock() external view returns (uint256);

    /// @notice MM spot shock as WAD fraction (e.g. 0.05e18 = 5%).
    function mmSpotShock() external view returns (uint256);
}
