// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPoints} from "./interfaces/IPoints.sol";

/// @title POINTS — Non-transferable rewards ledger
/// @notice Canonical on-chain balance for the points program. It exposes the read
///         side of the ERC20 interface (`name`/`symbol`/`decimals`/`balanceOf`/
///         `totalSupply`) and emits standard `Transfer` events on mint/burn so
///         wallets and the leaderboard subgraph can track balances — but it is a
///         pure ledger, NOT a movable token:
///           - there are no allowances; `approve` is disabled,
///           - `transfer` / `transferFrom` always revert,
///           - the only state changes are `mint` (attribution, `MINTER_ROLE`) and
///             `burn` (redemption, `BURNER_ROLE`).
///
///         Non-upgradeable by design. Lifecycle: minting is open for the whole
///         program window; `finalize()` permanently freezes minting (fixing
///         `totalSupply`) so redemption can run against a stable denominator.
contract Points is IERC20, IERC20Metadata, IPoints, AccessControl {
    /// @notice Role allowed to mint POINTS (granted to `PointsHook`).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    /// @notice Role allowed to burn POINTS (granted to `PointsRedeemer`).
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    string private constant _NAME = "Hashrate Points";
    string private constant _SYMBOL = "HP";
    uint8 private constant _DECIMALS = 6;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    /// @notice True once `finalize()` has frozen minting. Irreversible.
    bool public override finalized;

    error TransfersDisabled();
    error MintingFinalized();
    error InsufficientBalance();
    error ZeroAddress();

    event Finalized();

    /// @dev Reverts once minting has been permanently frozen via `finalize()`.
    modifier notFinalized() {
        if (finalized) revert MintingFinalized();
        _;
    }

    /// @param admin Receives `DEFAULT_ADMIN_ROLE` (mint/burn role grants + finalize).
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ── ERC20 metadata / views ──────────────────────────────────────────────

    function name() external pure override returns (string memory) {
        return _NAME;
    }

    function symbol() external pure override returns (string memory) {
        return _SYMBOL;
    }

    /// @notice POINTS uses 6 decimals to match the GOV governance token.
    function decimals() external pure override returns (uint8) {
        return _DECIMALS;
    }

    function totalSupply() external view override(IERC20, IPoints) returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override(IERC20, IPoints) returns (uint256) {
        return _balances[account];
    }

    /// @notice Always zero — POINTS has no allowance model.
    function allowance(address, address) external pure override returns (uint256) {
        return 0;
    }

    // ── Disabled transfer surface ─────────────────────────────────────────────

    function approve(address, uint256) external pure override returns (bool) {
        revert TransfersDisabled();
    }

    function transfer(address, uint256) external pure override returns (bool) {
        revert TransfersDisabled();
    }

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        revert TransfersDisabled();
    }

    // ── Mint / burn ────────────────────────────────────────────────────────────

    /// @inheritdoc IPoints
    function mint(address to, uint256 amount) external override onlyRole(MINTER_ROLE) notFinalized {
        if (to == address(0)) revert ZeroAddress();
        _totalSupply += amount;
        unchecked {
            _balances[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// @inheritdoc IPoints
    function burn(address from, uint256 amount) external override onlyRole(BURNER_ROLE) {
        uint256 bal = _balances[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            _balances[from] = bal - amount;
            _totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// @notice Permanently freeze minting and open redemption. Admin-only, one-way.
    /// @dev OPERATIONAL ORDERING: unplug the hook from every venue first
    ///      (`setHook(address(0))` on perps and futures). After finalize, `mint` reverts
    ///      forever, so any venue still routing fills/liquidations through `PointsHook` →
    ///      `mint` would revert on every trade and liquidation. Unplug, then finalize.
    function finalize() external onlyRole(DEFAULT_ADMIN_ROLE) notFinalized {
        finalized = true;
        emit Finalized();
    }
}
