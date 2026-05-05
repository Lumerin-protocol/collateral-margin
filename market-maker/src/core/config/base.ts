import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { type StringOptions, type TUnsafe, type TSchema, Type } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ConfigError } from "../errors.ts";

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
    privateKey: TypeHex(),
  },
  Closed,
);

export const networkSchema = Type.Object(
  {
    name: Type.String(),
    rpcUrl: Type.String(),
    // ethPriceFeed accepts an empty string for "absent" so the YAML
    // `${ETH_PRICE_FEED_ADDRESS:-}` pattern works without a real value.
    // Adapters treat empty as `undefined`.
    ethPriceFeed: Type.Optional(
      Type.Union([Type.Literal(""), TypeEthAddress()]),
    ),
  },
  Closed,
);

export const riskSchema = Type.Object(
  {
    maxPositionSize: Type.String(),
    maxUtilizationPct: Type.Number({ minimum: 0, maximum: 100, default: 80 }),
    minCollateralBalance: Type.String(),
    maxDailyLossUsd: Type.String(),
    maxGasBudgetPerHourUsd: Type.String({ default: "50000000" }),
    maxGasBudgetPerDayUsd: Type.String({ default: "500000000" }),
    gasSpikeThresholdPct: Type.Number({ default: 200 }),
    gasPenaltyBps: Type.Number({ default: 5 }),
    urgentRequoteThresholdTicks: Type.Number({ default: 10 }),
  },
  Closed,
);

export const gasSchema = Type.Object(
  {
    gasCapMultiplier: Type.Number({ default: 2.0 }),
  },
  Closed,
);

export const timingSchema = Type.Object(
  {
    pollIntervalMs: Type.Number({ minimum: 100, default: 3000 }),
    requoteThresholdTicks: Type.Number({ minimum: 0, default: 2 }),
    requoteCooldownMs: Type.Number({ minimum: 0, default: 1000 }),
    resyncIntervalMs: Type.Number({ minimum: 1000, default: 60000 }),
    /** Tick-spacing between successive quote levels. */
    levelSpacingTicks: Type.Number({ minimum: 1, default: 1 }),
  },
  Closed,
);

export const collateralSchema = Type.Object(
  {
    /** Auto-deposit any wallet-held collateral into the vault on every update. */
    autoDeposit: Type.Boolean({ default: false }),
    /** Skip auto-deposit if walletTokenBalance < this amount. */
    autoDepositMinAmount: Type.String({ default: "0" }),
  },
  Closed,
);

export const healthSchema = Type.Object(
  {
    port: Type.Number({ minimum: 0, default: 3001 }),
  },
  Closed,
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

export interface LoadConfigOpts<T> {
  schema: TSchema;
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** App-specific cross-field validation; throws ConfigError on failure. */
  validate?: (cfg: T) => void;
}

export function loadConfigFromFile<T>(opts: LoadConfigOpts<T>): T {
  const env = opts.env ?? process.env;
  // Precedence: explicit opts.path > --config CLI arg > MAKER_CONFIG env var.
  // CLI arg deliberately beats env so docker/CI can pass a different path
  // without unsetting the inherited env.
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

  const cfg = expanded as T;
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
