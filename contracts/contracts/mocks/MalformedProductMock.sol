// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MalformedProductMock — answers every call with a single word
/// @notice Stands in for a contract that responds to the portfolio-margin selectors but
///         with the wrong return shape. Nothing about the call itself distinguishes it
///         from a healthy product; only decoding the answer against the expected return
///         type does, which is what the engine's registration checks rely on.
contract MalformedProductMock {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(1));
    }
}
