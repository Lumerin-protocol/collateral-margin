import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expirationAtMarketId, marketIdToExpirationAt } from "../../src/venues/futures.ts";

describe("futures venue marketId helpers", () => {
  it("encodes a delivery date as bytes32 and round-trips", () => {
    const expirationAt = 1_756_416_000n; // 2025-08-29T00:00:00Z
    const id = expirationAtMarketId(expirationAt);
    assert.equal(id.length, 66, "bytes32 hex string is 0x + 64 chars");
    assert.equal(marketIdToExpirationAt(id), expirationAt);
  });

  it("encodes 0 as the zero bytes32", () => {
    assert.equal(
      expirationAtMarketId(0n),
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});
