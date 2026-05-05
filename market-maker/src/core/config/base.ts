import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { type StringOptions, type TUnsafe, type TSchema, Type } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ConfigError } from "../errors.ts";
import { parseUsd, secondsToMs } from "./units.ts";

/** USDC base unit decimals — every USD-denominated config field uses this. */
export const USD_DECIMALS = 6;

/** Schema fragment that accepts a decimal string or number for a USD value. */
const TypeUsdAmount = (opts?: { default?: string | number; description?: string }) =>
  Type.Union(
    [Type.String({ pattern: "^-?\\d+(\\.\\d+)?$" }), Type.Number()],
    opts as Record<string, unknown> | undefined,
  );

/** Schema fragment that accepts a non-negative seconds value (string or number). */
const TypeSeconds = (opts?: { minimum?: number; default?: string | number; description?: string }) => {
  const { minimum, ...unionOpts } = opts ?? {};
  return Type.Union(
    [Type.String({ pattern: "^\\d+(\\.\\d+)?$" }), Type.Number({ minimum })],
    unionOpts as Record<string, unknown>,
  );
};

/**
 * Shared config schema fragments used by per-app config modules.
 *
 * The architecture is deliberate: each MM app (perps, futures) builds a
 * completely-typed schema from these fragments at compile time. Runtime
 * validation rejects configs that don't match the *app's* schema, so we never
 * hit "is this `riskAversion` defined?" branches in core code.
 */

export const TypeEthAddress = (opt?: StringOptions) =>
  Type.String({ ...opt, pattern: "^0x[a-fA-F0-9]{40}$" }) as TUnsafe<`0x${string}`>;

export const TypeHex = (opt?: StringOptions) =>
  Type.String({ ...opt, pattern: "^0x[a-fA-F0-9]+$" }) as TUnsafe<`0x${string}`>;

// Every object below is sealed (`additionalProperties: false`) so AJV rejects
// unknown keys at runtime and the YAML language server flags typos at edit
// time. New fields must be declared explicitly in the schema.
const Closed = { additionalProperties: false };

export const walletSchema = Type.Object(
  {
    privateKey: TypeHex({ description: "Hex-encoded ECDSA private key for the signer." }),
  },
  { ...Closed, description: "Named signer wallet. Referenced by venue.wallet." },
);

export const networkSchema = Type.Object(
  {
    name: Type.String({
      description: "Chain id (hardhat, base-sepolia, base, arbitrum). Resolves the viem chain object.",
    }),
    rpcUrl: Type.String({ description: "JSON-RPC endpoint URL for reads and tx submission." }),
    // ethPriceFeed accepts an empty string for "absent" so the YAML
    // `${ETH_PRICE_FEED_ADDRESS:-}` pattern works without a real value.
    // Adapters treat empty as `undefined`.
    ethPriceFeed: Type.Optional(
      Type.Union([Type.Literal(""), TypeEthAddress()], {
        description:
          "Optional Chainlink ETH/USD aggregator. Required for USD-denominated gas budgets; leave empty for local hardhat.",
      }),
    ),
  },
  { ...Closed, description: "Network connection settings." },
);

// All *Usd fields are decimal USD (e.g. "50" = 50 USDC, "0.5" = 0.5 USDC).
// They get parsed into 6-decimal bigints at load time. Decimal strings
// preserve precision; numeric literals are accepted for convenience but
// avoid them for sub-cent values where float rounding matters.
export const riskSchema = Type.Object(
  {
    maxPositionSize: TypeUsdAmount({
      description:
        "USD. Hard cap on |net position notional|. Beyond this, only risk-reducing quotes are placed.",
    }),
    maxUtilizationPct: Type.Number({
      minimum: 0,
      maximum: 100,
      default: 80,
      description:
        "Margin utilization (used IM / vault balance) above which only risk-reducing quotes are placed.",
    }),
    minCollateralBalance: TypeUsdAmount({
      description: "USD. Operational floor; halts quoting when vault balance falls below this.",
    }),
    maxDailyLossUsd: TypeUsdAmount({
      description:
        "USD. Daily PnL circuit-breaker. Halts quoting when realized loss + gas exceeds this since 00:00 UTC.",
    }),
    maxGasBudgetPerHourUsd: TypeUsdAmount({
      default: 50,
      description:
        "USD. Soft throttle: when hourly gas spend exceeds this, requote cooldown triples.",
    }),
    maxGasBudgetPerDayUsd: TypeUsdAmount({
      default: 500,
      description: "USD. Hard halt: stops requoting once daily gas spend exceeds this.",
    }),
    gasSpikeThresholdPct: Type.Number({
      default: 200,
      description:
        "Percent of baseline. Quotes pause when current gas price exceeds (baseline × pct/100).",
    }),
    gasPenaltyBps: Type.Number({
      default: 5,
      description:
        "Bps to widen spreads by per unit of gas-cost-as-fraction-of-notional (compensates for fill economics).",
    }),
    urgentRequoteThresholdTicks: Type.Number({
      default: 10,
      description:
        "Tick distance from oracle at which a stale order is requoted immediately, ignoring cooldown.",
    }),
  },
  { ...Closed, description: "Risk caps, circuit-breakers, and gas-price guards." },
);

export const gasSchema = Type.Object(
  {
    gasCapMultiplier: Type.Number({
      default: 2.0,
      description:
        "Multiplier on viem-suggested gas price for the maxFeePerGas cap. Higher = more reliable inclusion at higher cost.",
    }),
  },
  { ...Closed, description: "Gas-pricing knobs." },
);

// `*Sec` fields are seconds (decimal). The loader converts to integer
// milliseconds with up to 3-digit precision. e.g. "0.5" → 500ms, "60" → 60000ms.
export const timingSchema = Type.Object(
  {
    pollIntervalSec: TypeSeconds({
      minimum: 0.1,
      default: 3,
      description: "Seconds between main-loop iterations (snapshot, quote, execute).",
    }),
    requoteThresholdTicks: Type.Number({
      minimum: 0,
      default: 2,
      description: "Tick deviation from current target before a resting order is replaced.",
    }),
    requoteCooldownSec: TypeSeconds({
      minimum: 0,
      default: 1,
      description: "Seconds between requote bursts. Tripled when risk is throttled.",
    }),
    resyncIntervalSec: TypeSeconds({
      minimum: 1,
      default: 60,
      description: "Seconds between full BookTracker snapshot refetches (event deltas in between).",
    }),
    levelSpacingTicks: Type.Number({
      minimum: 1,
      default: 1,
      description: "Ticks between successive quote levels. 1 = quote every tick, 5 = every fifth.",
    }),
  },
  { ...Closed, description: "Loop cadences and requote thresholds." },
);

export const collateralSchema = Type.Object(
  {
    autoDeposit: Type.Boolean({
      default: false,
      description:
        "If true, sweeps wallet token balance into the vault on each loop iteration (subject to min/max).",
    }),
    autoDepositMinAmount: TypeUsdAmount({
      default: 0,
      description:
        "USD. Trigger threshold: deposit fires only when wallet balance ≥ this. Dust filter to avoid wasting gas on tiny sweeps.",
    }),
    maxCollateralAmount: Type.Optional(
      Type.Union(
        [Type.String({ pattern: "^-?\\d+(\\.\\d+)?$" }), Type.Number()],
        {
          description:
            "USD. Optional ceiling on the total vault balance held by this MM. Each auto-deposit brings the vault up to (but not above) this value; the wallet retains anything beyond it. Omit for no ceiling.",
        },
      ),
    ),
  },
  { ...Closed, description: "Collateral vault behaviour." },
);

export const healthSchema = Type.Object(
  {
    port: Type.Number({
      minimum: 0,
      default: 3001,
      description: "TCP port for the /healthz HTTP endpoint.",
    }),
  },
  { ...Closed, description: "Health-check HTTP server." },
);

/**
 * ${VAR} expansion. Recursively walks strings in the parsed YAML and replaces
 * ${NAME} with process.env.NAME. The `${NAME:-default}` form supplies a
 * fallback when the variable is unset.
 */
export function expandEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, def) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (def !== undefined) return def;
      throw new ConfigError(`Environment variable "${name}" is not set`);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnv(v, env));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnv(v, env);
    }
    return out;
  }
  return value;
}

/**
 * Parsed shapes of the shared sub-configs after unit conversion.
 * The schemas accept user-friendly inputs (decimal USD strings, seconds);
 * the loader transforms those into the bigint/ms forms core code consumes.
 */
export interface ParsedRiskConfig {
  maxPositionSize: bigint;
  maxUtilizationPct: number;
  minCollateralBalance: bigint;
  maxDailyLossUsd: bigint;
  maxGasBudgetPerHourUsd: bigint;
  maxGasBudgetPerDayUsd: bigint;
  gasSpikeThresholdPct: number;
  gasPenaltyBps: number;
  urgentRequoteThresholdTicks: number;
}

export interface ParsedTimingConfig {
  pollIntervalMs: number;
  requoteThresholdTicks: number;
  requoteCooldownMs: number;
  resyncIntervalMs: number;
  levelSpacingTicks: number;
}

export interface ParsedCollateralConfig {
  autoDeposit: boolean;
  autoDepositMinAmount: bigint;
  /**
   * Optional ceiling on the total vault balance. Each top-up deposits at most
   * `max(0, maxCollateralAmount − vaultBalance)`. Undefined → no ceiling.
   */
  maxCollateralAmount?: bigint;
}

interface RawRisk {
  maxPositionSize: string | number;
  maxUtilizationPct: number;
  minCollateralBalance: string | number;
  maxDailyLossUsd: string | number;
  maxGasBudgetPerHourUsd: string | number;
  maxGasBudgetPerDayUsd: string | number;
  gasSpikeThresholdPct: number;
  gasPenaltyBps: number;
  urgentRequoteThresholdTicks: number;
}
interface RawTiming {
  pollIntervalSec: string | number;
  requoteThresholdTicks: number;
  requoteCooldownSec: string | number;
  resyncIntervalSec: string | number;
  levelSpacingTicks: number;
}
interface RawCollateral {
  autoDeposit: boolean;
  autoDepositMinAmount: string | number;
  maxCollateralAmount?: string | number;
}

export function parseRiskConfig(raw: RawRisk): ParsedRiskConfig {
  return {
    maxPositionSize: parseUsd(raw.maxPositionSize, USD_DECIMALS, "risk.maxPositionSize"),
    maxUtilizationPct: raw.maxUtilizationPct,
    minCollateralBalance: parseUsd(raw.minCollateralBalance, USD_DECIMALS, "risk.minCollateralBalance"),
    maxDailyLossUsd: parseUsd(raw.maxDailyLossUsd, USD_DECIMALS, "risk.maxDailyLossUsd"),
    maxGasBudgetPerHourUsd: parseUsd(
      raw.maxGasBudgetPerHourUsd,
      USD_DECIMALS,
      "risk.maxGasBudgetPerHourUsd",
    ),
    maxGasBudgetPerDayUsd: parseUsd(
      raw.maxGasBudgetPerDayUsd,
      USD_DECIMALS,
      "risk.maxGasBudgetPerDayUsd",
    ),
    gasSpikeThresholdPct: raw.gasSpikeThresholdPct,
    gasPenaltyBps: raw.gasPenaltyBps,
    urgentRequoteThresholdTicks: raw.urgentRequoteThresholdTicks,
  };
}

export function parseTimingConfig(raw: RawTiming): ParsedTimingConfig {
  return {
    pollIntervalMs: secondsToMs(raw.pollIntervalSec, "timing.pollIntervalSec"),
    requoteThresholdTicks: raw.requoteThresholdTicks,
    requoteCooldownMs: secondsToMs(raw.requoteCooldownSec, "timing.requoteCooldownSec"),
    resyncIntervalMs: secondsToMs(raw.resyncIntervalSec, "timing.resyncIntervalSec"),
    levelSpacingTicks: raw.levelSpacingTicks,
  };
}

export function parseCollateralConfig(raw: RawCollateral): ParsedCollateralConfig {
  return {
    autoDeposit: raw.autoDeposit,
    autoDepositMinAmount: parseUsd(
      raw.autoDepositMinAmount,
      USD_DECIMALS,
      "collateral.autoDepositMinAmount",
    ),
    maxCollateralAmount:
      raw.maxCollateralAmount !== undefined
        ? parseUsd(raw.maxCollateralAmount, USD_DECIMALS, "collateral.maxCollateralAmount")
        : undefined,
  };
}

export interface LoadConfigOpts<TParsed, TRaw = unknown> {
  schema: TSchema;
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** Transform the AJV-validated raw object into the typed parsed config. */
  parse: (raw: TRaw) => TParsed;
  /** App-specific cross-field validation on the parsed config. */
  validate?: (cfg: TParsed) => void;
}

export function loadConfigFromFile<TParsed, TRaw = unknown>(
  opts: LoadConfigOpts<TParsed, TRaw>,
): TParsed {
  const env = opts.env ?? process.env;
  // Precedence: explicit opts.path > --config CLI arg > MAKER_CONFIG env var.
  const configPath = opts.path ?? parseConfigArg(process.argv) ?? env.MAKER_CONFIG;
  if (!configPath) {
    throw new ConfigError(
      "No config path provided. Pass --config <path> or set MAKER_CONFIG env var.",
    );
  }
  const abs = resolve(process.cwd(), configPath);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    throw new ConfigError(`Failed to read config at ${abs}: ${(err as Error).message}`);
  }

  const parsed = yaml.load(raw);
  const expanded = expandEnv(parsed, env);

  // `coerceTypes` lets env-interpolated strings ("false", "3001") satisfy
  // boolean / number schema slots. Typos in field names still fail validation.
  const ajv = new Ajv.default({ allErrors: true, useDefaults: true, coerceTypes: true });
  addFormats.default(ajv);
  const validate = ajv.compile(opts.schema);
  if (!validate(expanded)) {
    const msgs = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`)
      .join("; ");
    throw new ConfigError(`Config validation failed: ${msgs}`);
  }

  const cfg = opts.parse(expanded as TRaw);
  opts.validate?.(cfg);
  return cfg;
}

function parseConfigArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith("--config=")) return argv[i].slice("--config=".length);
  }
  return undefined;
}

/** Parse a bigint-as-string value, throwing ConfigError on failure. */
export function configBigint(value: string, field: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new ConfigError(`Invalid bigint value for ${field}: "${value}"`);
  }
}
