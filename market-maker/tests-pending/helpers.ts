export {
  HARDHAT_ACCOUNTS,
  RPC_URL,
  hardhat,
  startHardhatNode,
  waitFor,
  sleep,
  loadFixture,
  createTestPublicClient,
  createTestWalletClient,
  createTestClientInstance,
  type HardhatNode,
} from "../../contracts/fixtures/helpers.ts";

import type { Address } from "viem";
import type { MakerConfig } from "../src/config.ts";
import { HARDHAT_ACCOUNTS, RPC_URL } from "../../contracts/fixtures/helpers.ts";
import { parseUnits } from "viem";

export function createMakerConfig(
  perpsAddress: Address,
  overrides: Partial<MakerConfig> = {},
): MakerConfig {
  return {
    network: "hardhat",
    ethNodeAddress: RPC_URL,
    perpsAddress,
    makerPrivateKey: HARDHAT_ACCOUNTS[3].privateKey,

    numLevelsPerSide: 3,
    baseQuantity: parseUnits("1", 6),
    minSpreadBps: 50,
    volatilityMultiplier: 0,
    inventorySkewGamma: 0.5,
    maxSkewTicks: 20,

    gasSpikeThresholdPct: 200,
    gasCapMultiplier: 5.0,
    gasPenaltyBps: 0,
    maxGasBudgetPerHourUsd: 999_000_000n,
    maxGasBudgetPerDayUsd: 9_999_000_000n,
    urgentRequoteThresholdTicks: 10,

    maxPositionSize: parseUnits("100", 6),
    maxUtilizationPct: 90,
    minCollateralBalance: 1n,
    maxDailyLossUsd: 999_000_000_000n,

    pollIntervalMs: 200,
    requoteThresholdTicks: 1,
    requoteCooldownMs: 0,
    resyncIntervalMs: 60_000,

    dryRun: false,
    healthPort: 0,
    logLevel: "silent",
    ...overrides,
  } as MakerConfig;
}
