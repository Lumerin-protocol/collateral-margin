// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
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
    /// @notice The margin engine aggregates a different vault than this one.
    error VaultMismatch();
    /// @dev A dependency did not answer a call the vault depends on: no code at the address,
    ///      or the call reverted. Which dependency is bad is implied by the setter that reverted.
    error InvalidDependency();
    /// @notice Withdrawals are blocked while the vault is halted.
    error Halted();
    /// @notice `resume` requires `insuranceDebt` at or under the effective cap.
    error DebtAboveCap();
    /// @notice `resume` was called while the vault was not halted.
    error NotHalted();
    /// @notice A backstop parameter is above its bound.
    error BackstopParamOutOfBounds();

    /// @notice Why trading and withdrawals were stopped.
    enum HaltReason {
        CAP,
        OWNER,
        NO_MARGIN_ENGINE
    }

    // ── Events ──────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount, address indexed sender);
    event Withdrawn(address indexed user, uint256 amount, address indexed recipient);
    event AuthorizedCallerSet(address indexed caller, bool authorized);
    event MarginEngineSet(address indexed marginEngine);
    event InsuranceFundDeposited(address indexed source, uint256 amount);
    event InsuranceFundWithdrawn(address indexed recipient, uint256 amount);
    /// @notice A payer could not cover `amount`. `venue` is the authorized caller.
    /// @dev Fee shortfalls (receiver is not the insurance fund) are emitted here and do not
    ///      increase `traderBadDebtTotal`.
    event BadDebt(address indexed payer, address indexed receiver, uint256 amount, address indexed venue);
    event InsuranceDebtCapSet(uint256 oldCap, uint256 newCap);
    event VaultHalted(HaltReason reason, uint256 debt, uint256 effectiveCap);
    event VaultResumed(uint256 debt, uint256 effectiveCap);
    event BackstopWithdrawn(address indexed recipient, uint256 amount);
    event BackstopParamsSet(uint16 unwindBandBps, uint16 unwindFeeBps);

    // ── Storage ─────────────────────────────────────────────────────────────

    /// @dev Vanity address used as the shared insurance fund ledger account.
    ///      All-0xaa bytes — no private key exists for it.
    ///      Balance is normal vault receipt tokens; authorized callers credit it via
    ///      `transfer` / `credit` / `depositFor`. Owner withdraws via `withdrawInsuranceFund`.
    address public constant INSURANCE_FUND_ADDR = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    /// @dev Vanity address that holds the protocol's liquidation leftovers as explicit positions.
    ///      All-0xbb bytes — no private key exists for it. Venues hand every liquidated quantity
    ///      to this account and reduce it with `unwindBackstop`. It is a trader payer in
    ///      `settleTransfer`: a loss it cannot cover is `BadDebt` counted in `traderBadDebtTotal`.
    ///      Gains accrue to its balance; the owner sweeps them with `withdrawBackstop`.
    address public constant BACKSTOP_ADDR = 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB;
    /// @dev Upper bound for each backstop parameter (25%).
    uint16 public constant MAX_BACKSTOP_PARAM_BPS = 2_500;
    string public constant VERSION = "1.3.0";

    IERC20 public collateralToken;
    mapping(address => bool) public authorizedCallers;

    /// @dev Margin engine that computes combined portfolio IM.
    ///      If set, withdrawals check: newBalance >= marginEngine.computePortfolioIM(user).
    address public marginEngine;
    uint8 private _decimals; // decimals of the wrapped token

    /// @notice Receipts minted to pay winners when the insurance fund balance was short.
    uint256 public insuranceDebt;
    /// @notice Owner-configured borrow ceiling. Ignored while the margin engine is unset.
    uint256 public insuranceDebtCap;
    /// @notice Sum of shortfalls where a trader owed the insurance fund and could not pay.
    /// @dev Fee shortfalls are not included. They are lost revenue, not a hole in the pool.
    uint256 public traderBadDebtTotal;
    /// @notice Protocol capital: `depositInsuranceFund` minus `withdrawInsuranceFund`,
    ///         seeded by `initializeV2` from the fund balance at upgrade.
    int256 public insuranceCapital;
    /// @notice Latched circuit breaker. Stays on until the owner calls `resume`.
    bool public halted;
    /// @notice Oracle band (bps around the mark) inside which `unwindBackstop` may fill.
    uint16 public backstopUnwindBandBps;
    /// @notice Fee (bps of filled notional at the mark) paid to whoever calls `unwindBackstop`.
    uint16 public backstopUnwindFeeBps;

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

    /// @notice Count the insurance fund balance already in the vault as protocol capital.
    /// @dev Call from `upgradeToAndCall` in the same transaction as the v1.2.0 upgrade.
    ///      Later deposits and withdrawals maintain `insuranceCapital` themselves.
    function initializeV2() external reinitializer(2) onlyOwner {
        insuranceCapital = int256(balanceOf(INSURANCE_FUND_ADDR));
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

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerSet(caller, authorized);
    }

    /// @notice Set the margin engine that gates withdrawals. Pass `address(0)` to ungate them.
    /// @dev Clearing is left open deliberately: it is the escape hatch if a broken engine would
    ///      otherwise trap every balance in the vault. A non-zero engine must aggregate *this*
    ///      vault — `computePortfolioIM` sizes the gate, so an engine reading another ledger
    ///      would report margin for positions this vault never collateralizes and wave the
    ///      withdrawal through. That failure is silent, unlike a wrong address, which reverts.
    function setMarginEngine(address _marginEngine) external onlyOwner {
        if (_marginEngine != address(0)) {
          _validateMarginEngine(_marginEngine);
        }

        marginEngine = _marginEngine;
        emit MarginEngineSet(_marginEngine);
        // With no margin check, nothing locks the losers' collateral, so the effective cap
        // is 0. Any debt already outstanding has to halt until an engine is restored.
        if (_marginEngine == address(0) && insuranceDebt > 0) {
            _latchHalt(HaltReason.NO_MARGIN_ENGINE);
        }
    }

    /// @notice Borrowing ceiling, in collateral units. Lowering it below the current debt
    ///         does not halt; the next borrow will. Call `halt` to stop immediately.
    function setInsuranceDebtCap(uint256 newCap) external onlyOwner {
        uint256 oldCap = insuranceDebtCap;
        insuranceDebtCap = newCap;
        emit InsuranceDebtCapSet(oldCap, newCap);
    }

    /// @notice Stop new orders and withdrawals without waiting for the debt cap.
    function halt() external onlyOwner {
        _latchHalt(HaltReason.OWNER);
    }

    /// @notice Clear a halt once `insuranceDebt` is at or under the effective cap.
    function resume() external onlyOwner {
        uint256 cap = effectiveInsuranceDebtCap();
        if (insuranceDebt > cap) revert DebtAboveCap();
        if (!halted) revert NotHalted();
        halted = false;
        emit VaultResumed(insuranceDebt, cap);
    }

    /// @dev `catch` only fires on a revert raised by the callee, so this check ahead of it is
    ///      load-bearing: a call to an address holding no code succeeds with empty return data
    ///      and fails later in this contract's decoder, out of the catch block's reach.
    function _requireContract(address target) private view {
        if (target.code.length == 0) revert InvalidDependency();
    }

    function _validateMarginEngine(address _marginEngine) private view {
      _requireContract(_marginEngine);

      // Probe a plain storage read rather than `computePortfolioIM`: the margin path needs
      // the engine's own oracle, and wiring the vault must not depend on that being set yet.
      try IPortfolioMarginEngine(_marginEngine).imSpotShock() returns (uint256) { }
      catch {
          revert InvalidDependency();
      }

      try IPortfolioMarginEngine(_marginEngine).vault() returns (ICollateralVault pinned) {
          if (address(pinned) != address(this)) revert VaultMismatch();
      } catch {
          revert InvalidDependency();
      }
    }

    /// @notice Deposit collateral into the insurance fund from `source`, minting its receipt tokens.
    /// @dev The deposit counts as protocol capital. Any outstanding debt is repaid first by `_update`.
    function depositInsuranceFund(uint256 amount) external {
        insuranceCapital += int256(amount);
        _depositFor(_msgSender(), INSURANCE_FUND_ADDR, amount);
        emit InsuranceFundDeposited(_msgSender(), amount);
    }

    /// @notice Withdraw collateral from the insurance fund to `recipient`, burning its receipt tokens.
    /// @dev Reverts while halted, and cannot move funds while the fund is in debt because that
    ///      balance is zero. Subtracts from `insuranceCapital`, which may go negative.
    function withdrawInsuranceFund(address recipient, uint256 amount) external onlyOwner {
        insuranceCapital -= int256(amount);
        _withdrawTo(INSURANCE_FUND_ADDR, recipient, amount);
        emit InsuranceFundWithdrawn(recipient, amount);
    }

    /// @notice Sweep realized backstop gains to `recipient`, burning its receipt tokens.
    /// @dev Goes through `_withdrawTo`, so the halt check and the backstop's portfolio margin apply.
    ///      Deposits, when wanted, use `depositFor(BACKSTOP_ADDR, amount)`.
    function withdrawBackstop(address recipient, uint256 amount) external onlyOwner {
        _withdrawTo(BACKSTOP_ADDR, recipient, amount);
        emit BackstopWithdrawn(recipient, amount);
    }

    /// @notice Set the backstop unwind band and caller fee shared by every venue.
    /// @dev All zeros is safe: unwinds fill only at or better than the mark and pay no fee.
    function setBackstopParams(uint16 unwindBandBps, uint16 unwindFeeBps) external onlyOwner {
        if (unwindBandBps > MAX_BACKSTOP_PARAM_BPS || unwindFeeBps > MAX_BACKSTOP_PARAM_BPS) {
            revert BackstopParamOutOfBounds();
        }
        backstopUnwindBandBps = unwindBandBps;
        backstopUnwindFeeBps = unwindFeeBps;
        emit BackstopParamsSet(unwindBandBps, unwindFeeBps);
    }

    // ── User functions ──────────────────────────────────────────────────────

    /// @notice Deposit collateral tokens; mints an equal amount of receipt tokens.
    function deposit(uint256 amount) external {
        _depositFor(_msgSender(), _msgSender(), amount);
    }

    /// @notice Deposit collateral tokens using an ERC-2612 permit (approve + deposit in one tx).
    /// @param amount   Amount of collateral to deposit.
    /// @param deadline Permit signature deadline.
    /// @param v        Permit signature v.
    /// @param r        Permit signature r.
    /// @param s        Permit signature s.
    function depositForPermit(address recipient, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        IERC20Permit(address(collateralToken)).permit(_msgSender(), address(this), amount, deadline, v, r, s);
        _depositFor(_msgSender(), recipient, amount);
    }

    /// @notice Withdraw collateral tokens; burns receipt tokens.
    ///         Reverts if the withdrawal would breach portfolio margin requirements.
    function withdraw(uint256 amount) external {
        _withdrawTo(_msgSender(), _msgSender(), amount);
    }

    function depositFor(address recipient, uint256 amount) external {
        _depositFor(_msgSender(), recipient, amount);
    }

    function withdrawTo(address recipient, uint256 amount) external onlyAuthorized {
        _withdrawTo(_msgSender(), recipient, amount);
    }

    // ── Authorized-only mutations ───────────────────────────────────────────

    /// @notice Move balance between two accounts (fee/PnL settlement).
    /// @dev Reverts when `from` cannot cover `amount`. Callers that must settle a shortfall
    ///      use `settleTransfer`.
    function internalTransfer(address from, address to, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        _transfer(from, to, amount);
    }

    /// @notice Settle `amount` from `from` to `to`, recording a shortfall instead of reverting.
    /// @dev Trader payer: move `min(balance, amount)`. The unpaid remainder is `BadDebt`.
    ///      It increases `traderBadDebtTotal` only when the receiver is the insurance fund.
    ///      Insurance-fund payer: pay the fund balance, mint the rest to `to`, and add it to
    ///      `insuranceDebt`. That mint is the borrow record. Borrowing is uncapped so the
    ///      receiver is always paid in full.
    ///      A borrow that leaves `insuranceDebt` above the effective cap latches `halted`
    ///      after the payout. The transaction completes; a later withdrawal in the same
    ///      transaction reverts and rolls the payout back.
    /// @return moved Amount credited to `to`.
    function settleTransfer(address from, address to, uint256 amount) external onlyAuthorized returns (uint256 moved) {
        if (amount == 0) return 0;
        if (from == address(0) || to == address(0)) revert ZeroAddress();

        if (from == INSURANCE_FUND_ADDR) {
            uint256 bal = balanceOf(from);
            if (bal >= amount) {
                _transfer(from, to, amount);
                return amount;
            }
            if (bal > 0) _transfer(from, to, bal);
            uint256 shortfall = amount - bal;
            _mint(to, shortfall);
            insuranceDebt += shortfall;
            if (insuranceDebt > effectiveInsuranceDebtCap()) _latchHalt(HaltReason.CAP);
            return amount;
        }

        uint256 available = balanceOf(from);
        uint256 pay = available < amount ? available : amount;
        if (pay > 0) _transfer(from, to, pay);
        if (pay < amount) {
            uint256 shortfall = amount - pay;
            emit BadDebt(from, to, shortfall, _msgSender());
            if (to == INSURANCE_FUND_ADDR) traderBadDebtTotal += shortfall;
        }
        return pay;
    }

    /// @notice Move balance between two accounts, reverting if the sender's portfolio margin is breached.
    function internalTransferWithMarginCheck(address from, address to, uint256 amount) external onlyAuthorized {
        if (amount == 0) return;
        _transfer(from, to, amount);
        _checkMargin(from);
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    /// @dev Pulls collateral from `source` and mints receipt tokens to `account`.
    ///      `Deposited` is emitted before the mint on purpose. A borrow is the same
    ///      kind of mint, with no `Deposited` log. The indexer sees logs in order, so
    ///      emitting this first lets it mark the following mint as a deposit instead
    ///      of counting that mint as debt and reversing the count afterwards. The
    ///      receipt balance itself changes on the mint that follows.
    function _depositFor(address source, address account, uint256 amount) internal {
        // recipient is checked to be non-zero in safeTransferFrom
        if (account == address(0)) revert ZeroAddress();
        collateralToken.safeTransferFrom(source, address(this), amount);
        emit Deposited(account, amount, source);
        _mint(account, amount);
    }

    /// @dev Burns `amount` from `account`, checks margin, transfers collateral to `recipient`, and emits Withdrawn.
    function _withdrawTo(address account, address recipient, uint256 amount) internal {
        // recipient is checked to be non-zero in safeTransfer
        if (halted) revert Halted();
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

    /// @notice Both backstop parameters in one read, for venues.
    function backstopParams() external view returns (uint16 unwindBandBps, uint16 unwindFeeBps) {
        return (backstopUnwindBandBps, backstopUnwindFeeBps);
    }

    /// @notice Cap that borrowing is checked against. Zero while the margin engine is unset,
    ///         because nothing then locks the collateral that is supposed to repay the debt.
    function effectiveInsuranceDebtCap() public view returns (uint256) {
        if (marginEngine == address(0)) return 0;
        return insuranceDebtCap;
    }

    /// @notice Trader shortfalls minus protocol capital. The amount a top-up must cover.
    function uncoveredLoss() public view returns (uint256) {
        if (insuranceCapital >= 0) {
            uint256 capital = uint256(insuranceCapital);
            if (traderBadDebtTotal <= capital) return 0;
            return traderBadDebtTotal - capital;
        }
        return traderBadDebtTotal + uint256(-insuranceCapital);
    }

    /// @notice Open debt that is not uncovered loss: the part backed by losers still in the market.
    function timingDebt() public view returns (uint256) {
        uint256 uncovered = uncoveredLoss();
        if (insuranceDebt <= uncovered) return 0;
        return insuranceDebt - uncovered;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @dev Every credit to the insurance fund repays debt before the balance can be withdrawn.
    ///      The repayment burn is the repay record. It goes through `super` so it does not recurse.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to != INSURANCE_FUND_ADDR || insuranceDebt == 0 || value == 0) return;
        uint256 repaid = value < insuranceDebt ? value : insuranceDebt;
        super._update(INSURANCE_FUND_ADDR, address(0), repaid);
        insuranceDebt -= repaid;
    }

    function _latchHalt(HaltReason reason) internal {
        if (halted) return;
        halted = true;
        emit VaultHalted(reason, insuranceDebt, effectiveInsuranceDebtCap());
    }
}
