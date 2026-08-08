// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICollateralVault} from "./ICollateralVault.sol";

/// @title ILinearMarket — Portfolio-margin view interface for delta-one products
/// @notice Uniform read interface used by `PortfolioMarginEngine` for linear-payoff
///         markets (perpetuals, futures) — as opposed to options, whose non-linear
///         payoff is exposed via `IOptionsEnginePortfolioView`.
///
///         All values are denominated in the collateral token's decimals — products
///         know nothing about WAD (the PME's internal fixed-point scale).
///
///         Delta convention: scaled by 10^collateralDecimals, i.e.
///             PnL (token decimals) = delta × priceMove (token decimals) / 10^collateralDecimals.
///         Each product does its own quantity→delta scaling internally (perps divide
///         out quantity decimals; futures count one delta unit per contract) so the
///         PME never needs product-specific constants.
interface ILinearMarket {
    /// @notice The collateral vault this market settles into.
    /// @dev Read by `PortfolioMarginEngine.addLinearMarket` to pin a market to the
    ///      engine's own vault. A market settling into a different ledger would have
    ///      its margin aggregated against balances it never touches.
    function vault() external view returns (ICollateralVault);

    /// @notice All per-user margin inputs, batched into a single call to save
    ///         external-call gas.
    ///
    ///         Markets report raw post-fill exposure rather than a margin figure: the
    ///         engine nets `buyOrderDelta` / `sellOrderDelta` into portfolio net delta
    ///         and stresses each leg, which bounds every fill subset by convexity and
    ///         nets across venues. A per-venue scalar can do neither.
    /// @param netPositionDelta Net linear delta of all *active positions* (signed,
    ///        scaled by 10^collateralDecimals). Positive = net long; negative = net
    ///        short. Only matched positions, not resting orders.
    /// @param unrealizedPnl Aggregate mark-to-market PnL across active positions (token
    ///        decimals, signed). Must exclude pending funding — the engine adds a loss
    ///        here and `pendingFunding` as independent terms, so a market that nets
    ///        funding into this field has the debt charged twice.
    /// @param pendingFunding Pending unsettled funding (token decimals, signed;
    ///        positive = user owes). Products without funding (futures) return 0.
    /// @param buyOrderDelta Delta the account would acquire if every resting bid filled:
    ///        Σ|q| over bids, unsigned, scaled by 10^collateralDecimals exactly as
    ///        `netPositionDelta` is. The engine adds it to net delta, so the same
    ///        quantity→delta scaling must apply.
    /// @param sellOrderDelta Delta the account would shed if every resting ask filled:
    ///        Σ|q| over asks, unsigned, same scale as `buyOrderDelta`. The engine
    ///        subtracts it from net delta.
    /// @param buyOrderFillLoss Instant mark-to-market loss if every resting bid filled:
    ///        max(0, Σ q·(limit − mark)) over bids (token decimals). Clamped at the
    ///        scenario level, not per order — in the all-bids-fill world those orders
    ///        fill together and their gains and losses genuinely net.
    /// @param sellOrderFillLoss Instant mark-to-market loss if every resting ask filled:
    ///        max(0, Σ q·(mark − limit)) over asks (token decimals). Same scenario-level
    ///        clamp as `buyOrderFillLoss`.
    struct RiskView {
        int256 netPositionDelta;
        int256 unrealizedPnl;
        int256 pendingFunding;
        uint256 buyOrderDelta;
        uint256 sellOrderDelta;
        uint256 buyOrderFillLoss;
        uint256 sellOrderFillLoss;
    }

    /// @notice Batched read of the user's margin inputs (see RiskView).
    /// @dev Deliberately a new selector rather than an extension of the former
    ///      `getAccountView`. Engine and markets are independently upgraded UUPS
    ///      proxies; the old four-word decoder reading this seven-word tuple would
    ///      silently take `pendingFunding` as the old `orderMargin` instead of
    ///      reverting. A fresh selector makes version skew fail loud.
    function getRiskView(address user) external view returns (RiskView memory);

    /// @notice Whether this market reports any currently margin-relevant resting-order delta.
    /// @dev This narrow read keeps portfolio-wide orders-first liquidation checks off the
    ///      substantially more expensive position, oracle, and fill-loss path in `getRiskView`.
    function hasRestingOrderDelta(address user) external view returns (bool);
}
