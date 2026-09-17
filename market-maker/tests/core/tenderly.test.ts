import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachTenderlyUrl, buildTenderlySimulationUrl } from "../../src/core/tenderly.ts";

describe("buildTenderlySimulationUrl", () => {
  it("encodes the required fields onto the simulator URL", () => {
    const url = buildTenderlySimulationUrl({
      chainId: 84532,
      from: "0x1441Bc52156Cf18c12cde6A92aE6BDE8B7f775D4",
      to: "0x56d8d4a03a0f34b93B86E0b7941aFF29178D0479",
      data: "0xac9650d8",
    });
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://dashboard.tenderly.co/simulator/new");
    assert.equal(parsed.searchParams.get("network"), "84532");
    assert.equal(parsed.searchParams.get("from"), "0x1441Bc52156Cf18c12cde6A92aE6BDE8B7f775D4");
    assert.equal(
      parsed.searchParams.get("contractAddress"),
      "0x56d8d4a03a0f34b93B86E0b7941aFF29178D0479",
    );
    assert.equal(parsed.searchParams.get("rawFunctionInput"), "0xac9650d8");
    assert.equal(parsed.searchParams.get("value"), null);
    assert.equal(parsed.searchParams.get("gas"), null);
  });

  it("omits `value` when zero and includes it when non-zero", () => {
    const zero = new URL(
      buildTenderlySimulationUrl({
        chainId: 1,
        from: "0xfrom",
        to: "0xto",
        data: "0x",
        value: 0n,
      }),
    );
    assert.equal(zero.searchParams.get("value"), null);
    const nonZero = new URL(
      buildTenderlySimulationUrl({
        chainId: 1,
        from: "0xfrom",
        to: "0xto",
        data: "0x",
        value: 1_000_000_000n,
      }),
    );
    assert.equal(nonZero.searchParams.get("value"), "1000000000");
  });

  it("includes `gas` when provided", () => {
    const parsed = new URL(
      buildTenderlySimulationUrl({
        chainId: 1,
        from: "0xfrom",
        to: "0xto",
        data: "0x",
        gas: 500_000n,
      }),
    );
    assert.equal(parsed.searchParams.get("gas"), "500000");
  });
});

describe("attachTenderlyUrl", () => {
  it("mutates the error to add `tenderlyUrl` and returns it", () => {
    const err = new Error("boom");
    const out = attachTenderlyUrl(err, {
      chainId: 84532,
      from: "0xfrom",
      to: "0xto",
      data: "0xdead",
    });
    assert.equal(out, err);
    const url = (err as unknown as { tenderlyUrl: string }).tenderlyUrl;
    assert.match(url, /^https:\/\/dashboard\.tenderly\.co\/simulator\/new\?/);
    assert.match(url, /network=84532/);
    assert.match(url, /rawFunctionInput=0xdead/);
  });

  it("is a no-op for non-object errors", () => {
    const out = attachTenderlyUrl("string error", {
      chainId: 1,
      from: "0xfrom",
      to: "0xto",
      data: "0x",
    });
    assert.equal(out, "string error");
  });
});
