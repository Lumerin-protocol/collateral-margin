// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ICollateralVault} from "./interfaces/ICollateralVault.sol";
import {IFutures} from "./interfaces/IFutures.sol";
import {IHashPowerPerpsDEX} from "./interfaces/IHashPowerPerpsDEX.sol";
import {IOptionsEnginePortfolioView} from "./interfaces/IOptionsEnginePortfolioView.sol";
import {IPortfolioMarginEngine} from "./interfaces/IPortfolioMarginEngine.sol";
import {Versionable} from "./interfaces/Versionable.sol";

/// @title PortfolioMarginEngine — Cross-product portfolio margin
/// @notice Aggregates net Greeks across perps (linear delta), futures (linear
///         delta), and options (delta/gamma/vega), runs 4-scenario stress tests,
///         and computes the unified portfolio IM/MM requirement.
///         All three product legs (perps, futures, options) are optional and can
///         be registered or swapped at any time by the owner via the set* helpers.
///
///         portfolioIM = max(stressLoss) + perpsOrderMargin + futuresOrderMargin
///                       + optionsReserved + max(0, -perpUnrealizedPnl)
///                       + max(0, -futuresUnrealizedPnl) + max(0, perpPendingFunding)
contract PortfolioMarginEngine is
    IPortfolioMarginEngine,
    Versionable,
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable
{
    uint256 private constant WAD = 1e18;
    string public constant VERSION = "1.0.0";

    // ── Storage ─────────────────────────────────────────────────────────────

    ICollateralVault public vault;
    IHashPowerPerpsDEX public perpsDex;
    IOptionsEnginePortfolioView public optionsEngine;
    IFutures public futures;

    /// @dev Spot shock for IM (WAD fraction, e.g. 0.15e18 = 15%).
    uint256 public imSpotShock;
    /// @dev Spot shock for MM.
    uint256 public mmSpotShock;
    /// @dev Vol shock for IM (WAD absolute IV change, e.g. 0.10e18 = 10 vol pts).
    uint256 public imVolShock;
    /// @dev Vol shock for MM.
    uint256 public mmVolShock;

    // ── Events ──────────────────────────────────────────────────────────────

    event ShocksUpdated(uint256 imSpot, uint256 mmSpot, uint256 imVol, uint256 mmVol);
    event PerpsDexUpdated(address perpsDex);
    event OptionsEngineUpdated(address optionsEngine);
    event FuturesUpdated(address futures);
    event VaultUpdated(address vault);

    // ── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _vault) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        if (_vault == address(0)) revert ZeroAddress();

        vault = ICollateralVault(_vault);

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
        emit VaultUpdated(_vault);
    }

    /// @notice Register (or deregister) the perps DEX. Pass address(0) to disable.
    function setPerps(address _perpsEngine) external onlyOwner {
        perpsDex = IHashPowerPerpsDEX(_perpsEngine);
        emit PerpsDexUpdated(_perpsEngine);
    }

    /// @notice Register (or deregister) the options engine. Pass address(0) to disable.
    function setOptions(address _optionsEngine) external onlyOwner {
        optionsEngine = IOptionsEnginePortfolioView(_optionsEngine);
        emit OptionsEngineUpdated(_optionsEngine);
    }

    /// @notice Register (or deregister) the futures contract. Pass address(0) to disable.
    function setFutures(address _futuresEngine) external onlyOwner {
        futures = IFutures(_futuresEngine);
        emit FuturesUpdated(_futuresEngine);
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

        // 3. Perps add-ons (optional)
        uint256 perpOrderMargin = 0;
        uint256 unrealizedLoss = 0;
        uint256 fundingOwed = 0;
        if (address(perpsDex) != address(0)) {
            perpOrderMargin = perpsDex.getOrderMargin(user);

            int256 perpPnl = perpsDex.getUnrealizedPnl(user);
            unrealizedLoss = perpPnl < 0 ? uint256(-perpPnl) : 0;

            int256 pendingFunding = perpsDex.getPendingFunding(user);
            fundingOwed = pendingFunding > 0 ? uint256(pendingFunding) : 0;
        }

        // 4. Options reserved margin (WAD → token decimals, optional)
        uint256 optReservedTokens = 0;
        if (address(optionsEngine) != address(0)) {
            optReservedTokens = _fromWad(optionsEngine.getOptionsReservedMargin(user));
        }

        // 5. Futures add-ons (optional)
        uint256 futuresOrderMargin = 0;
        uint256 futuresUnrealizedLoss = 0;
        if (address(futures) != address(0)) {
            futuresOrderMargin = futures.getFuturesOrderMargin(user);
            int256 futuresPnl = futures.getFuturesUnrealizedPnl(user);
            futuresUnrealizedLoss = futuresPnl < 0 ? uint256(-futuresPnl) : 0;
        }

        // Convert stress loss from WAD to token decimals
        uint256 stressTokens = _fromWad(worstLoss);

        return stressTokens + perpOrderMargin + futuresOrderMargin + optReservedTokens + unrealizedLoss
            + futuresUnrealizedLoss + fundingOwed;
    }

    /// @dev Aggregate net Greeks across perps (linear delta), futures (linear delta),
    ///      and options (delta/gamma/vega). Each leg is queried only when registered.
    function _aggregateGreeks(address user) private view returns (int256 netDelta, uint256 netGamma, uint256 netVega) {
        // Perps delta: qty * WAD / 10^quantityDecimals (optional)
        if (address(perpsDex) != address(0)) {
            IHashPowerPerpsDEX.Position memory pos = perpsDex.getUserPosition(user);
            int256 qtyScale = int256(10 ** uint256(perpsDex.QUANTITY_DECIMALS()));
            netDelta += pos.netQuantity * int256(WAD) / qtyScale;
        }

        // Futures delta: sum(±qty) * WAD per active position — one WAD per contract
        // (1 PH/s/day), sign per side. No duration multiplier. (optional)
        if (address(futures) != address(0)) {
            netDelta += futures.getNetPositionDelta(user);
        }

        // Options Greeks — WAD-scaled signed delta, unsigned gamma/vega (optional)
        if (address(optionsEngine) != address(0)) {
            (int256 optDelta, uint256 optGamma, uint256 optVega) = optionsEngine.getNetGreeks(user);
            netDelta += optDelta;
            netGamma = optGamma;
            netVega = optVega;
        }
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

    /// @dev Read spot price and scale to WAD. Tries perpsDex first, then futures.
    ///      Returns 0 (no stress scenarios) when neither price source is registered.
    function _getSpotPriceWad() private view returns (uint256) {
        if (address(perpsDex) != address(0)) {
            return perpsDex.getMarketPrice() * _wadScale(perpsDex.decimals());
        }
        if (address(futures) != address(0)) {
            return futures.getMarketPrice() * _wadScale(futures.decimals());
        }
        return 0;
    }

    function _fromWad(uint256 wadAmount) private view returns (uint256) {
        uint8 dec;
        if (address(perpsDex) != address(0)) dec = perpsDex.decimals();
        else if (address(futures) != address(0)) dec = futures.decimals();
        return wadAmount / _wadScale(dec);
    }

    /// @dev 10^(18 − dec): multiply a `dec`-decimal value by this to get WAD,
    ///      divide a WAD value by this to get `dec`-decimal units.
    function _wadScale(uint8 dec) private pure returns (uint256) {
        return 10 ** (18 - dec);
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
