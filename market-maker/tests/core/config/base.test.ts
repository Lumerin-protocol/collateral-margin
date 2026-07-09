import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import {
  configBigint,
  expandEnv,
  sanitiseConfig,
} from "../../../src/core/config/base.ts";

// Anvil account #0 — deterministic, not a real secret.
const TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("sanitiseConfig", () => {
  it("redacts private keys, derives addresses, and masks RPC secrets", () => {
    const cfg = {
      wallets: { maker: { privateKey: TEST_KEY } },
      network: { rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/SUPER_SECRET?k=1" },
    };
    const s = sanitiseConfig(cfg);
    const wallets = s.wallets as Record<string, { privateKey: string; address: string }>;

    assert.equal(wallets.maker.privateKey, "[REDACTED]");
    assert.equal(wallets.maker.address, TEST_ADDRESS);
    assert.equal(
      (s.network as { rpcUrl: string }).rpcUrl,
      "https://eth-mainnet.g.alchemy.com/[redacted]",
    );
    // The original config is not mutated (deep clone).
    assert.equal(cfg.wallets.maker.privateKey, TEST_KEY);
    assert.equal(cfg.network.rpcUrl, "https://eth-mainnet.g.alchemy.com/v2/SUPER_SECRET?k=1");
  });

  it("marks an unparseable private key as [invalid] and leaves a bare host untouched", () => {
    const s = sanitiseConfig({
      wallets: { bad: { privateKey: "0xdeadbeef" as Hex } },
      network: { rpcUrl: "http://localhost:8545" },
    });
    const wallets = s.wallets as Record<string, { address: string }>;
    assert.equal(wallets.bad.address, "[invalid]");
    // No path or query → host preserved, nothing to redact.
    assert.equal((s.network as { rpcUrl: string }).rpcUrl, "http://localhost:8545");
  });

  it("reports an unparseable RPC URL as [invalid url]", () => {
    const s = sanitiseConfig({
      wallets: {},
      network: { rpcUrl: "not a url" },
    });
    assert.equal((s.network as { rpcUrl: string }).rpcUrl, "[invalid url]");
  });
});

describe("configBigint", () => {
  it("parses a numeric string", () => {
    assert.equal(configBigint("1500000", "risk.maxPositionSize"), 1_500_000n);
  });

  it("throws a ConfigError with the field name on a bad value", () => {
    assert.throws(
      () => configBigint("12.5", "risk.cap"),
      /Invalid bigint value for risk\.cap/,
    );
  });
});

describe("expandEnv", () => {
  const env = { FOO: "bar", EMPTY: "" } as unknown as NodeJS.ProcessEnv;

  it("interpolates variables recursively through objects and arrays", () => {
    const out = expandEnv({ a: "${FOO}", b: ["x", "${FOO}"], c: 3 }, env);
    assert.deepEqual(out, { a: "bar", b: ["x", "bar"], c: 3 });
  });

  it("uses the :- default when the variable is unset or empty", () => {
    assert.equal(expandEnv("${MISSING:-fallback}", env), "fallback");
    assert.equal(expandEnv("${EMPTY:-fallback}", env), "fallback");
  });

  it("throws when a required variable is unset and has no default", () => {
    assert.throws(() => expandEnv("${MISSING}", env), /Environment variable "MISSING" is not set/);
  });

  it("passes through non-string leaves untouched", () => {
    assert.equal(expandEnv(42, env), 42);
    assert.equal(expandEnv(true, env), true);
    assert.equal(expandEnv(null, env), null);
  });
});
