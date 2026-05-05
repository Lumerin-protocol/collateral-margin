import { type Static, Type } from "@sinclair/typebox";
import {
  type ParsedCollateralConfig,
  type ParsedRiskConfig,
  type ParsedTimingConfig,
  TypeEthAddress,
  collateralSchema,
  configBigint,
  gasSchema,
  healthSchema,
  loadConfigFromFile,
  networkSchema,
  parseCollateralConfig,
  parseRiskConfig,
  parseTimingConfig,
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
    kind: Type.Literal("futures", {
      description: "Venue type — must be 'futures' for the Futures contract.",
    }),
    address: TypeEthAddress({ description: "Deployed Futures contract address." }),
    wallet: Type.String({
      description: "Key in the top-level `wallets` map identifying the signer for this venue.",
    }),
  },
  { ...Closed, description: "Futures venue identification and signer selection." },
);

const futuresPricingSchema = Type.Object(
  {
    strategy: Type.Literal("reservation-price", {
      description:
        "Pricing strategy. Futures lock to 'reservation-price' (Avellaneda–Stoikov inventory skew).",
    }),
    riskAversion: Type.Number({
      minimum: 0,
      description: "Avellaneda–Stoikov risk aversion γ. Higher = stronger inventory skew.",
    }),
    marginCallTimeSec: Type.Number({
      minimum: 0,
      description:
        "Seconds. Fallback time-to-margin-call when InstrumentContext.deliveryDate is unavailable.",
    }),
    minSpreadBps: Type.Number({
      minimum: 0,
      description: "Floor on the half-spread in bps. Quotes never tighten below this.",
    }),
    volatilityMultiplier: Type.Number({
      minimum: 0,
      description: "Multiplier applied to realized volatility when widening the spread.",
    }),
    maxSkewTicks: Type.Number({
      const: 0,
      default: 0,
      description: "Pinned to 0 — under reservation-price the skew is encoded in r itself.",
    }),
  },
  { ...Closed, description: "Reservation-price pricing parameters." },
);

// `baseQuantity` is venue-native (futures: contract base units). Bigint
// expressed as a decimal string; numbers accepted but use strings if values
// exceed Number.MAX_SAFE_INTEGER.
const futuresSizingSchema = Type.Object(
  {
    strategy: Type.Literal("geometric-taper", {
      description:
        "Sizing strategy. Futures lock to 'geometric-taper' (front level largest, decays by taperRatio).",
    }),
    baseQuantity: Type.Union(
      [Type.String({ pattern: "^\\d+$" }), Type.Number()],
      {
        description:
          "Total per-side budget in venue-native units (futures: contract base units). Distributed via taperRatio. Use a string for values > 2^53.",
      },
    ),
    numLevelsPerSide: Type.Number({
      minimum: 1,
      description: "Number of price levels quoted per side.",
    }),
    taperRatio: Type.Number({
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
      description: "Geometric decay ratio in (0, 1). Each subsequent level is taperRatio × the previous.",
    }),
  },
  { ...Closed, description: "Geometric-taper sizing parameters." },
);

export const futuresRootSchema = Type.Object(
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
    venue: futuresVenueSchema,
    pricing: futuresPricingSchema,
    sizing: futuresSizingSchema,
    risk: riskSchema,
    gas: gasSchema,
    collateral: collateralSchema,
    timing: timingSchema,
    health: healthSchema,
  },
  { ...Closed, description: "Titan Market Maker — Futures app config." },
);

type RawFuturesConfig = Static<typeof futuresRootSchema>;

/** Parsed futures config: bigints/ms substituted in for human-friendly inputs. */
export type FuturesMakerConfig = Omit<RawFuturesConfig, "risk" | "timing" | "collateral" | "sizing"> & {
  risk: ParsedRiskConfig;
  timing: ParsedTimingConfig;
  collateral: ParsedCollateralConfig;
  sizing: Omit<RawFuturesConfig["sizing"], "baseQuantity"> & { baseQuantity: bigint };
};

export function loadFuturesConfig(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): FuturesMakerConfig {
  return loadConfigFromFile<FuturesMakerConfig, RawFuturesConfig>({
    schema: futuresRootSchema,
    path: opts.path,
    env: opts.env,
    parse: (raw) => ({
      ...raw,
      risk: parseRiskConfig(raw.risk),
      timing: parseTimingConfig(raw.timing),
      collateral: parseCollateralConfig(raw.collateral),
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
