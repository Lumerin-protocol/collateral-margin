// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import { ICollateralVault } from "./interfaces/ICollateralVault.sol";
import { IHashPowerPerpsDEX } from "./interfaces/IHashPowerPerpsDEX.sol";
import { IOptionsEnginePortfolioView } from "./interfaces/IOptionsEnginePortfolioView.sol";
import { IPortfolioMarginEngine } from "./interfaces/IPortfolioMarginEngine.sol";
import { Versionable } from "./interfaces/Versionable.sol";

/// @title PortfolioMarginEngine — Cross-product portfolio margin
/// @notice Aggregates net Greeks across perps (linear delta) and options
///         (delta/gamma/vega), runs 4-scenario stress tests, and computes
///         the unified portfolio IM/MM requirement.
///
///         portfolioIM = max(stressLoss) + perpsOrderMargin + optionsReserved
///                       + max(0, -perpUnrealizedPnl) + max(0, perpPendingFunding)
contract PortfolioMarginEngine is IPortfolioMarginEngine, Versionable, Initializable, UUPSUpgradeable, OwnableUpgradeable {
    uint256 private constant WAD = 1e18;
    uint256 private constant PERP_QTY_DECIMALS = 1e6;
    string public constant VERSION = "1.0.0";

    // ── Storage ─────────────────────────────────────────────────────────────

    ICollateralVault public vault;
    IHashPowerPerpsDEX public perpsDex;
    IOptionsEnginePortfolioView public optionsEngine;

    /// @dev Spot shock for IM (WAD fraction, e.g. 0.15e18 = 15%).
    uint256 public imSpotShock;
    /// @dev Spot shock for MM.
    uint256 public mmSpotShock;
    /// @dev Vol shock for IM (WAD absolute IV change, e.g. 0.10e18 = 10 vol pts).
    uint256 public imVolShock;
    /// @dev Vol shock for MM.
    uint256 public mmVolShock;

    uint256[40] private __gap;

    // ── Events ──────────────────────────────────────────────────────────────

    event ShocksUpdated(uint256 imSpot, uint256 mmSpot, uint256 imVol, uint256 mmVol);

    // ── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _vault, address _perpsDex, address _optionsEngine) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        if (_vault == address(0) || _perpsDex == address(0) || _optionsEngine == address(0)) {
            revert ZeroAddress();
        }

        vault = ICollateralVault(_vault);
        perpsDex = IHashPowerPerpsDEX(_perpsDex);
        optionsEngine = IOptionsEnginePortfolioView(_optionsEngine);

        imSpotShock = 0.1e18; // 10% — matches DEX marginPercent
        mmSpotShock = 0.05e18; // 5%  — matches DEX maintenanceMarginPercent
        imVolShock = 0.1e18; // 10 vol points
        mmVolShock = 0.05e18; // 5 vol points
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function setShocks(uint256 _imSpotShock, uint256 _mmSpotShock, uint256 _imVolShock, uint256 _mmVolShock)
        external
        onlyOwner
    {
        imSpotShock = _imSpotShock;
        mmSpotShock = _mmSpotShock;
        imVolShock = _imVolShock;
        mmVolShock = _mmVolShock;
        emit ShocksUpdated(_imSpotShock, _mmSpotShock, _imVolShock, _mmVolShock);
    }

    function setVault(address _vault) external onlyOwner {
        vault = ICollateralVault(_vault);
    }

    function setPerpsDex(address _perpsDex) external onlyOwner {
        perpsDex = IHashPowerPerpsDEX(_perpsDex);
    }

    function setOptionsEngine(address _optionsEngine) external onlyOwner {
        optionsEngine = IOptionsEnginePortfolioView(_optionsEngine);
    }

    // ── Core views ─────────────────────────────────────────────────────────

    /// @notice Compute portfolio Initial Margin requirement (in token decimals).
    ///         Used by CollateralVault to gate withdrawals.
    function computePortfolioIM(address user) external view returns (uint256) {
        return _computeMargin(user, true);
    }

    /// @notice Compute portfolio Maintenance Margin requirement (in token decimals).
    function computePortfolioMM(address user) external view returns (uint256) {
        return _computeMargin(user, false);
    }

    /// @notice Check if user is healthy (balance >= MM).
    function isHealthy(address user) external view returns (bool) {
        return vault.balanceOf(user) >= _computeMargin(user, false);
    }

    /// @notice Check if user can place an order requiring additionalIM (in token decimals).
    function canPlaceOrder(address user, uint256 additionalIM) external view returns (bool) {
        return vault.balanceOf(user) >= _computeMargin(user, true) + additionalIM;
    }

    // ── Internal ────────────────────────────────────────────────────────────

    function _computeMargin(address user, bool isIM) private view returns (uint256) {
        // 1. Aggregate net Greeks (WAD-scaled)
        (int256 netDelta, uint256 netGamma, uint256 netVega) = _aggregateGreeks(user);

        // 2. Four-scenario stress loss (WAD-scaled)
        uint256 worstLoss = _worstStressLoss(netDelta, netGamma, netVega, isIM);

        // 3. Perps resting-order margin (token decimals)
        uint256 perpOrderMargin = perpsDex.getOrderMargin(user);

        // 4. Options reserved margin (WAD → token decimals)
        uint256 optReserved = optionsEngine.getOptionsReservedMargin(user);
        uint256 optReservedTokens = _fromWad(optReserved);

        // 5. Unrealized perp losses (token decimals; only count negative PnL)
        int256 perpPnl = perpsDex.getUnrealizedPnl(user);
        uint256 unrealizedLoss = perpPnl < 0 ? uint256(-perpPnl) : 0;

        // 6. Pending funding owed (token decimals; only count positive = user owes)
        int256 pendingFunding = perpsDex.getPendingFunding(user);
        uint256 fundingOwed = pendingFunding > 0 ? uint256(pendingFunding) : 0;

        // Convert stress loss from WAD to token decimals
        uint256 stressTokens = _fromWad(worstLoss);

        return stressTokens + perpOrderMargin + optReservedTokens + unrealizedLoss + fundingOwed;
    }

    /// @dev Aggregate net Greeks across perps (linear delta) and options (delta/gamma/vega).
    function _aggregateGreeks(address user) private view returns (int256 netDelta, uint256 netGamma, uint256 netVega) {
        // Perps delta: qty * WAD / PERP_QTY_DECIMALS
        IHashPowerPerpsDEX.Position memory pos = perpsDex.getUserPosition(user);
        int256 perpDelta = pos.netQuantity * int256(WAD) / int256(PERP_QTY_DECIMALS);

        // Options Greeks (already WAD-scaled and signed delta)
        (int256 optDelta, uint256 optGamma, uint256 optVega) = optionsEngine.getNetGreeks(user);

        netDelta = perpDelta + optDelta;
        netGamma = optGamma;
        netVega = optVega;
    }

    /// @dev Evaluate 4 stress scenarios and return the worst-case loss (WAD).
    ///      Scenarios: (±Δs, ±Δσ) where Δs = spotShock * spotPrice (dollar move)
    ///      PnL ≈ delta·Δs + ½·gamma·Δs² + vega·Δσ
    function _worstStressLoss(int256 netDelta, uint256 netGamma, uint256 netVega, bool isIM)
        private
        view
        returns (uint256 worst)
    {
        uint256 spotShockFrac = isIM ? imSpotShock : mmSpotShock;
        uint256 volShock = isIM ? imVolShock : mmVolShock;

        // Convert percentage shock → dollar move (WAD)
        uint256 spotPrice = _getSpotPriceWad();
        uint256 deltaS = spotShockFrac * spotPrice / WAD;

        // Pre-compute gamma term: ½ · gamma · Δs²
        uint256 gammaTerm = netGamma * deltaS / WAD * deltaS / (2 * WAD);

        // Scenario 1: spot +, vol +
        worst = _scenarioLoss(netDelta, gammaTerm, netVega, int256(deltaS), int256(volShock));

        // Scenario 2: spot +, vol -
        uint256 loss = _scenarioLoss(netDelta, gammaTerm, netVega, int256(deltaS), -int256(volShock));
        if (loss > worst) worst = loss;

        // Scenario 3: spot -, vol +
        loss = _scenarioLoss(netDelta, gammaTerm, netVega, -int256(deltaS), int256(volShock));
        if (loss > worst) worst = loss;

        // Scenario 4: spot -, vol -
        loss = _scenarioLoss(netDelta, gammaTerm, netVega, -int256(deltaS), -int256(volShock));
        if (loss > worst) worst = loss;
    }

    /// @dev Compute loss for a single scenario. Returns max(0, -PnL) in WAD.
    ///      PnL = delta·Δs/WAD + gammaTerm + vega·Δσ/WAD
    ///      Note: gammaTerm is pre-computed and always the same magnitude across ±spotShock
    ///      (quadratic in |Δs|), so we always ADD it regardless of direction.
    function _scenarioLoss(int256 netDelta, uint256 gammaTerm, uint256 netVega, int256 deltaS, int256 deltaVol)
        private
        pure
        returns (uint256)
    {
        int256 deltaPnl = netDelta * deltaS / int256(WAD);
        int256 vegaPnl = int256(netVega) * deltaVol / int256(WAD);
        // Gamma term is ½γ(Δs)² — always non-negative, always adds to P&L
        // (positive gamma profits from moves, negative gamma loses)
        int256 pnl = deltaPnl + int256(gammaTerm) + vegaPnl;
        return pnl < 0 ? uint256(-pnl) : 0;
    }

    /// @dev Read spot price from the perps DEX oracle and scale to WAD.
    function _getSpotPriceWad() private view returns (uint256) {
        uint256 priceTokenDecimals = perpsDex.getMarketPrice();
        return priceTokenDecimals * 1e12; // token decimals (6) → WAD (18)
    }

    function _fromWad(uint256 wadAmount) private pure returns (uint256) {
        return wadAmount / 1e12; // USDC 6 decimals: WAD / 10^12
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner { }
}
