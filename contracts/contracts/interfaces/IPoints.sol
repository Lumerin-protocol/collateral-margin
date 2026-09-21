// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPoints — Mint/burn + balance surface the hook and redeemer rely on
/// @notice The canonical POINTS token (6 decimals) is a non-transferable ledger:
///         attributing points is a `mint`, redeeming them is a `burn`. Both are
///         role-gated; there are no user-to-user transfers and no allowances.
interface IPoints {
    /// @notice Mint `amount` POINTS to `to`. Restricted to `MINTER_ROLE`; reverts once finalized.
    function mint(address to, uint256 amount) external;

    /// @notice Burn `amount` POINTS from `from`. Restricted to `BURNER_ROLE` (the redeemer).
    function burn(address from, uint256 amount) external;

    /// @notice Whether minting has been permanently frozen via `finalize()`.
    function finalized() external view returns (bool);

    /// @notice Current POINTS balance of `account`.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Total POINTS in circulation.
    function totalSupply() external view returns (uint256);
}
