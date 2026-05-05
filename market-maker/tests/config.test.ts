import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type MakerConfig } from "../src/config.ts";

function writeTmp(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

const VALID_YAML = `
wallets:
  default:
    privateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
network:
  name: arbitrum
  rpcUrl: "https://arb1.arbitrum.io/rpc"
venue:
  kind: perps
  wallet: default
  address: "0x1234567890123456789012345678901234567890"
pricing:
  strategy: effective-spread
  minSpreadBps: 10
  volatilityMultiplier: 2.0
  inventorySkewGamma: 0.5
  maxSkewTicks: 20
sizing:
  strategy: linear
  baseQuantity: "1000000"
  numLevelsPerSide: 5
risk:
  maxPositionSize: "50000000"
  maxUtilizationPct: 80
  minCollateralBalance: "10000000"
  maxDailyLossUsd: "500000000"
gas:
  gasCapMultiplier: 2.0
timing:
  pollIntervalMs: 3000
health:
  port: 8080
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mm-cfg-"));
});

afterEach(() => {
  try { unlinkSync(join(tmpDir, "test.yml")); } catch { /* ignore */ }
});

describe("loadConfig", () => {
  it("parses a valid YAML file", () => {
    const path = writeTmp(tmpDir, "test.yml", VALID_YAML);
    const cfg = loadConfig({ path });
    assert.strictEqual(cfg.venue.kind, "perps");
    assert.strictEqual(cfg.network.name, "arbitrum");
    assert.strictEqual(cfg.pricing.minSpreadBps, 10);
    assert.strictEqual(cfg.sizing.baseQuantity, "1000000");
  });

  it("applies defaults for optional fields", () => {
    // Remove the whole timing block to trigger defaults
    const yaml = VALID_YAML.replace(
      /^timing:\n  pollIntervalMs: 3000\n/m,
      "timing: {}\n",
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const cfg = loadConfig({ path });
    assert.strictEqual(cfg.timing.pollIntervalMs, 3000); // default
  });

  it("expands ${VAR} tokens from env", () => {
    const yaml = `
wallets:
  default:
    privateKey: \${TEST_PRIVATE_KEY}
network:
  name: arbitrum
  rpcUrl: \${TEST_RPC_URL}
venue:
  kind: perps
  wallet: default
  address: "0x1234567890123456789012345678901234567890"
pricing:
  strategy: effective-spread
  minSpreadBps: 5
  volatilityMultiplier: 1.0
  inventorySkewGamma: 0.3
  maxSkewTicks: 10
sizing:
  strategy: linear
  baseQuantity: "500000"
  numLevelsPerSide: 3
risk:
  maxPositionSize: "10000000"
  minCollateralBalance: "5000000"
  maxDailyLossUsd: "100000000"
gas:
  gasCapMultiplier: 1.5
timing: {}
health: {}
`;
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const env: NodeJS.ProcessEnv = {
      TEST_PRIVATE_KEY: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      TEST_RPC_URL: "https://example.com/rpc",
    };
    const cfg = loadConfig({ path, env });
    assert.strictEqual(cfg.wallets["default"].privateKey, env.TEST_PRIVATE_KEY);
    assert.strictEqual(cfg.network.rpcUrl, "https://example.com/rpc");
  });

  it("throws for missing env variable", () => {
    const yaml = VALID_YAML.replace(
      '"0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"',
      "${MISSING_VAR}",
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(
      () => loadConfig({ path, env: {} }),
      /MISSING_VAR/,
    );
  });

  it("supports ${VAR:-default} fallback syntax", () => {
    const yaml = VALID_YAML.replace(
      '"0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"',
      '${ABSENT_KEY:-0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890}',
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const cfg = loadConfig({ path, env: {} });
    assert.strictEqual(
      cfg.wallets["default"].privateKey,
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
  });

  it("throws when venue.wallet is not declared in wallets map", () => {
    const yaml = VALID_YAML.replace("wallet: default", "wallet: undeclaredWallet");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadConfig({ path }), /undeclaredWallet/);
  });

  it("throws on invalid venue.kind", () => {
    const yaml = VALID_YAML.replace("kind: perps", "kind: invalidkind");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadConfig({ path }), /Config validation failed/);
  });

  it("throws on invalid address format", () => {
    const yaml = VALID_YAML.replace(
      '"0x1234567890123456789012345678901234567890"',
      '"not-an-address"',
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadConfig({ path }), /Config validation failed/);
  });

  it("throws when config file does not exist", () => {
    assert.throws(
      () => loadConfig({ path: "/nonexistent/path/config.yml" }),
      /Failed to read config/,
    );
  });

  it("throws when no path provided and no MAKER_CONFIG env", () => {
    assert.throws(
      () => loadConfig({ env: {} }), // no MAKER_CONFIG in env, no argv flag
      /No config path/,
    );
  });

  it("accepts reservation-price strategy with riskAversion", () => {
    const yaml = VALID_YAML
      .replace("strategy: effective-spread", "strategy: reservation-price")
      .replace("  inventorySkewGamma: 0.5\n", "  riskAversion: 0.2\n  marginCallTimeSeconds: 3600\n");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const cfg = loadConfig({ path });
    assert.strictEqual(cfg.pricing.strategy, "reservation-price");
  });

  it("parses futures.yml-style config with geometric-taper sizing", () => {
    const yaml = VALID_YAML
      .replace("strategy: linear", "strategy: geometric-taper")
      .replace("  numLevelsPerSide: 5\n", "  numLevelsPerSide: 4\n  taperRatio: 0.6\n");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const cfg: MakerConfig = loadConfig({ path });
    assert.strictEqual(cfg.sizing.strategy, "geometric-taper");
    assert.strictEqual(cfg.sizing.taperRatio, 0.6);
  });
});
