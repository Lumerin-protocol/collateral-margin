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
 * Futures app config schema.
 *
 * Pricing locked to "reservation-price" (Avellaneda–Stoikov) — that's the
 * strategy that fits exact-match futures: the inventory shift on r is more
 * useful than a symmetric spread because price levels are non-fungible
 * (each is a separate fill opportunity).
 *
 * Sizing locked to "geometric-taper" so the front level (highest fill prob)
 * is the largest. taperRatio in (0, 1) is required.
 */
const Closed = { additionalProperties: false };

const futuresVenueSchema = Type.Object(
  {
    kind: Type.Literal("futures"),
    address: TypeEthAddress(),
    wallet: Type.String(),
  },
  Closed,
);

const futuresPricingSchema = Type.Object(
  {
    strategy: Type.Literal("reservation-price"),
    /** Avellaneda–Stoikov risk aversion γ. */
    riskAversion: Type.Number({ minimum: 0 }),
    /** Fallback remaining time (seconds) when InstrumentContext.deliveryDate is unavailable. */
    marginCallTimeSeconds: Type.Number({ minimum: 0 }),
    minSpreadBps: Type.Number({ minimum: 0 }),
    volatilityMultiplier: Type.Number({ minimum: 0 }),
    /** maxSkewTicks is unused under reservation-price (skew is in the formula); pinned at 0. */
    maxSkewTicks: Type.Number({ const: 0, default: 0 }),
  },
  Closed,
);

const futuresSizingSchema = Type.Object(
  {
    strategy: Type.Literal("geometric-taper"),
    /** Total per-side budget in token base units. */
    baseQuantity: Type.String(),
    numLevelsPerSide: Type.Number({ minimum: 1 }),
    taperRatio: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  },
  Closed,
);

export const futuresRootSchema = Type.Object(
  {
    nodeEnv: Type.String({ default: "development" }),
    commitHash: Type.String({ default: "unknown" }),
    logLevel: Type.String({ default: "info" }),
    dryRun: Type.Boolean({ default: false }),
    wallets: Type.Record(Type.String(), walletSchema),
    network: networkSchema,
    venue: futuresVenueSchema,
    pricing: futuresPricingSchema,
    sizing: futuresSizingSchema,
    risk: riskSchema,
    gas: gasSchema,
    collateral: collateralSchema,
    timing: timingSchema,
    health: healthSchema,
  },
  Closed,
);

export type FuturesMakerConfig = Static<typeof futuresRootSchema>;

export function loadFuturesConfig(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): FuturesMakerConfig {
  return loadConfigFromFile<FuturesMakerConfig>({
    schema: futuresRootSchema,
    path: opts.path,
    env: opts.env,
    validate: (cfg) => {
      if (!cfg.wallets[cfg.venue.wallet]) {
        throw new ConfigError(`venue.wallet "${cfg.venue.wallet}" not in wallets map`);
      }
    },
  });
}
