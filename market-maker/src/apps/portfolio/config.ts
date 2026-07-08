import { type Static, type TSchema, Type } from "@sinclair/typebox";
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
  USD_DECIMALS,
} from "../../core/config/base.ts";
import { parseUsd, secondsToMs } from "../../core/config/units.ts";
import { perpsPricingSchema, perpsSizingSchema } from "../perps/config.ts";
import { futuresPricingSchema, futuresSizingSchema } from "../futures/config.ts";
import type { FuturesMarketSelection } from "../../adapters/futures/index.ts";
import { ConfigError } from "../../core/errors.ts";

/**
 * Unified portfolio app config.
 *
 * A single process runs one signer wallet against N markets across venues
 * (perps + all selected futures expiries). Collateral, gas, risk budget, and
 * loop timing are shared; each venue carries its own pricing/sizing and a
 * per-venue position cap. The futures venue additionally declares how many
 * expiries to quote (`marketSelection`).
 */
const Closed = { additionalProperties: false };

const TypeUsdAmount = (opts?: { default?: string | number; description?: string }) =>
  Type.Union([Type.String({ pattern: "^-?\\d+(\\.\\d+)?$" }), Type.Number()], opts);

const TypeSeconds = (opts?: { minimum?: number; default?: number; description?: string }) => {
  const { minimum, ...rest } = opts ?? {};
  return Type.Union(
    [Type.String({ pattern: "^\\d+(\\.\\d+)?$" }), Type.Number({ minimum })],
    rest as Record<string, unknown>,
  );
};

const marketSelectionSchema = Type.Union(
  [
    Type.Object(
      {
        // `count` is optional (defaulted to 1 in parseVenue). It can't carry a
        // schema `default` here: AJV skips defaults inside anyOf/oneOf branches
        // and, in strict mode, errors ("default is ignored for: …count").
        mode: Type.Literal("nearest"),
        count: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      Closed,
    ),
    Type.Object(
      {
        mode: Type.Literal("indices"),
        indices: Type.Array(Type.Integer({ minimum: 0 })),
      },
      Closed,
    ),
  ],
  {
    description:
      "Which futures expiries to quote: 'nearest' N dates, or explicit 'indices' into the nearest-first window.",
  },
);

const perpsVenueSchema = Type.Object(
  {
    kind: Type.Literal("perps"),
    address: TypeEthAddress({ description: "Deployed HashPowerPerpsDEX address." }),
    maxPositionSize: TypeUsdAmount({
      description: "USD. Per-venue net position cap for perps.",
    }),
    pricing: perpsPricingSchema,
    sizing: perpsSizingSchema,
  },
  { ...Closed, description: "Perps venue in the portfolio." },
);

const futuresVenueSchema = Type.Object(
  {
    kind: Type.Literal("futures"),
    address: TypeEthAddress({ description: "Deployed Futures address." }),
    maxPositionSize: TypeUsdAmount({
      description: "USD. Per-expiry net position cap for futures markets.",
    }),
    marketSelection: Type.Optional(marketSelectionSchema),
    pricing: futuresPricingSchema,
    sizing: futuresSizingSchema,
  },
  { ...Closed, description: "Futures venue (one market per selected expiry)." },
);

const txCoordinatorSchema = Type.Object(
  {
    maxCallsPerTx: Type.Integer({
      minimum: 1,
      default: 50,
      description: "Max encoded multicall entries per tx before chunking.",
    }),
    confirmationTimeoutSec: TypeSeconds({
      minimum: 1,
      default: 60,
      description: "Seconds to wait for a tx receipt before replacing by fee.",
    }),
    maxReplacements: Type.Integer({
      minimum: 0,
      default: 2,
      description: "Replacement-by-fee attempts before escalating to a cancel-tx.",
    }),
    replacementFeeBumpPct: Type.Number({
      minimum: 0,
      default: 15,
      description: "Fee bump per replacement attempt, percent.",
    }),
  },
  { ...Closed, default: {}, description: "Centralized submission / nonce recovery." },
);

const circuitBreakerSchema = Type.Object(
  {
    quarantineThreshold: Type.Integer({
      minimum: 1,
      default: 3,
      description: "Consecutive market errors before quarantine.",
    }),
    baseBackoffSec: TypeSeconds({
      minimum: 1,
      default: 5,
      description: "Base quarantine backoff (seconds).",
    }),
    maxBackoffSec: TypeSeconds({
      minimum: 1,
      default: 180,
      description: "Backoff ceiling (seconds).",
    }),
  },
  { ...Closed, default: {}, description: "Per-market circuit-breaker tuning." },
);

export const portfolioRootSchema = Type.Object(
  {
    nodeEnv: Type.String({ default: "development" }),
    commitHash: Type.String({ default: "unknown" }),
    logLevel: Type.String({ default: "info" }),
    dryRun: Type.Boolean({ default: false }),
    cancelOrdersOnShutdown: Type.Boolean({ default: true }),
    wallets: Type.Record(Type.String(), walletSchema, {
      description: "Named signer wallets; `wallet` selects the portfolio signer.",
    }),
    wallet: Type.String({
      description:
        "Key in `wallets` for the single shared signer. All venues submit through this one account/nonce.",
    }),
    network: networkSchema,
    venues: Type.Array(Type.Union([perpsVenueSchema, futuresVenueSchema]), {
      minItems: 1,
      description: "Venues to run in this process (perps and/or futures).",
    }),
    risk: riskSchema,
    gas: gasSchema,
    collateral: collateralSchema,
    oracle: oracleSchema,
    timing: timingSchema,
    health: healthSchema,
    txCoordinator: Type.Optional(txCoordinatorSchema),
    circuitBreaker: Type.Optional(circuitBreakerSchema),
    rollCheckIntervalSec: TypeSeconds({
      minimum: 1,
      default: 300,
      description: "Seconds between futures roll re-checks (add/drop expiries).",
    }),
    sharedStalenessGraceSec: TypeSeconds({
      minimum: 0,
      default: 30,
      description:
        "Seconds shared inputs may be stale before new placements are paused (existing orders kept).",
    }),
    readBatchSize: Type.Number({ minimum: 1, default: 10 }),
    writeBatchSize: Type.Number({ minimum: 1, default: 20 }),
  },
  { ...Closed, description: "Titan Market Maker — unified portfolio app config." },
);

/**
 * AJV (strict mode) rejects a `default` that sits inside an `anyOf`/`oneOf`
 * branch because it can't decide which branch applies before validating, so
 * the default would be silently ignored. The reused perps/futures pricing
 * schemas legitimately carry defaults (e.g. futures `maxSkewTicks`), but once
 * they're nested in the `venues` union those defaults become "ignored". We
 * keep `portfolioRootSchema` (with defaults) for type inference + editor JSON
 * schema, and validate against a clone with combinator-nested defaults removed.
 */
function stripCombinatorDefaults(schema: TSchema): TSchema {
  const COMBINATORS = new Set(["anyOf", "oneOf", "allOf", "if", "then", "else"]);
  const clone = structuredClone(schema) as unknown;
  const walk = (node: unknown, inCombinator: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, inCombinator);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (inCombinator && "default" in obj) delete obj.default;
    for (const [key, value] of Object.entries(obj)) {
      walk(value, inCombinator || COMBINATORS.has(key));
    }
  };
  walk(clone, false);
  return clone as TSchema;
}

const portfolioValidationSchema = stripCombinatorDefaults(portfolioRootSchema);

type RawPortfolioConfig = Static<typeof portfolioRootSchema>;
type RawVenue = RawPortfolioConfig["venues"][number];
type RawPerpsVenue = Extract<RawVenue, { kind: "perps" }>;
type RawFuturesVenue = Extract<RawVenue, { kind: "futures" }>;

export interface ParsedPerpsVenue {
  kind: "perps";
  address: `0x${string}`;
  maxPositionSize: bigint;
  pricing: RawPerpsVenue["pricing"];
  sizing: Omit<RawPerpsVenue["sizing"], "baseQuantity"> & { baseQuantity: bigint };
}

export interface ParsedFuturesVenue {
  kind: "futures";
  address: `0x${string}`;
  maxPositionSize: bigint;
  marketSelection: FuturesMarketSelection;
  pricing: RawFuturesVenue["pricing"];
  sizing: Omit<RawFuturesVenue["sizing"], "baseQuantity"> & { baseQuantity: bigint };
}

export type ParsedVenue = ParsedPerpsVenue | ParsedFuturesVenue;

export interface ParsedTxCoordinatorConfig {
  maxCallsPerTx: number;
  confirmationTimeoutMs: number;
  maxReplacements: number;
  replacementFeeBumpPct: number;
}

export interface ParsedCircuitBreakerConfig {
  quarantineThreshold: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export type PortfolioMakerConfig = Omit<
  RawPortfolioConfig,
  "risk" | "timing" | "collateral" | "oracle" | "venues" | "txCoordinator" | "circuitBreaker" | "rollCheckIntervalSec" | "sharedStalenessGraceSec"
> & {
  risk: ParsedRiskConfig;
  timing: ParsedTimingConfig;
  collateral: ParsedCollateralConfig;
  oracle: ParsedOracleConfig;
  venues: ParsedVenue[];
  txCoordinator: ParsedTxCoordinatorConfig;
  circuitBreaker: ParsedCircuitBreakerConfig;
  rollCheckIntervalMs: number;
  sharedStalenessGraceMs: number;
};

function parseMarketSelection(raw: RawFuturesVenue["marketSelection"]): FuturesMarketSelection {
  if (!raw) return { mode: "nearest", count: 1 };
  if (raw.mode === "nearest") return { mode: "nearest", count: raw.count ?? 1 };
  return { mode: "indices", indices: raw.indices };
}

function parseVenue(raw: RawVenue): ParsedVenue {
  if (raw.kind === "perps") {
    return {
      kind: "perps",
      address: raw.address,
      maxPositionSize: parseUsd(raw.maxPositionSize, USD_DECIMALS, "venue.maxPositionSize"),
      pricing: raw.pricing,
      sizing: {
        ...raw.sizing,
        baseQuantity: configBigint(String(raw.sizing.baseQuantity), "venue.sizing.baseQuantity"),
      },
    };
  }
  return {
    kind: "futures",
    address: raw.address,
    maxPositionSize: parseUsd(raw.maxPositionSize, USD_DECIMALS, "venue.maxPositionSize"),
    marketSelection: parseMarketSelection(raw.marketSelection),
    pricing: raw.pricing,
    sizing: {
      ...raw.sizing,
      baseQuantity: configBigint(String(raw.sizing.baseQuantity), "venue.sizing.baseQuantity"),
    },
  };
}

export function loadPortfolioConfig(
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): PortfolioMakerConfig {
  return loadConfigFromFile<PortfolioMakerConfig, RawPortfolioConfig>({
    schema: portfolioValidationSchema,
    path: opts.path,
    env: opts.env,
    parse: (raw) => {
      const tx = raw.txCoordinator ?? {
        maxCallsPerTx: 50,
        confirmationTimeoutSec: 60,
        maxReplacements: 2,
        replacementFeeBumpPct: 15,
      };
      const cb = raw.circuitBreaker ?? {
        quarantineThreshold: 3,
        baseBackoffSec: 5,
        maxBackoffSec: 180,
      };
      return {
        ...raw,
        risk: parseRiskConfig(raw.risk),
        timing: parseTimingConfig(raw.timing),
        collateral: parseCollateralConfig(raw.collateral),
        oracle: parseOracleConfig(raw.oracle),
        venues: raw.venues.map(parseVenue),
        txCoordinator: {
          maxCallsPerTx: tx.maxCallsPerTx,
          confirmationTimeoutMs: secondsToMs(tx.confirmationTimeoutSec, "txCoordinator.confirmationTimeoutSec"),
          maxReplacements: tx.maxReplacements,
          replacementFeeBumpPct: tx.replacementFeeBumpPct,
        },
        circuitBreaker: {
          quarantineThreshold: cb.quarantineThreshold,
          baseBackoffMs: secondsToMs(cb.baseBackoffSec, "circuitBreaker.baseBackoffSec"),
          maxBackoffMs: secondsToMs(cb.maxBackoffSec, "circuitBreaker.maxBackoffSec"),
        },
        rollCheckIntervalMs: secondsToMs(raw.rollCheckIntervalSec, "rollCheckIntervalSec"),
        sharedStalenessGraceMs: secondsToMs(raw.sharedStalenessGraceSec, "sharedStalenessGraceSec"),
      };
    },
    validate: (cfg) => {
      if (!cfg.wallets[cfg.wallet]) {
        throw new ConfigError(`wallet "${cfg.wallet}" not in wallets map`);
      }
      const kinds = cfg.venues.map((v) => v.kind);
      if (new Set(kinds).size !== kinds.length) {
        throw new ConfigError("duplicate venue kind; declare at most one perps and one futures venue");
      }
    },
  });
}
