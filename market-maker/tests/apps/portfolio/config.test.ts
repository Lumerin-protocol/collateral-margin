import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPortfolioConfig, type ParsedFuturesVenue } from "../../../src/apps/portfolio/config.ts";

function writeTmp(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

const VALID_YAML = `
wallet: default
wallets:
  default:
    privateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
network:
  name: arbitrum
  rpcUrl: "https://arb1.arbitrum.io/rpc"
venues:
  - kind: perps
    address: "0x1111111111111111111111111111111111111111"
    maxPositionSize: 10
    pricing:
      strategy: effective-spread
      minSpreadBps: 15
      volatilityMultiplier: 2.0
      inventorySkewGamma: 0.5
      maxSkewTicks: 20
    sizing:
      strategy: linear
      baseQuantity: "500000000"
      numLevelsPerSide: 4
  - kind: futures
    address: "0x2222222222222222222222222222222222222222"
    maxPositionSize: 5
    marketSelection:
      mode: nearest
      count: 3
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
  tmpDir = mkdtempSync(join(tmpdir(), "mm-pf-cfg-"));
});

describe("loadPortfolioConfig", () => {
  it("parses a valid multi-venue config", () => {
    const path = writeTmp(tmpDir, "test.yml", VALID_YAML);
    const cfg = loadPortfolioConfig({ path });
    assert.equal(cfg.wallet, "default");
    assert.equal(cfg.venues.length, 2);
    assert.equal(cfg.venues[0].kind, "perps");
    assert.equal(cfg.venues[1].kind, "futures");
    // USD parsed to 6-decimal bigint.
    assert.equal(cfg.venues[0].maxPositionSize, 10_000_000n);
    // Futures market selection + baseQuantity bigint.
    const fut = cfg.venues[1] as ParsedFuturesVenue;
    assert.deepEqual(fut.marketSelection, { mode: "nearest", count: 3 });
    assert.equal(fut.sizing.baseQuantity, 500_000_000n);
  });

  it("defaults futures marketSelection to nearest-1 when omitted", () => {
    const yaml = VALID_YAML.replace(
      `    marketSelection:
      mode: nearest
      count: 3
`,
      "",
    );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    const cfg = loadPortfolioConfig({ path });
    const fut = cfg.venues[1] as ParsedFuturesVenue;
    assert.deepEqual(fut.marketSelection, { mode: "nearest", count: 1 });
  });

  it("applies txCoordinator and circuitBreaker defaults", () => {
    const path = writeTmp(tmpDir, "test.yml", VALID_YAML);
    const cfg = loadPortfolioConfig({ path });
    assert.equal(cfg.txCoordinator.maxCallsPerTx, 100);
    assert.equal(cfg.txCoordinator.confirmationTimeoutMs, 60_000);
    assert.equal(cfg.circuitBreaker.quarantineThreshold, 3);
    assert.equal(cfg.rollCheckIntervalMs, 300_000);
    assert.equal(cfg.sharedStalenessGraceMs, 30_000);
  });

  it("throws when the shared wallet is not declared", () => {
    const yaml = VALID_YAML.replace("wallet: default", "wallet: ghost");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPortfolioConfig({ path }), /ghost/);
  });

  it("rejects duplicate venue kinds", () => {
    const yaml = VALID_YAML.replace('kind: futures\n    address: "0x2222222222222222222222222222222222222222"', 'kind: perps\n    address: "0x2222222222222222222222222222222222222222"')
      .replace(
        `    marketSelection:
      mode: nearest
      count: 3
`,
        "",
      )
      .replace(
        `      strategy: reservation-price
      riskAversion: 0.001
      marginCallTimeSec: 3600
      minSpreadBps: 15
      volatilityMultiplier: 2.5
      maxSkewTicks: 0`,
        `      strategy: effective-spread
      minSpreadBps: 15
      volatilityMultiplier: 2.0
      inventorySkewGamma: 0.5
      maxSkewTicks: 20`,
      )
      .replace(
        `      strategy: geometric-taper
      baseQuantity: "500000000"
      numLevelsPerSide: 4
      taperRatio: 0.6`,
        `      strategy: linear
      baseQuantity: "500000000"
      numLevelsPerSide: 4`,
      );
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPortfolioConfig({ path }), /duplicate venue kind/);
  });

  it("rejects an empty venues array", () => {
    const yaml = VALID_YAML.replace(/venues:[\s\S]*?risk:/, "venues: []\nrisk:");
    const path = writeTmp(tmpDir, "test.yml", yaml);
    assert.throws(() => loadPortfolioConfig({ path }), /Config validation failed/);
  });
});
