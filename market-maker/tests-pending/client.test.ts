import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chainMapping, hardhat, createClients } from "../src/client.ts";
import type { MakerConfig } from "../src/config.ts";

function makeConfig(overrides: Partial<MakerConfig> = {}): MakerConfig {
  return {
    network: "hardhat",
    ethNodeAddress: "http://localhost:8545",
    perpsAddress: "0x0000000000000000000000000000000000000001",
    makerPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    numLevelsPerSide: 5,
    baseQuantity: 1_000_000n,
    minSpreadBps: 10,
    volatilityMultiplier: 2.0,
    inventorySkewGamma: 0.5,
    maxSkewTicks: 20,
    gasSpikeThresholdPct: 200,
    gasCapMultiplier: 2.0,
    gasPenaltyBps: 5,
    maxGasBudgetPerHourUsd: 50_000_000n,
    maxGasBudgetPerDayUsd: 500_000_000n,
    urgentRequoteThresholdTicks: 10,
    maxPositionSize: 100_000_000n,
    maxUtilizationPct: 80,
    minCollateralBalance: 100_000_000n,
    maxDailyLossUsd: 1_000_000_000n,
    pollIntervalMs: 3000,
    requoteThresholdTicks: 2,
    requoteCooldownMs: 1000,
    resyncIntervalMs: 60000,
    dryRun: false,
    healthPort: 3001,
    logLevel: "silent",
    ...overrides,
  } as MakerConfig;
}

describe("chainMapping", () => {
  it("contains hardhat, arbitrum, and arbitrum-sepolia", () => {
    assert.ok("hardhat" in chainMapping);
    assert.ok("arbitrum" in chainMapping);
    assert.ok("arbitrum-sepolia" in chainMapping);
  });
});

describe("hardhat chain", () => {
  it("has multicall3 address configured", () => {
    assert.ok(hardhat.contracts?.multicall3);
    assert.equal(
      hardhat.contracts.multicall3.address,
      "0xcA11bde05977b3631167028862bE2a173976CA11",
    );
  });
});

describe("createClients", () => {
  it("throws on unsupported network", () => {
    const config = makeConfig({ network: "unknown-chain" });
    assert.throws(() => createClients(config), {
      message: /Unsupported network: unknown-chain/,
    });
  });

  it("creates clients for hardhat network with http transport", () => {
    const config = makeConfig({ network: "hardhat" });
    const { publicClient, walletClient, account, chain } = createClients(config);
    assert.ok(publicClient);
    assert.ok(walletClient);
    assert.ok(account);
    assert.equal(chain.id, hardhat.id);
  });

  it("derives correct account from private key", () => {
    const config = makeConfig();
    const { account } = createClients(config);
    assert.ok(account.address.startsWith("0x"));
    assert.equal(account.address.length, 42);
  });

  it("uses websocket transport when URL starts with ws", () => {
    const config = makeConfig({ ethNodeAddress: "ws://localhost:8545" });
    const { publicClient, walletClient } = createClients(config);
    assert.ok(publicClient);
    assert.ok(walletClient);
  });
});
