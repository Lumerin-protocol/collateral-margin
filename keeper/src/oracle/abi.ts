import { parseAbi } from "viem";

/**
 * Minimal Chainlink `AggregatorV3` / `AggregatorProxy` surface — three
 * entries are all the predictive layer needs:
 *
 *   - `AnswerUpdated` event: trigger to re-evaluate the price index.
 *   - `latestRoundData`: read the current answer from the aggregator.
 *   - `decimals`: rebase the answer to the venue's token decimals.
 *
 * Inlined as a human-readable signature list to keep the keeper free of any
 * dependency on `@chainlink/contracts`. The shape matches both Chainlink's
 * proxy aggregator and the in-house `HashpriceUSD` contract (which
 * implements `AggregatorV3Interface` directly).
 */
export const AggregatorV3Abi = parseAbi([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
