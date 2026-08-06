// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {ICollateralVault} from "./interfaces/ICollateralVault.sol";
import {ILinearMarket} from "./interfaces/ILinearMarket.sol";
import {IOptionsEnginePortfolioView} from "./interfaces/IOptionsEnginePortfolioView.sol";
import {IPortfolioMarginEngine} from "./interfaces/IPortfolioMarginEngine.sol";
import {Versionable} from "./interfaces/Versionable.sol";
import {MathLib as M, WAD} from "./libs/MathLib.sol";

/// @title PortfolioMarginEngine — Cross-product portfolio margin
/// @notice Aggregates net Greeks across all registered linear markets (delta-one
///         products) and the options engine (delta/gamma/vega), runs 4-scenario
///         stress tests, and computes the unified portfolio IM/MM requirement.
///         The engine is product-agnostic: linear markets are managed via
///         addLinearMarket/removeLinearMarket, options via setOptions.
///
///         portfolio{IM,MM} = max( stress(netDelta + Σ buyOrderDelta),
///                                 stress(netDelta − Σ sellOrderDelta) )
///                            + Σ buyOrderFillLoss + Σ sellOrderFillLoss + optionsReserved
///                            + pnlTerm + Σ max(0, pendingFunding)
///         (sums over all registered linear markets)
///
///         The two requirements differ only in their spot shock and in `pnlTerm`:
///
///           IM: Σ max(0, -unrealizedPnl)   — clamped per market, gains ignored
///           MM: max(0, -Σ unrealizedPnl)   — clamped once, gains offset losses
///
///         MM nets because it decides solvency, and a loss at one venue against a gain
///         at another is not a solvency event: both legs settle into one vault, in one
///         currency, so the offset is an accounting identity rather than a claim about
///         correlation. Clamping MM per market liquidates delta-flat cross-venue hedges
///         the moment the mark moves — the losing leg is charged in full while the
///         winning leg is invisible — which is the exact flow this engine exists to
///         support. Note the netted form still cannot go below zero: a net gain
///         contributes nothing, so unrealized profit can never fund a requirement
///         reduction beyond cancelling a loss the account actually carries.
///
///         IM keeps the per-market clamp because it gates *new* risk and, via the
///         vault's withdrawal check, the exit. Netting there would let a manipulated
///         mark on one venue release collateral against a real loss on another. Holding
///         the conservative form on IM means unrealized profit supports survival but
///         never withdrawal or added leverage, and it preserves IM ≥ MM, which the
///         venues' `OverLiquidation` guard depends on.
///
///         The two stress legs bound the requirement after *any* subset of the
///         account's resting orders fills: a subset leaves net delta somewhere in
///         [netDelta − sellOrderDelta, netDelta + buyOrderDelta], and stress is convex
///         in delta, so the maximum over that interval is attained at an endpoint. The
///         no-fill case is interior and therefore bounded too. That is the guarantee
///         the venues cannot provide themselves — there is no margin check on a maker
///         at fill time, so the reservation held against a resting order is the only
///         thing standing between a fill and an under-collateralized account.
contract PortfolioMarginEngine is
    IPortfolioMarginEngine,
    Versionable,
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable
{
    using EnumerableSet for EnumerableSet.AddressSet;

    uint256 private constant MAX_ORACLE_STALENESS = 1 hours;
    string public constant VERSION = "2.0.0";

    // ── Storage ─────────────────────────────────────────────────────────────

    ICollateralVault public vault;
    /// @dev Deprecated storage-layout placeholder (legacy `perpsDex` slot) — superseded
    ///      by `linearMarkets`. Read once by initializeV2 during migration; never written.
    ILinearMarket private __deprecated_perpsDex;
    IOptionsEnginePortfolioView public optionsEngine;
    /// @dev Deprecated storage-layout placeholder (legacy `futures` slot). See above.
    ILinearMarket private __deprecated_futures;

    /// @dev Spot shock for IM (WAD fraction, e.g. WAD * 15 / 100 = 15%).
    uint256 public imSpotShock;
    /// @dev Spot shock for MM.
    uint256 public mmSpotShock;
    /// @dev Vol shock for IM (WAD absolute IV change, e.g. WAD / 10 = 10 vol pts).
    uint256 public imVolShock;
    /// @dev Vol shock for MM.
    uint256 public mmVolShock;

    /// @dev Cached decimals of the vault's collateral token — the shared quote unit for
    ///      all product prices/PnL. Cached so product contracts don't need to re-expose it.
    uint8 private collateralDecimals;

    /// @dev Registered linear markets (delta-one products). Margin math iterates
    ///      this set; the engine has no product-specific knowledge. Duplicates are
    ///      rejected at registration — they would silently double-count margin.
    EnumerableSet.AddressSet private linearMarkets;

    /// @dev Hashprice index oracle — the PME's own spot source for stress math,
    ///      independent of any registered product.
    AggregatorV3Interface public priceOracle;
    uint8 private oracleDecimals;

    // ── Events ──────────────────────────────────────────────────────────────

    event ShocksUpdated(uint256 imSpot, uint256 mmSpot, uint256 imVol, uint256 mmVol);
    event LinearMarketAdded(address indexed market);
    event LinearMarketRemoved(address indexed market);
    event OptionsEngineUpdated(address optionsEngine);
    event VaultUpdated(address vault);
    event OracleUpdated(address oracle);

    // ── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error LinearMarketAlreadyRegistered();
    error LinearMarketNotRegistered();
    error OracleNotSet();
    error InvalidOracle();
    error VaultMismatch();
    /// @dev A dependency did not answer a call the engine depends on: no code at the
    ///      address, or the call reverted. Covers every dependency; which one is bad is
    ///      implied by the setter that reverted.
    error InvalidDependency();

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        imSpotShock = WAD / 10; // 10% — matches DEX marginPercent
        mmSpotShock = WAD / 20; // 5%  — matches DEX maintenanceMarginPercent
        imVolShock = WAD / 10; // 10 vol points
        mmVolShock = WAD / 20; // 5 vol points
    }

    /// @notice Backfills `collateralDecimals` and migrates the legacy perps/futures
    ///         registrations into `linearMarkets` on proxies initialized before those
    ///         were introduced. Must run before the upgrade serves margin calls —
    ///         decimals stay 0 and no linear market is registered otherwise.
    function initializeV2() external reinitializer(2) {
        collateralDecimals = _readDecimals(address(vault.collateralToken()));

        if (address(__deprecated_perpsDex) != address(0)) {
            linearMarkets.add(address(__deprecated_perpsDex));
        }
        if (address(__deprecated_futures) != address(0)) {
            linearMarkets.add(address(__deprecated_futures));
        }
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}

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

      /// @dev Smoke-tests the vault's read surface before adopting it. A wrong address here
      ///      breaks every margin computation, and so every withdrawal gate, at once.
    function setVault(address _vault) external onlyOwner {
      _validateNotZeroAddress(_vault);
      _requireContract(_vault);
      address token = _validateVaultContract(_vault);
      _validateMarketsUseSameVault(_vault);

      vault = ICollateralVault(_vault);
      collateralDecimals = _readDecimals(token);
      emit VaultUpdated(_vault);
    }

    /// @notice Register a linear market (any delta-one product). Reverts if already
    ///         registered — a duplicate would silently double-count margin.
    /// @dev The market must settle into this engine's vault: margin read from one ledger
    ///      and balances from another is not a portfolio.
    function addLinearMarket(address _market) external onlyOwner {
        _validateNotZeroAddress(_market);
        _requireContract(_market);
        _requireVaultPin(_market, vault);

        if (!linearMarkets.add(_market)) {
          revert LinearMarketAlreadyRegistered();
        }

        emit LinearMarketAdded(_market);
    }

    /// @notice Deregister a linear market. Reverts if not registered.
    function removeLinearMarket(address _market) external onlyOwner {
        if (!linearMarkets.remove(_market)) revert LinearMarketNotRegistered();

        emit LinearMarketRemoved(_market);
    }

    /// @notice All registered linear markets.
    function getLinearMarkets() external view returns (address[] memory) {
        return linearMarkets.values();
    }

    /// @notice Register (or deregister) the options engine. Pass address(0) to disable.
    function setOptions(address _optionsEngine) external onlyOwner {
        if (_optionsEngine != address(0)) {
            _requireContract(_optionsEngine);
            _validateOptionsContract(_optionsEngine);
            _requireVaultPin(_optionsEngine, vault);
        }

        optionsEngine = IOptionsEnginePortfolioView(_optionsEngine);
        emit OptionsEngineUpdated(_optionsEngine);
    }

    /// @notice Set the index oracle used for stress-math spot. Must be configured —
    ///         margin computations revert with `OracleNotSet` while it is unset.
    /// @dev Requires the feed to already serve a positive, initialized round: a feed that
    ///      never answers reads as spot 0, which zeroes the delta/gamma stress loss.
    function setOracle(AggregatorV3Interface _oracle) external onlyOwner {
      _validateNotZeroAddress(address(_oracle));
      _requireContract(address(_oracle));
      _validateOracleContract(_oracle);

      priceOracle = _oracle;
      oracleDecimals = _readDecimals(address(_oracle));
      emit OracleUpdated(address(_oracle));
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

    /// @notice Margin charged against a delta-one resting order's notional (both token
    ///         decimals).
    /// @dev The IM spot shock is the single knob sizing unmatched linear exposure across
    ///      every venue. Exposing it applied rather than raw keeps the WAD scale inside
    ///      the engine — markets quote notionals in collateral decimals and get margin
    ///      back in the same unit.
    ///
    ///      Deliberately not a general order-margin entry point: option orders are sized
    ///      from greeks, not notional. Serving both would mean stressing (delta, gamma,
    ///      vega) here instead, which is worth doing when options is wired in — it would
    ///      also retire the duplicate shock config in `OptionMarginEngine`.
    function linearOrderMargin(uint256 notional) external view returns (uint256) {
        return notional * imSpotShock / WAD;
    }

    /// @notice Check if user is healthy (balance >= MM).
    function isHealthy(address user) external view returns (bool) {
        return vault.balanceOf(user) >= _computeMargin(user, false);
    }

    /// @notice Check if user can place an order requiring additionalIM (in token decimals).
    function canPlaceOrder(address user, uint256 additionalIM) external view returns (bool) {
        return vault.balanceOf(user) >= _computeMargin(user, true) + additionalIM;
    }

    /// @notice The incremental IM the user's resting orders actually cost (token decimals):
    ///         the portfolio IM as charged, less the IM the same portfolio would carry with
    ///         no orders resting.
    /// @dev This is what a UI should display as "order margin". Unlike the per-venue scalar
    ///      it replaces, it is exact and cross-product: an order that genuinely offsets
    ///      exposure held at another venue costs nothing here, and an order that looks
    ///      risk-reducing to its own venue but takes the portfolio further from flat is
    ///      charged in full.
    ///
    ///      Non-additive across orders by construction — the stress term is convex, so
    ///      the cost of two orders is not the sum of their individual costs. Callers
    ///      wanting a per-order gate want `linearOrderMargin` instead.
    function orderMarginOf(address user) external view returns (uint256) {
        LinearAggregate memory agg = _linearAggregate(user);
        uint256 withOrders = _marginFromAggregate(user, agg, true);

        agg.buyOrderDelta = 0;
        agg.sellOrderDelta = 0;
        agg.fillLoss = 0;
        uint256 withoutOrders = _marginFromAggregate(user, agg, true);

        return withOrders > withoutOrders ? withOrders - withoutOrders : 0;
    }

    /// @notice Whether any registered linear market reports resting order delta for `user`.
    /// @dev Backs the venues' orders-first gate on position liquidation. Each venue can only
    ///      see its own book, but the requirement is portfolio-level: a position on one venue
    ///      offsets resting orders on another, so closing it strands the opposing leg and
    ///      raises the very requirement the liquidation was meant to relieve. Gating on this
    ///      puts the check at the same scope as the margin it protects.
    ///
    ///      Keyed on delta, not order count, so an order carrying no risk cannot deadlock
    ///      liquidation — an expired futures order still occupies its participant index but
    ///      contributes nothing here. Short-circuits on the first market with exposure, so
    ///      the common case costs one `getRiskView`.
    function hasRestingOrderDelta(address user) external view returns (bool) {
        uint256 len = linearMarkets.length();
        for (uint256 i = 0; i < len; i++) {
            ILinearMarket.RiskView memory account = ILinearMarket(linearMarkets.at(i)).getRiskView(user);
            if (account.buyOrderDelta != 0 || account.sellOrderDelta != 0) return true;
        }
        return false;
    }

    // ── Internal ────────────────────────────────────────────────────────────

    /// @dev Summed `ILinearMarket.RiskView` across every registered market. Deltas are
    ///      WAD-lifted (the engine's internal scale); the monetary add-ons stay in token
    ///      decimals, as the markets report them.
    struct LinearAggregate {
        int256 netDelta;
        uint256 buyOrderDelta;
        uint256 sellOrderDelta;
        uint256 fillLoss;
        uint256 unrealizedLossPerMarket;
        int256 netUnrealizedPnl;
        uint256 fundingOwed;
    }

    function _computeMargin(address user, bool isIM) private view returns (uint256) {
        return _marginFromAggregate(user, _linearAggregate(user), isIM);
    }

    /// @dev Folds options greeks into the linear aggregate and prices it. Split out from
    ///      `_computeMargin` so `orderMarginOf` can re-price the same aggregate with the
    ///      order fields zeroed without a second round of external reads.
    function _marginFromAggregate(address user, LinearAggregate memory agg, bool isIM)
        private
        view
        returns (uint256)
    {
        // 1. Options Greeks — WAD-scaled signed delta, unsigned gamma/vega (optional)
        int256 netDelta = agg.netDelta;
        uint256 netGamma = 0;
        uint256 netVega = 0;
        uint256 optReservedTokens = 0;
        if (address(optionsEngine) != address(0)) {
            (int256 optDelta, uint256 optGamma, uint256 optVega) = optionsEngine.getNetGreeks(user);
            netDelta += optDelta;
            netGamma = optGamma;
            netVega = optVega;
            optReservedTokens = M.fromWad(optionsEngine.getOptionsReservedMargin(user), collateralDecimals);
        }

        // 2. Stress both fill legs (WAD-scaled) and keep the worse. Gamma and vega ride
        //    along unchanged in both — only delta moves with the orders.
        uint256 worstLoss =
            _worstStressLoss(netDelta + int256(agg.buyOrderDelta), netGamma, netVega, isIM);
        uint256 sellLoss =
            _worstStressLoss(netDelta - int256(agg.sellOrderDelta), netGamma, netVega, isIM);
        if (sellLoss > worstLoss) worstLoss = sellLoss;

        // Convert stress loss from WAD to token decimals
        uint256 stressTokens = M.fromWad(worstLoss, collateralDecimals);

        // 3. Unrealized PnL. IM clamps per market and so ignores gains entirely; MM clamps
        //    the portfolio-wide sum, letting a gain at one venue offset a loss at another.
        //    See the contract natspec for why the two differ.
        uint256 pnlTokens = isIM
            ? agg.unrealizedLossPerMarket
            : (agg.netUnrealizedPnl < 0 ? uint256(-agg.netUnrealizedPnl) : 0);

        return stressTokens + agg.fillLoss + optReservedTokens + pnlTokens + agg.fundingOwed;
    }

    /// @dev One batched getRiskView call per registered linear market: sums the WAD-lifted
    ///      net and per-side order deltas alongside the fill-loss / negative-PnL /
    ///      funding-owed add-ons.
    ///
    ///      Both sides' fill losses are summed into one term and charged in both stress
    ///      legs. That over-reserves slightly, and deliberately so: it removes any
    ///      dependence on an argument about which side can carry a loss at a given spot.
    ///      Futures orders at different expiries are not mutually crossed, so both sides
    ///      genuinely can.
    function _linearAggregate(address user) private view returns (LinearAggregate memory agg) {
        uint256 len = linearMarkets.length();
        for (uint256 i = 0; i < len; i++) {
            ILinearMarket.RiskView memory account = ILinearMarket(linearMarkets.at(i)).getRiskView(user);

            agg.netDelta += M.toWad(account.netPositionDelta, collateralDecimals);
            agg.buyOrderDelta += M.toWad(account.buyOrderDelta, collateralDecimals);
            agg.sellOrderDelta += M.toWad(account.sellOrderDelta, collateralDecimals);
            agg.fillLoss += account.buyOrderFillLoss + account.sellOrderFillLoss;
            agg.netUnrealizedPnl += account.unrealizedPnl;
            if (account.unrealizedPnl < 0) agg.unrealizedLossPerMarket += uint256(-account.unrealizedPnl);
            if (account.pendingFunding > 0) agg.fundingOwed += uint256(account.pendingFunding);
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



    /// @dev `ILinearMarket.vault` and `IOptionsEnginePortfolioView.vault` share one
    ///      selector, so this serves both product families.
    function _requireVaultPin(address product, ICollateralVault expected) private view {
        if (_pinnedVault(product) != address(expected)) revert VaultMismatch();
    }

    // ── Dependency probes ───────────────────────────────────────────────────
    //
    // `catch` only fires on a revert raised by the callee, so the code check ahead of it
    // is load-bearing: a call to an address holding no code succeeds with empty return
    // data and fails later in this contract's decoder, out of the catch block's reach.
    // The one gap left is a contract carrying the right selector but answering with a
    // wrong-shaped payload — that still escapes as a bare revert.

    function _requireContract(address target) private view {
        if (target.code.length == 0) revert InvalidDependency();
    }

    function _pinnedVault(address product) private view returns (address) {
        try ILinearMarket(product).vault() returns (ICollateralVault pinned) {
            return address(pinned);
        } catch {
            revert InvalidDependency();
        }
    }

    /// @dev `IERC20Metadata.decimals` and `AggregatorV3Interface.decimals` share one
    ///      selector, so this serves the collateral token and the price feed alike.
    function _readDecimals(address target) private view returns (uint8) {
        try IERC20Metadata(target).decimals() returns (uint8 dec) {
            return dec;
        } catch {
            revert InvalidDependency();
        }
    }

    /// @dev Read the index oracle and scale to WAD. Reverts when no oracle is
    ///      configured — an unset oracle must not silently zero out the delta/gamma
    ///      stress loss. Returns 0 on a stale/non-positive answer (zero stress, same
    ///      degradation semantics as the products' own oracle reads).
    function _getSpotPriceWad() private view returns (uint256) {
        if (address(priceOracle) == address(0)) revert OracleNotSet();
        (, int256 answer,, uint256 updatedAt,) = priceOracle.latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > MAX_ORACLE_STALENESS) return 0;
        return M.toWad(uint256(answer), oracleDecimals);
    }

    function _validateNotZeroAddress(address addr) private view {
      if (addr == address(0)) revert ZeroAddress();
    }

    function _validateMarketsUseSameVault(address _vault) private view {
      // Products pin their vault at construction, so swapping the engine's vault out
      // from under live registrations can only mean the two have diverged. Deregister
      // the stale products first.
      uint256 len = linearMarkets.length();
      for (uint256 i = 0; i < len; i++) {
          _requireVaultPin(linearMarkets.at(i), ICollateralVault(_vault));
      }
      if (address(optionsEngine) != address(0)) {
        _requireVaultPin(address(optionsEngine), ICollateralVault(_vault));
      }
    }

    function _validateVaultContract(address _vault) private view returns (address token){
      // Smoke-test both reads the engine depends on before comparing product pins,
      // so a bad vault reports its own problem rather than a mismatch.
      ICollateralVault newVault = ICollateralVault(_vault);
      try newVault.balanceOf(address(this)) returns (uint256) { }
      catch {
          revert InvalidDependency();
      }

      try newVault.collateralToken() returns (IERC20 _token) {
          return address(_token);
      } catch {
          revert InvalidDependency();
      }
    }

    function _validateLinearMarketContract(address _market) private view{
      try ILinearMarket(_market).getRiskView(address(this)) returns (ILinearMarket.RiskView memory) { }
      catch {
          revert InvalidDependency();
      }
    }

    function _validateOptionsContract(address _optionsEngine)private view{
      try IOptionsEnginePortfolioView(_optionsEngine).getNetGreeks(address(this)) returns (
          int256, uint256, uint256
      ) { } catch {
          revert InvalidDependency();
      }

      try IOptionsEnginePortfolioView(_optionsEngine).getOptionsReservedMargin(address(this)) returns (uint256) { }
      catch {
          revert InvalidDependency();
      }
    }

    function _validateOracleContract(AggregatorV3Interface _oracle) private view{
      int256 answer;
      uint256 updatedAt;
      try _oracle.latestRoundData() returns (uint80, int256 _answer, uint256, uint256 _updatedAt, uint80) {
          answer = _answer;
          updatedAt = _updatedAt;
      } catch {
          revert InvalidDependency();
      }
      if (answer <= 0 || updatedAt == 0) revert InvalidOracle();
    }

}
