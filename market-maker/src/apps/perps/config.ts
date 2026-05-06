import { type Static, Type } from "@sinclair/typebox";
import {
  type ParsedCollateralConfig,
  type ParsedOracleConfig,
  type ParsedRiskConfig,
  type ParsedTimingConfig,
  TypeEthAddress,
  collateralSchema,
  configBigint,
  gasSchema,
  healthSchema,
  loadConfigFromFile,
  networkSchema,
  oracleSchema,
  parseCollateralConfig,
  parseOracleConfig,
  parseRiskConfig,
  parseTimingConfig,
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
    kind: Type.Literal("perps", { description: "Venue type — must be 'perps' for HashPowerPerpsDEX." }),
    address: TypeEthAddress({ description: "Deployed HashPowerPerpsDEX contract address." }),
    wallet: Type.String({
      description: "Key in the top-level `wallets` map identifying the signer for this venue.",
    }),
  },
  { ...Closed, description: "Perps venue identification and signer selection." },
);

const perpsPricingSchema = Type.Object(
  {
    strategy: Type.Literal("effective-spread", {
      description: "Pricing strategy. Perps lock to 'effective-spread' (symmetric mid-spread).",
    }),
    minSpreadBps: Type.Number({
      minimum: 0,
      description: "Floor on the half-spread in bps. Quotes never tighten below this.",
    }),
    volatilityMultiplier: Type.Number({
      minimum: 0,
      description: "Multiplier applied to realized volatility when widening the spread.",
    }),
    inventorySkewGamma: Type.Number({
      minimum: 0,
      description:
        "Inventory skew coefficient. Quotes shift by γ × (netPos / maxPos) ticks toward unwinding.",
    }),
    maxSkewTicks: Type.Number({
      minimum: 0,
      description: "Cap on absolute ticks a level can be skewed from the symmetric mid.",
    }),
  },
  { ...Closed, description: "Effective-spread pricing parameters." },
);

// `baseQuantity` is venue-native (perps: hashrate base units). It's a bigint
// expressed as a decimal string; numbers are accepted but use strings if
// values exceed Number.MAX_SAFE_INTEGER.
const perpsSizingSchema = Type.Object(
  {
    strategy: Type.Literal("linear", {
      description: "Sizing strategy. Perps lock to 'linear' (level k receives (k+1) × baseQuantity).",
    }),
    baseQuantity: Type.Union(
      [Type.String({ pattern: "^\\d+$" }), Type.Number()],
      {
        description:
          "Per-level base size in venue-native units (perps: hashrate base units). Use a string for values > 2^53.",
      },
    ),
    numLevelsPerSide: Type.Number({
      minimum: 1,
      description: "Number of price levels quoted per side.",
    }),
  },
  { ...Closed, description: "Linear-ladder sizing parameters." },
);

export const perpsRootSchema = Type.Object(
  {
    nodeEnv: Type.String({
      default: "development",
      description: "Environment label (development/staging/production). Used for log enrichment only.",
    }),
    commitHash: Type.String({
      default: "unknown",
      description: "Build-time commit SHA; surfaced via /healthz for ops correlation.",
    }),
    logLevel: Type.String({
      default: "info",
      description: "Pino log level (trace/debug/info/warn/error/fatal).",
    }),
    dryRun: Type.Boolean({
      default: false,
      description: "If true, all order writes are skipped — quotes are computed but not submitted.",
    }),
    cancelOrdersOnShutdown: Type.Boolean({
      default: true,
      description:
        "If true (default), SIGINT/SIGTERM trigger executor.cancelAll() before exit. Set false to leave resting orders on the book on exit (useful for restarts).",
    }),
    wallets: Type.Record(Type.String(), walletSchema, {
      description: "Map of named signer wallets; venue.wallet selects which one signs.",
    }),
    network: networkSchema,
    venue: perpsVenueSchema,
    pricing: perpsPricingSchema,
    sizing: perpsSizingSchema,
    risk: riskSchema,
    gas: gasSchema,
    collateral: collateralSchema,
    oracle: oracleSchema,
    timing: timingSchema,
    health: healthSchema,
  },
  { ...Closed, description: "Titan Market Maker — Perps app config." },
);

type RawPerpsConfig = Static<typeof perpsRootSchema>;

/** Parsed perps config: bigints/ms substituted in for human-friendly inputs. */
export type PerpsMakerConfig = Omit<
  RawPerpsConfig,
  "risk" | "timing" | "collateral" | "sizing" | "oracle"
> & {
  risk: ParsedRiskConfig;
  timing: ParsedTimingConfig;
  collateral: ParsedCollateralConfig;
  oracle: ParsedOracleConfig;
  sizing: Omit<RawPerpsConfig["sizing"], "baseQuantity"> & { baseQuantity: bigint };
};

export function loadPerpsConfig(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): PerpsMakerConfig {
  return loadConfigFromFile<PerpsMakerConfig, RawPerpsConfig>({
    schema: perpsRootSchema,
    path: opts.path,
    env: opts.env,
    parse: (raw) => ({
      ...raw,
      risk: parseRiskConfig(raw.risk),
      timing: parseTimingConfig(raw.timing),
      collateral: parseCollateralConfig(raw.collateral),
      oracle: parseOracleConfig(raw.oracle),
      sizing: {
        ...raw.sizing,
        baseQuantity: configBigint(String(raw.sizing.baseQuantity), "sizing.baseQuantity"),
      },
    }),
    validate: (cfg) => {
      if (!cfg.wallets[cfg.venue.wallet]) {
        throw new ConfigError(`venue.wallet "${cfg.venue.wallet}" not in wallets map`);
      }
    },
  });
}
