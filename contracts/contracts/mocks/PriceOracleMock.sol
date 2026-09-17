//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PriceOracleMock
/// @notice Mock price oracle for testing that properly handles timestamps
contract PriceOracleMock {
    uint8 private _decimals;
    int256 private _price;
    string private _description = "Price Oracle Mock";
    uint256 private _frozenTimestamp; // If non-zero, use this instead of block.timestamp

    constructor(int256 initialPrice, uint8 decimals_) {
        _price = initialPrice;
        _decimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function _getUpdatedAt() private view returns (uint256) {
        return _frozenTimestamp > 0 ? _frozenTimestamp : block.timestamp;
    }

    function getRoundData(uint80)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 ts = _getUpdatedAt();
        return (0, _price, ts, ts, 0);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 ts = _getUpdatedAt();
        return (0, _price, ts, ts, 0);
    }

    function setPrice(int256 price, uint8 decimals_) external {
        _price = price;
        _decimals = decimals_;
    }

    /// @notice Freeze the timestamp at the current block.timestamp
    /// @dev After calling this, advancing time will make the oracle appear stale
    function freezeTimestamp() external {
        _frozenTimestamp = block.timestamp;
    }

    /// @notice Unfreeze the timestamp to always return current block.timestamp
    function unfreezeTimestamp() external {
        _frozenTimestamp = 0;
    }
}
