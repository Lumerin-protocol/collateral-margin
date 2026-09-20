// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev 18-decimal fixed-point scale used for cross-product margin math
///      ("wad" = wei-scale arithmetic unit).
uint8 constant WAD_DECIMALS = 18;
uint256 constant WAD = 10 ** WAD_DECIMALS;

/// @title MathLib — Pure math helpers
library MathLib {
    /// @notice Scale a value from one decimal precision to another.
    function scaleDecimals(uint256 value, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) return value;
        if (fromDecimals < toDecimals) return value * (10 ** (toDecimals - fromDecimals));
        return value / (10 ** (fromDecimals - toDecimals));
    }

    /// @notice Signed overload.
    function scaleDecimals(int256 value, uint8 fromDecimals, uint8 toDecimals) internal pure returns (int256) {
        if (fromDecimals == toDecimals) return value;
        if (fromDecimals < toDecimals) return value * int256(10 ** (toDecimals - fromDecimals));
        return value / int256(10 ** (fromDecimals - toDecimals));
    }

    /// @notice Scale a `fromDecimals`-decimal value up to WAD.
    function toWad(uint256 value, uint8 fromDecimals) internal pure returns (uint256) {
        return scaleDecimals(value, fromDecimals, WAD_DECIMALS);
    }

    /// @notice Signed overload.
    function toWad(int256 value, uint8 fromDecimals) internal pure returns (int256) {
        return scaleDecimals(value, fromDecimals, WAD_DECIMALS);
    }

    /// @notice Scale a WAD value down to `toDecimals`.
    function fromWad(uint256 wadAmount, uint8 toDecimals) internal pure returns (uint256) {
        return scaleDecimals(wadAmount, WAD_DECIMALS, toDecimals);
    }
}
