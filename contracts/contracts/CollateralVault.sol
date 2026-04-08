// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICollateralVault} from "./interfaces/ICollateralVault.sol";
import {IPortfolioMarginEngine} from "./interfaces/IPortfolioMarginEngine.sol";

/// @title CollateralVault — Unified USDC custody for perps + options
/// @notice ERC20 receipt token (non-transferable) representing deposited collateral.
///         Product engines (perps DEX, options engine) are authorized to
///         adjust balances via transfer/credit/debit. Withdrawals are gated
///         by a pluggable margin engine that computes the combined portfolio
///         margin requirement.
contract CollateralVault is ICollateralVault, Initializable, UUPSUpgradeable, OwnableUpgradeable, ERC20Upgradeable {
    using SafeERC20 for IERC20;

    // ── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error InsufficientBalance();
    error WithdrawalWouldBreachMargin();
    error NotAuthorized();
    error ZeroAddress();
    error TransferDisabled();

    // ── Events ──────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event InternalTransfer(address indexed from, address indexed to, uint256 amount);
    event BalanceCredited(address indexed user, uint256 amount);
    event BalanceDebited(address indexed user, uint256 amount);
    event AuthorizedCallerSet(address indexed caller, bool authorized);
    event MarginEngineSet(address indexed marginEngine);
    event InsuranceFundSet(address indexed account);

    // ── Storage ─────────────────────────────────────────────────────────────

    IERC20 public collateralToken;
    mapping(address => bool) public authorizedCallers;

    /// @dev Margin engine that computes combined portfolio IM.
    ///      If set, withdrawals check: newBalance >= marginEngine.computePortfolioIM(user).
    address public marginEngine;

    /// @dev Shared insurance ledger account (receipt token `balanceOf(insuranceFund)`).
    ///      Set by owner; product engines move funds via existing authorized APIs.
    address public insuranceFund;

    // ── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        if (!authorizedCallers[_msgSender()]) revert NotAuthorized();
        _;
    }

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _collateralToken) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();
        __ERC20_init("Titan Collateral", "tCOL");

        if (_collateralToken == address(0)) revert ZeroAddress();
        collateralToken = IERC20(_collateralToken);
    }

    // ── Block public ERC20 transfers ────────────────────────────────────────

    /// @dev Receipt tokens are non-transferable; balances are only moved by
    ///      authorized product engines via transfer/credit/debit.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert TransferDisabled();
        super._update(from, to, value);
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerSet(caller, authorized);
    }

    function setMarginEngine(address _marginEngine) external onlyOwner {
        marginEngine = _marginEngine;
        emit MarginEngineSet(_marginEngine);
    }

    /// @notice Configure the insurance fund account (`address(0)` unsets).
    function setInsuranceFund(address account) external onlyOwner {
        insuranceFund = account;
        emit InsuranceFundSet(account);
    }

    // ── User functions ──────────────────────────────────────────────────────

    /// @notice Deposit collateral tokens; mints an equal amount of receipt tokens.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        collateralToken.safeTransferFrom(_msgSender(), address(this), amount);
        _mint(_msgSender(), amount);
        emit Deposited(_msgSender(), amount, balanceOf(_msgSender()));
    }

    /// @notice Withdraw collateral tokens; burns receipt tokens.
    ///         Reverts if the withdrawal would breach portfolio margin requirements.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf(_msgSender());
        if (bal < amount) revert InsufficientBalance();

        uint256 newBalance = bal - amount;
        address engine = marginEngine;
        if (engine != address(0)) {
            uint256 required = IPortfolioMarginEngine(engine).computePortfolioIM(_msgSender());
            if (newBalance < required) revert WithdrawalWouldBreachMargin();
        }

        _burn(_msgSender(), amount);
        collateralToken.safeTransfer(_msgSender(), amount);
        emit Withdrawn(_msgSender(), amount, newBalance);
    }

    // ── Authorized-only mutations ───────────────────────────────────────────

    /// @notice Move balance between two accounts (fee/PnL settlement).
    ///         Bypasses the non-transferable guard via mint+burn.
    function transfer(address from, address to, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        if (balanceOf(from) < amount) revert InsufficientBalance();
        _burn(from, amount);
        _mint(to, amount);
        emit InternalTransfer(from, to, amount);
    }

    /// @notice Credit (increase) an account's balance.
    ///         The vault must already hold sufficient backing tokens.
    function credit(address user, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        _mint(user, amount);
        emit BalanceCredited(user, amount);
    }

    /// @notice Debit (decrease) a user's balance.
    function debit(address user, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        if (balanceOf(user) < amount) revert InsufficientBalance();
        _burn(user, amount);
        emit BalanceDebited(user, amount);
    }

    /// @notice Pull collateral from `source`, credit `account`'s balance.
    ///         `source` must have approved this vault for the collateral token.
    function depositFor(address source, address account, uint256 amount) external onlyAuthorized {
        if (amount == 0) revert ZeroAmount();
        collateralToken.safeTransferFrom(source, address(this), amount);
        _mint(account, amount);
        emit Deposited(account, amount, balanceOf(account));
    }

    /// @notice Debit `account`'s balance and send collateral to `recipient`.
    function withdrawTo(address account, address recipient, uint256 amount) external onlyAuthorized {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf(account) < amount) revert InsufficientBalance();
        _burn(account, amount);
        collateralToken.safeTransfer(recipient, amount);
    }

    // ── Views (ICollateralVault) ────────────────────────────────────────────

    /// @notice Alias for balanceOf — satisfies ICollateralVault.
    function getBalance(address user) external view returns (uint256) {
        return balanceOf(user);
    }

    /// @notice Receipt balance of the configured insurance fund account.
    function insuranceFundBalance() external view returns (uint256) {
        address fund = insuranceFund;
        if (fund == address(0)) return 0;
        return balanceOf(fund);
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
