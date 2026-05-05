import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPerpsConfig } from "../../../src/apps/perps/config.ts";

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
collateral: {}
health:
  port: 8080
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mm-perps-cfg-"));
});

afterEach(() => {
  try { unlinkSync(join(tmpDir, "test.yml")); } catch { /* ignore */ }
});

describe("loadPerpsConfig", () => {
  it("parses a valid YAML file", () => {
    const path = writeTmp(tmpDir, "test.yml", VALID_YAML);
    const cfg = loadPerpsConfig({ path });
    assert.strictEqual(cfg.venue.kind, "perps");
    assert.strictEqual(cfg.network.name, "arbitrum");
    assert.strictEqual(cfg.pricing.strategy, "effective-spread");
    assert.strictEqual(cfg.sizing.strategy, "linear");
  });

  it("rejects reservation-price strategy on perps", () => {
    const yaml = VALID_YAML
      .replace("strategy: effective-spread", "strategy: reservation-price")
      .replace("  inventorySkewGamma: 0.5\n", "  riskAversion: 0.2\n  marginCallTimeSeconds: 3600\n");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPerpsConfig({ path }), /Config validation failed/);
  });

  it("rejects geometric-taper sizing on perps", () => {
    const yaml = VALID_YAML
      .replace("strategy: linear", "strategy: geometric-taper")
      .replace("  numLevelsPerSide: 5\n", "  numLevelsPerSide: 4\n  taperRatio: 0.6\n");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPerpsConfig({ path }), /Config validation failed/);
  });

  it("expands ${VAR} tokens from env", () => {
    const yaml = VALID_YAML
      .replace('"0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"', "${TEST_PRIVATE_KEY}")
      .replace('"https://arb1.arbitrum.io/rpc"', "${TEST_RPC_URL}");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const env: NodeJS.ProcessEnv = {
      TEST_PRIVATE_KEY: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      TEST_RPC_URL: "https://example.com/rpc",
    };
    const cfg = loadPerpsConfig({ path, env });
    assert.strictEqual(cfg.network.rpcUrl, "https://example.com/rpc");
  });

  it("supports ${VAR:-default} fallback syntax", () => {
    const yaml = VALID_YAML.replace(
      '"0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"',
      '${ABSENT_KEY:-0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890}',
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const cfg = loadPerpsConfig({ path, env: {} });
    assert.strictEqual(
      cfg.wallets.default.privateKey,
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
  });

  it("throws when venue.wallet is not declared in wallets map", () => {
    const yaml = VALID_YAML.replace("wallet: default", "wallet: undeclaredWallet");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPerpsConfig({ path }), /undeclaredWallet/);
  });

  it("throws on invalid address format", () => {
    const yaml = VALID_YAML.replace(
      '"0x1234567890123456789012345678901234567890"',
      '"not-an-address"',
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPerpsConfig({ path }), /Config validation failed/);
  });

  it("rejects unknown top-level keys", () => {
    const yaml = `${VALID_YAML}\nbogus: 1\n`;
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPerpsConfig({ path }), /Config validation failed/);
  });

  it("rejects unknown nested keys", () => {
    const yaml = VALID_YAML.replace("  gasCapMultiplier: 2.0", "  gasCapMultiplier: 2.0\n  bogusGasField: 1");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPerpsConfig({ path }), /Config validation failed/);
  });
});
