// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AggregatorEventMock
/// @notice Minimal Chainlink `AggregatorV3Interface` implementation that
///         emits `AnswerUpdated` whenever the price is set.
///
///         The perps `PriceOracleMock` already implements `latestRoundData`
///         /`decimals` / `setPrice`, but it does **not** emit
///         `AnswerUpdated` — its callers only ever poll. The keeper's
///         predictive layer, however, subscribes to `AnswerUpdated` on a
///         BTC/USDC feed as its hot-path trigger, so for the integration
///         test we need a feed that actually fires the event.
///
///         Field layout mirrors a real Chainlink `AggregatorProxy`:
///         - 80-bit roundId monotonically increments on every `setPrice`
///         - `updatedAt` / `startedAt` are the block timestamp of the set
///         - `answeredInRound == roundId` (no out-of-order rounds in tests)
contract AggregatorEventMock {
    /// @dev Same indexing order Chainlink uses — `current` and `roundId`
    ///      are both indexed so subgraph / off-chain consumers can filter
    ///      on either.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    int256 private _answer;
    uint80 private _roundId;
    uint256 private _updatedAt;
    uint8 private immutable _decimals;
    string private _description;

    constructor(int256 initialAnswer, uint8 decimals_, string memory description_) {
        _answer = initialAnswer;
        _decimals = decimals_;
        _description = description_;
        _roundId = 1;
        _updatedAt = block.timestamp;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    /// @notice Push a new answer and emit `AnswerUpdated`. Used by the
    ///         integration test to trigger predictor evaluation.
    function setAnswer(int256 newAnswer) external {
        _answer = newAnswer;
        _roundId += 1;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(newAnswer, _roundId, _updatedAt);
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function getRoundData(uint80)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        // No historical round storage — `getRoundData(0)` returns the same
        // value as `latestRoundData()`. The integration test only ever
        // polls `latestRoundData` after an event tick, so this is fine.
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
