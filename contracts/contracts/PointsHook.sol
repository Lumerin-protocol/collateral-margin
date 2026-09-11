// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPointsHook} from "./interfaces/IPointsHook.sol";
import {IPoints} from "./interfaces/IPoints.sol";

/// @title PointsHook — Points accrual logic for the perps + futures venues
/// @notice Non-upgradeable, plain deploy. Holds `MINTER_ROLE` on the POINTS token and
///         contains all of the points math and tunable weights. Not a fund-holding
///         contract.
///
///         Retuning the formula is done by deploying a NEW `PointsHook` and pointing
///         each venue at it via `setHook()`, rather than upgrading — the hook is
///         designed to be replaced, not proxied.
///
///         Anti-gaming defenses live here and at the venue:
///           - self-match exclusion (`maker == taker` mints nothing),
///           - per-side minimum fee threshold (dust trades earn nothing),
///           - the positive-fees invariant enforced by the venue config.
///
///         OPERATIONAL ORDERING — wind down before `finalize()`: once the POINTS token is
///         `finalize()`d, `mint` reverts permanently. Each venue's `onFill` / `onLiquidation`
///         routes through this hook into `points.mint`, so the hook MUST be unplugged from
///         every venue (`setHook(address(0))` on perps and futures) BEFORE calling
///         `Points.finalize()`. Finalizing while a venue still points here would make every
///         fill and liquidation revert into the hook on each `mint`.
contract PointsHook is IPointsHook, AccessControl {
    /// @notice Granted only to the venue contracts allowed to drive accrual.
    bytes32 public constant HOOK_CALLER_ROLE = keccak256("HOOK_CALLER_ROLE");

    /// @dev Fixed-point scale for the maker/taker weights (1e18 == 1 POINT per notional unit).
    uint256 public constant WEIGHT_SCALE = 1e18;

    /// @notice The POINTS token this hook mints.
    IPoints public immutable points;

    // ── Tunable parameters ─────────────────────────────────────────────────────

    /// @notice Maker weight (WAD). `points = notional * wMaker / WEIGHT_SCALE`.
    uint256 public wMaker;
    /// @notice Taker weight (WAD). Set `wMaker > wTaker` to bias toward liquidity.
    uint256 public wTaker;
    /// @notice Flat POINTS minted to a keeper per liquidation (POINTS decimals).
    uint256 public keeperPoints;
    /// @notice Minimum fee (collateral decimals) a side must pay to earn on a fill.
    uint256 public minFee;
    /// @notice Maker multiplier (WAD) at zero spread, e.g. `3e18` == 3x. The bonus is
    ///         disabled (every maker fill earns the flat `wMaker` rate) whenever this is
    ///         `<= WEIGHT_SCALE`. Defaults to 0 (disabled), so deploys behave like a
    ///         plain linear hook until `setPriceImprovement` turns the bonus on.
    uint256 public maxMakerMult;
    /// @notice Spread (WAD fraction of `refPrice`) at/above which the maker multiplier
    ///         returns to 1x. `0` also disables the bonus.
    uint256 public maxSpread;

    // ── Errors / events ─────────────────────────────────────────────────────────

    error ZeroAddress();

    event WeightsSet(uint256 wMaker, uint256 wTaker);
    event KeeperPointsSet(uint256 keeperPoints);
    event MinFeeSet(uint256 minFee);
    event PriceImprovementSet(uint256 maxMakerMult, uint256 maxSpread);

    /// @param _points     The POINTS token (this hook must be set as its `minter`).
    /// @param admin        Receives `DEFAULT_ADMIN_ROLE` (parameter tuning + role grants).
    /// @param _wMaker      Initial maker weight (WAD).
    /// @param _wTaker      Initial taker weight (WAD).
    /// @param _keeperPoints Initial flat keeper reward (POINTS decimals).
    constructor(
        address _points,
        address admin,
        uint256 _wMaker,
        uint256 _wTaker,
        uint256 _keeperPoints
    ) {
        if (_points == address(0) || admin == address(0)) revert ZeroAddress();
        points = IPoints(_points);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        wMaker = _wMaker;
        wTaker = _wTaker;
        keeperPoints = _keeperPoints;
        emit WeightsSet(_wMaker, _wTaker);
        emit KeeperPointsSet(_keeperPoints);
    }

    // ── Venue entry points ──────────────────────────────────────────────────────

    /// @inheritdoc IPointsHook
    function onFill(
        address maker,
        address taker,
        uint256 notional,
        int256 makerFee,
        uint256 takerFee,
        uint256 makerPrice,
        uint256 refPrice
    ) external override onlyRole(HOOK_CALLER_ROLE) {
        // Self-match exclusion: a wallet trading with itself earns nothing.
        if (maker == taker) return;

        // Taker side. The mint emits POINTS `Transfer(0x0 -> taker)`, which the
        // leaderboard subgraph indexes — no separate accrual event is needed.
        if (takerFee >= minFee) {
            uint256 amount = (notional * wTaker) / WEIGHT_SCALE;
            if (amount > 0) {
                points.mint(taker, amount);
            }
        }

        // Maker side. A negative makerFee (rebate) earns nothing and violates the
        // positive-fees invariant the program runs under. Tighter quotes (closer to
        // the reference price) earn a higher multiplier — see `_makerMultiplier`.
        if (makerFee > 0 && uint256(makerFee) >= minFee) {
            uint256 mult = _makerMultiplier(makerPrice, refPrice);
            uint256 amount = (notional * wMaker * mult) / (WEIGHT_SCALE * WEIGHT_SCALE);
            if (amount > 0) {
                points.mint(maker, amount);
            }
        }
    }

    /// @dev Maker price-improvement multiplier (WAD; `WEIGHT_SCALE` == 1x). Rewards
    ///      quotes resting closer to the reference price: full `maxMakerMult` at zero
    ///      spread, tapering linearly to 1x at `maxSpread`, and 1x beyond. Returns a
    ///      neutral 1x when the bonus is disabled or no reference price is available
    ///      (`refPrice == 0`), so a missing/stale oracle simply drops the bonus.
    function _makerMultiplier(uint256 makerPrice, uint256 refPrice) internal view returns (uint256) {
        uint256 cap = maxMakerMult;
        uint256 width = maxSpread;
        if (cap <= WEIGHT_SCALE || width == 0 || refPrice == 0) return WEIGHT_SCALE;

        uint256 diff = makerPrice > refPrice ? makerPrice - refPrice : refPrice - makerPrice;
        uint256 spread = (diff * WEIGHT_SCALE) / refPrice;
        if (spread >= width) return WEIGHT_SCALE;

        // Linear taper from `cap` (spread 0) down to 1x (spread == width).
        return cap - ((cap - WEIGHT_SCALE) * spread) / width;
    }

    /// @inheritdoc IPointsHook
    function onLiquidation(address liquidator, uint256 /* fee */ )
        external
        override
        onlyRole(HOOK_CALLER_ROLE)
    {
        uint256 amount = keeperPoints;
        if (amount > 0) {
            points.mint(liquidator, amount);
        }
    }

    // ── Admin: parameter tuning ─────────────────────────────────────────────────

    function setWeights(uint256 _wMaker, uint256 _wTaker) external onlyRole(DEFAULT_ADMIN_ROLE) {
        wMaker = _wMaker;
        wTaker = _wTaker;
        emit WeightsSet(_wMaker, _wTaker);
    }

    function setKeeperPoints(uint256 _keeperPoints) external onlyRole(DEFAULT_ADMIN_ROLE) {
        keeperPoints = _keeperPoints;
        emit KeeperPointsSet(_keeperPoints);
    }

    function setMinFee(uint256 _minFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minFee = _minFee;
        emit MinFeeSet(_minFee);
    }

    /// @notice Configure the maker price-improvement multiplier.
    /// @param _maxMakerMult Multiplier (WAD) applied to maker points at zero spread
    ///        (e.g. `3e18` == 3x). Pass `0` or any value `<= WEIGHT_SCALE` to disable
    ///        the bonus so makers earn the flat `wMaker` rate.
    /// @param _maxSpread Spread (WAD fraction of the reference price) at/above which the
    ///        multiplier returns to 1x. Pass `0` to disable the bonus.
    function setPriceImprovement(uint256 _maxMakerMult, uint256 _maxSpread)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        maxMakerMult = _maxMakerMult;
        maxSpread = _maxSpread;
        emit PriceImprovementSet(_maxMakerMult, _maxSpread);
    }
}
