import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFuturesConfig } from "../../../src/apps/futures/config.ts";

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
  kind: futures
  wallet: default
  address: "0x1234567890123456789012345678901234567890"
pricing:
  strategy: reservation-price
  riskAversion: 0.001
  marginCallTimeSec: 3600
  minSpreadBps: 15
  volatilityMultiplier: 2.5
  maxSkewTicks: 0
sizing:
  strategy: geometric-taper
  baseQuantity: "500000000"
  numLevelsPerSide: 4
  taperRatio: 0.6
risk:
  maxPositionSize: 50
  maxUtilizationPct: 80
  minCollateralBalance: 10
  maxDailyLossUsd: 500
gas:
  gasCapMultiplier: 2.0
timing: {}
collateral: {}
oracle: {}
health:
  port: 8080
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mm-fut-cfg-"));
});

afterEach(() => {
  try { unlinkSync(join(tmpDir, "test.yml")); } catch { /* ignore */ }
});

describe("loadFuturesConfig", () => {
  it("parses a valid YAML file", () => {
    const path = writeTmp(tmpDir, "test.yml", VALID_YAML);
    const cfg = loadFuturesConfig({ path });
    assert.strictEqual(cfg.venue.kind, "futures");
    assert.strictEqual(cfg.pricing.strategy, "reservation-price");
    assert.strictEqual(cfg.sizing.strategy, "geometric-taper");
    assert.strictEqual(cfg.sizing.taperRatio, 0.6);
  });

  it("rejects effective-spread strategy on futures", () => {
    const yaml = VALID_YAML.replace(
      `pricing:
  strategy: reservation-price
  riskAversion: 0.001
  marginCallTimeSec: 3600
  minSpreadBps: 15
  volatilityMultiplier: 2.5
  maxSkewTicks: 0`,
      `pricing:
  strategy: effective-spread
  minSpreadBps: 10
  volatilityMultiplier: 2.0
  inventorySkewGamma: 0.5
  maxSkewTicks: 20`,
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadFuturesConfig({ path }), /Config validation failed/);
  });

  it("rejects linear sizing on futures", () => {
    const yaml = VALID_YAML.replace(
      `sizing:
  strategy: geometric-taper
  baseQuantity: "500000000"
  numLevelsPerSide: 4
  taperRatio: 0.6`,
      `sizing:
  strategy: linear
  baseQuantity: "500000000"
  numLevelsPerSide: 4`,
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadFuturesConfig({ path }), /Config validation failed/);
  });

  it("rejects taperRatio outside (0, 1)", () => {
    const yaml = VALID_YAML.replace("taperRatio: 0.6", "taperRatio: 1.0");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadFuturesConfig({ path }), /Config validation failed/);
  });

  it("requires riskAversion and marginCallTimeSec", () => {
    const yaml = VALID_YAML.replace("  riskAversion: 0.001\n  marginCallTimeSec: 3600\n", "");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadFuturesConfig({ path }), /Config validation failed/);
  });

  it("throws when venue.wallet is not declared in wallets map", () => {
    const yaml = VALID_YAML.replace("wallet: default", "wallet: undeclaredWallet");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadFuturesConfig({ path }), /undeclaredWallet/);
  });

  it("rejects unknown top-level keys", () => {
    const yaml = `${VALID_YAML}\nbogus: 1\n`;
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadFuturesConfig({ path }), /Config validation failed/);
  });

  it("rejects unknown nested keys", () => {
    const yaml = VALID_YAML.replace("  port: 8080", "  port: 8080\n  bogusHealthField: true");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadFuturesConfig({ path }), /Config validation failed/);
  });
});
