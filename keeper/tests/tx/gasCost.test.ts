import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TransactionReceipt } from "viem";
import { formatGasCost } from "../../src/tx/gasCost.ts";
import type { EthUsdFeed } from "../../src/oracle/ethUsdFeed.ts";

/**
 * Stand-in for the real EthUsdFeed — we only exercise `weiToUsd` here.
 * Builds either a deterministic ETH price (typed) or a "never primed" feed
 * that returns `undefined` so we can verify the absent-USD code path.
 */
function makeFeed(weiToUsd: (wei: bigint) => number | undefined): EthUsdFeed {
  return { weiToUsd } as unknown as EthUsdFeed;
}

function receipt(gasUsed: bigint, effectiveGasPrice: bigint) {
  // Cast through a partial — formatGasCost only reads two fields and we
  // deliberately don't construct the rest of TransactionReceipt.
  return { gasUsed, effectiveGasPrice } as unknown as TransactionReceipt;
}

describe("formatGasCost", () => {
  it("returns gasUsed (number), gwei-formatted gas price and ether-formatted cost", () => {
    // 100k gas at 2 gwei = 200_000 * 2e9 = 4e14 wei = 0.0002 ETH
    const fields = formatGasCost(receipt(200_000n, 2_000_000_000n));
    assert.equal(fields.gasUsed, 200_000);
    assert.equal(fields.gasPriceGwei, "2");
    assert.equal(fields.gasCostEth, "0.0004");
    assert.equal(fields.gasCostUsd, undefined, "no feed → no USD field");
  });

  it("omits gasCostUsd when feed is provided but uninitialised", () => {
    // Pre-feed-priming case (e.g. tx mined before the first refresh).
    const fields = formatGasCost(
      receipt(100_000n, 1_000_000_000n),
      makeFeed(() => undefined),
    );
    assert.equal(fields.gasCostUsd, undefined);
    assert.equal(fields.gasCostEth, "0.0001");
  });

  it("includes a rounded gasCostUsd when the feed produces a value", () => {
    // 100k * 1 gwei = 1e14 wei. Pretend ETH/USD = $3000; cost = 0.0001 * 3000 = $0.3
    const fields = formatGasCost(
      receipt(100_000n, 1_000_000_000n),
      makeFeed((wei) => Number(wei) * 3000 / 1e18),
    );
    assert.equal(fields.gasCostUsd, 0.3);
  });

  it("rounds gasCostUsd to 6 decimal places so log output stays terse", () => {
    // Pick a value that produces noisy fp trailing digits in JSON output.
    const fields = formatGasCost(
      receipt(1n, 1n),
      makeFeed(() => 0.123456789),
    );
    assert.equal(fields.gasCostUsd, 0.123457);
  });

  it("handles a literally-zero-cost receipt without dividing by zero or returning NaN", () => {
    const fields = formatGasCost(
      receipt(0n, 0n),
      makeFeed((wei) => (wei === 0n ? 0 : 1)),
    );
    assert.equal(fields.gasUsed, 0);
    assert.equal(fields.gasPriceGwei, "0");
    assert.equal(fields.gasCostEth, "0");
    assert.equal(fields.gasCostUsd, 0);
  });

  it("tolerates a partial receipt with null gasUsed / effectiveGasPrice (RPC fallback)", () => {
    // Some providers return `null` here on freshly-mined txs; we must
    // not crash a tx confirmation path on a cosmetic field.
    const partial = { gasUsed: null, effectiveGasPrice: null } as unknown as TransactionReceipt;
    const fields = formatGasCost(partial);
    assert.equal(fields.gasUsed, 0);
    assert.equal(fields.gasCostEth, "0");
  });
});
