import { type Static, Type } from "@sinclair/typebox";
import {
  TypeEthAddress,
  collateralSchema,
  gasSchema,
  healthSchema,
  loadConfigFromFile,
  networkSchema,
  riskSchema,
  timingSchema,
  walletSchema,
} from "../../core/config/base.ts";
import { ConfigError } from "../../core/errors.ts";

/**
 * Perps app config schema.
 *
 * Pricing locked to "effective-spread" (symmetric, limit-matched) — that's
 * the strategy that fits the perps order book. Sizing locked to "linear"
 * for the same reason: deeper levels are larger because they only fill
 * after the shallower ones do.
 *
 * No runtime ternaries — the schema demands the right shape, the loader
 * rejects mismatches, and the Quoter / Executor read the static values.
 */
const Closed = { additionalProperties: false };

const perpsVenueSchema = Type.Object(
  {
    kind: Type.Literal("perps"),
    address: TypeEthAddress(),
    wallet: Type.String(),
  },
  Closed,
);

const perpsPricingSchema = Type.Object(
  {
    strategy: Type.Literal("effective-spread"),
    minSpreadBps: Type.Number({ minimum: 0 }),
    volatilityMultiplier: Type.Number({ minimum: 0 }),
    inventorySkewGamma: Type.Number({ minimum: 0 }),
    maxSkewTicks: Type.Number({ minimum: 0 }),
  },
  Closed,
);

const perpsSizingSchema = Type.Object(
  {
    strategy: Type.Literal("linear"),
    baseQuantity: Type.String(),
    numLevelsPerSide: Type.Number({ minimum: 1 }),
  },
  Closed,
);

export const perpsRootSchema = Type.Object(
  {
    nodeEnv: Type.String({ default: "development" }),
    commitHash: Type.String({ default: "unknown" }),
    logLevel: Type.String({ default: "info" }),
    dryRun: Type.Boolean({ default: false }),
    wallets: Type.Record(Type.String(), walletSchema),
    network: networkSchema,
    venue: perpsVenueSchema,
    pricing: perpsPricingSchema,
    sizing: perpsSizingSchema,
    risk: riskSchema,
    gas: gasSchema,
    collateral: collateralSchema,
    timing: timingSchema,
    health: healthSchema,
  },
  Closed,
);

export type PerpsMakerConfig = Static<typeof perpsRootSchema>;

export function loadPerpsConfig(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): PerpsMakerConfig {
  return loadConfigFromFile<PerpsMakerConfig>({
    schema: perpsRootSchema,
    path: opts.path,
    env: opts.env,
    validate: (cfg) => {
      if (!cfg.wallets[cfg.venue.wallet]) {
        throw new ConfigError(`venue.wallet "${cfg.venue.wallet}" not in wallets map`);
      }
    },
  });
}
