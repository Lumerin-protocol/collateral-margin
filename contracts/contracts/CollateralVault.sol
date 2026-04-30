// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Versionable} from "./interfaces/Versionable.sol";
import {ICollateralVault} from "./interfaces/ICollateralVault.sol";
import {IPortfolioMarginEngine} from "./interfaces/IPortfolioMarginEngine.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title CollateralVault — Unified USDC custody for perps + options
/// @notice ERC20 receipt token (non-transferable) representing deposited collateral.
///         Product engines (perps DEX, options engine) are authorized to
///         adjust balances via transfer/credit/debit. Withdrawals are gated
///         by a pluggable margin engine that computes the combined portfolio
///         margin requirement.
contract CollateralVault is ICollateralVault, UUPSUpgradeable, OwnableUpgradeable, ERC20Upgradeable, Versionable {
    using SafeERC20 for IERC20;

    // ── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    /// @dev Post-op balance is below `marginEngine.computePortfolioIM(account)`.
    error MarginBreach();
    error NotAuthorized();
    error ZeroAddress();
    error FunctionDisabled();

    // ── Events ──────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount, address indexed sender);
    event Withdrawn(address indexed user, uint256 amount, address indexed recipient);
    event AuthorizedCallerSet(address indexed caller, bool authorized);
    event MarginEngineSet(address indexed marginEngine);
    event InsuranceFundDeposited(address indexed source, uint256 amount);
    event InsuranceFundWithdrawn(address indexed recipient, uint256 amount);

    // ── Storage ─────────────────────────────────────────────────────────────

    /// @dev Vanity address used as the shared insurance fund ledger account.
    ///      All-0xaa bytes — no private key exists for it.
    ///      Balance is normal vault receipt tokens; authorized callers credit it via
    ///      `transfer` / `credit` / `depositFor`. Owner withdraws via `withdrawInsuranceFund`.
    address public constant INSURANCE_FUND_ADDR = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    string public constant VERSION = "1.0.1";

    IERC20 public collateralToken;
    mapping(address => bool) public authorizedCallers;

    /// @dev Margin engine that computes combined portfolio IM.
    ///      If set, withdrawals check: newBalance >= marginEngine.computePortfolioIM(user).
    address public marginEngine;
    uint8 private _decimals; // decimals of the wrapped token
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
        _decimals = IERC20Metadata(address(_collateralToken)).decimals();
    }

    // ── Block public ERC20 transfers ────────────────────────────────────────

    function approve(address, uint256) public pure override(ERC20Upgradeable, IERC20) returns (bool) {
        revert FunctionDisabled();
    }

    function allowance(address, address) public pure override(ERC20Upgradeable, IERC20) returns (uint256) {
        revert FunctionDisabled();
    }

    function transfer(address, uint256) public pure override(ERC20Upgradeable, IERC20) returns (bool) {
        revert FunctionDisabled();
    }

    function transferFrom(address, address, uint256) public pure override(ERC20Upgradeable, IERC20) returns (bool) {
        revert FunctionDisabled();
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

    /// @notice Deposit collateral into the insurance fund from `source`, minting its receipt tokens.
    function depositInsuranceFund(uint256 amount) external {
        _depositFor(_msgSender(), INSURANCE_FUND_ADDR, amount);
        emit InsuranceFundDeposited(_msgSender(), amount);
    }

    /// @notice Withdraw collateral from the insurance fund to `recipient`, burning its receipt tokens.
    function withdrawInsuranceFund(address recipient, uint256 amount) external onlyOwner {
        _withdrawTo(INSURANCE_FUND_ADDR, recipient, amount);
        emit InsuranceFundWithdrawn(recipient, amount);
    }

    // ── User functions ──────────────────────────────────────────────────────

    /// @notice Deposit collateral tokens; mints an equal amount of receipt tokens.
    function deposit(uint256 amount) external {
        _depositFor(_msgSender(), _msgSender(), amount);
    }

    /// @notice Withdraw collateral tokens; burns receipt tokens.
    ///         Reverts if the withdrawal would breach portfolio margin requirements.
    function withdraw(uint256 amount) external {
        _withdrawTo(_msgSender(), _msgSender(), amount);
    }

    function depositFor(address recipient, uint256 amount) external onlyAuthorized {
        _depositFor(_msgSender(), recipient, amount);
    }

    function withdrawTo(address recipient, uint256 amount) external onlyAuthorized {
        _withdrawTo(_msgSender(), recipient, amount);
    }

    // ── Authorized-only mutations ───────────────────────────────────────────

    /// @notice Move balance between two accounts (fee/PnL settlement).
    function internalTransfer(address from, address to, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        _transfer(from, to, amount);
    }

    /// @notice Move balance between two accounts, reverting if the sender's portfolio margin is breached.
    function internalTransferWithMarginCheck(address from, address to, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        _transfer(from, to, amount);
        _checkMargin(from);
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    /// @dev Pulls collateral from `source`, mints receipt tokens to `account`, and emits Deposited.
    function _depositFor(address source, address account, uint256 amount) internal {
        // recipient is checked to be non-zero in safeTransferFrom
        if (account == address(0)) revert ZeroAddress();
        collateralToken.safeTransferFrom(source, address(this), amount);
        _mint(account, amount);
        emit Deposited(account, amount, source);
    }

    /// @dev Burns `amount` from `account`, checks margin, transfers collateral to `recipient`, and emits Withdrawn.
    function _withdrawTo(address account, address recipient, uint256 amount) internal {
        // recipient is checked to be non-zero in safeTransfer
        if (amount == 0) revert ZeroAmount();
        _burn(account, amount);
        _checkMargin(account);
        collateralToken.safeTransfer(recipient, amount);
        emit Withdrawn(account, amount, recipient);
    }

    /// @dev Reverts if `account`'s current balance falls below its portfolio IM requirement.
    ///      No-op when no margin engine is configured.
    function _checkMargin(address account) internal view {
        address engine = marginEngine;
        if (engine == address(0)) return;
        uint256 required = IPortfolioMarginEngine(engine).computePortfolioIM(account);
        if (balanceOf(account) < required) revert MarginBreach();
    }

    // ── Views (ICollateralVault) ────────────────────────────────────────────

    /// @notice Receipt balance of the insurance fund.
    function insuranceFundBalance() external view returns (uint256) {
        return balanceOf(INSURANCE_FUND_ADDR);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
