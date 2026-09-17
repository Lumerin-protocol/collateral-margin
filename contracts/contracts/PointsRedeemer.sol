// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoints} from "./interfaces/IPoints.sol";

interface IVestingEscrow {
    function lockFor(address user, uint256 amount) external;
}

/// @title PointsRedeemer — Converts POINTS into GOV after the program ends
/// @notice Funded from a discretionary, treasury-supplied GOV pool (no new minting).
///         Redemption opens only after POINTS minting has been `finalize()`d, so the
///         total points denominator is fixed. Holds `BURNER_ROLE` on POINTS: a swap is
///         simply burning the caller's balance and paying out the corresponding GOV —
///         there is no transfer or `approve()` step because POINTS cannot move.
///
///         Payout is pro-rata against a snapshot taken when redemption is enabled:
///           `userGOV = govPool * userPoints / totalPointsSnapshot`
///         and is split 50/50 between liquid GOV and a `VestingEscrow.lockFor` position
///         (180-day cliff + 90-day linear vest, with the relock bonus available),
///         reusing the governance-token `TokenMigration` pattern.
contract PointsRedeemer is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The POINTS token being redeemed (pulled and burned).
    IPoints public immutable points;
    /// @notice The GOV governance token paid out.
    IERC20 public immutable gov;
    /// @notice Vesting escrow that receives the locked half of each payout.
    IVestingEscrow public immutable escrow;

    /// @notice True once redemption has been enabled by the owner.
    bool public enabled;
    /// @notice Total GOV available to distribute across all redeemers.
    uint256 public govPool;
    /// @notice `points.totalSupply()` captured at enable time; fixed payout denominator.
    uint256 public totalPointsSnapshot;

    error AlreadyEnabled();
    error NotEnabled();
    error NotFinalized();
    error NoPoints();
    error EmptyPool();
    error InsufficientGov();
    error ZeroAddress();

    event RedemptionEnabled(uint256 govPool, uint256 totalPointsSnapshot);
    event Swapped(
        address indexed user, uint256 pointsBurned, uint256 govAmount, uint256 liquidAmount, uint256 escrowAmount
    );

    constructor(address _points, address _gov, address _escrow, address _owner) Ownable(_owner) {
        if (_points == address(0) || _gov == address(0) || _escrow == address(0)) revert ZeroAddress();
        points = IPoints(_points);
        gov = IERC20(_gov);
        escrow = IVestingEscrow(_escrow);
    }

    /// @notice Open redemption against a fixed GOV pool. Requires POINTS minting to be
    ///         finalized and the pool's GOV to already be held by this contract.
    /// @param pool The total GOV to distribute pro-rata. May be larger than strictly
    ///             needed; any remainder is recoverable by the owner.
    function enableRedemption(uint256 pool) external onlyOwner {
        if (enabled) revert AlreadyEnabled();
        if (!points.finalized()) revert NotFinalized();
        if (pool == 0) revert EmptyPool();
        if (gov.balanceOf(address(this)) < pool) revert InsufficientGov();

        uint256 supply = points.totalSupply();
        if (supply == 0) revert NoPoints();

        enabled = true;
        govPool = pool;
        totalPointsSnapshot = supply;
        emit RedemptionEnabled(pool, supply);
    }

    /// @notice Redeem the caller's entire POINTS balance for GOV. No `approve()` is
    ///         possible or needed: this contract holds `BURNER_ROLE` and burns the
    ///         caller's balance directly.
    function swap() external nonReentrant {
        if (!enabled) revert NotEnabled();

        uint256 bal = points.balanceOf(_msgSender());
        if (bal == 0) revert NoPoints();

        uint256 govAmount = (govPool * bal) / totalPointsSnapshot;
        uint256 liquidAmount = govAmount / 2;
        uint256 escrowAmount = govAmount - liquidAmount;

        // Burn the caller's POINTS (redemption == burn).
        points.burn(_msgSender(), bal);

        if (liquidAmount > 0) {
            gov.safeTransfer(_msgSender(), liquidAmount);
        }
        if (escrowAmount > 0) {
            gov.safeTransfer(address(escrow), escrowAmount);
            escrow.lockFor(_msgSender(), escrowAmount);
        }

        emit Swapped(_msgSender(), bal, govAmount, liquidAmount, escrowAmount);
    }

    /// @notice Quote the GOV payout for `user` at the current snapshot. Zero until enabled.
    function previewSwap(address user) external view returns (uint256 govAmount) {
        if (!enabled) return 0;
        uint256 bal = points.balanceOf(user);
        return (govPool * bal) / totalPointsSnapshot;
    }

    /// @notice Recover GOV left over after redemption (e.g. rounding dust or an oversized pool).
    function recoverGov(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        gov.safeTransfer(to, amount);
    }
}
