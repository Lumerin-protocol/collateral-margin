import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { type Static, type StringOptions, type TUnsafe, Type } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ConfigError } from "./errors.ts";
import type { VenueKind } from "./adapter.ts";

const TypeEthAddress = (opt?: StringOptions) =>
  Type.String({ ...opt, pattern: "^0x[a-fA-F0-9]{40}$" }) as TUnsafe<`0x${string}`>;

const TypeHex = (opt?: StringOptions) =>
  Type.String({ ...opt, pattern: "^0x[a-fA-F0-9]+$" }) as TUnsafe<`0x${string}`>;

/**
 * ${VAR} expansion. Recursively walks strings in the parsed YAML and replaces
 * ${NAME} with process.env.NAME. Throws if the variable is not set unless a
 * default is provided via the `${NAME:-default}` syntax.
 */
function expandEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
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

const walletSchema = Type.Object({
  privateKey: TypeHex(),
});

const networkSchema = Type.Object({
  name: Type.String(),
  rpcUrl: Type.String(),
  ethPriceFeed: Type.Optional(TypeEthAddress()),
});

const venueBase = Type.Object({
  kind: Type.Union([
    Type.Literal("perps"),
    Type.Literal("futures"),
    Type.Literal("options"),
  ]),
  address: TypeEthAddress(),
  wallet: Type.String(),
  eventsFromBlock: Type.Optional(Type.Number({ minimum: 0 })),
});

const pricingSchema = Type.Object({
  strategy: Type.Union([
    Type.Literal("effective-spread"),
    Type.Literal("reservation-price"),
  ]),
  minSpreadBps: Type.Number({ minimum: 0 }),
  volatilityMultiplier: Type.Number({ minimum: 0 }),
  inventorySkewGamma: Type.Optional(Type.Number({ minimum: 0 })),
  maxSkewTicks: Type.Number({ minimum: 0 }),
  // reservation-price extras (optional; required at strategy load)
  riskAversion: Type.Optional(Type.Number({ minimum: 0 })),
  marginCallTimeSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

const sizingSchema = Type.Object({
  strategy: Type.Union([
    Type.Literal("linear"),
    Type.Literal("geometric-taper"),
  ]),
  baseQuantity: Type.String(), // bigint-as-string
  numLevelsPerSide: Type.Number({ minimum: 1 }),
  // geometric-taper extras
  taperRatio: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 })),
});

const riskSchema = Type.Object({
  maxPositionSize: Type.String(),
  maxUtilizationPct: Type.Number({ minimum: 0, maximum: 100, default: 80 }),
  minCollateralBalance: Type.String(),
  maxDailyLossUsd: Type.String(),
  maxGasBudgetPerHourUsd: Type.String({ default: "50000000" }),
  maxGasBudgetPerDayUsd: Type.String({ default: "500000000" }),
  gasSpikeThresholdPct: Type.Number({ default: 200 }),
  gasPenaltyBps: Type.Number({ default: 5 }),
  urgentRequoteThresholdTicks: Type.Number({ default: 10 }),
});

const gasSchema = Type.Object({
  gasCapMultiplier: Type.Number({ default: 2.0 }),
});

const timingSchema = Type.Object({
  pollIntervalMs: Type.Number({ minimum: 100, default: 3000 }),
  requoteThresholdTicks: Type.Number({ minimum: 0, default: 2 }),
  requoteCooldownMs: Type.Number({ minimum: 0, default: 1000 }),
  resyncIntervalMs: Type.Number({ minimum: 1000, default: 60000 }),
});

const healthSchema = Type.Object({
  port: Type.Number({ minimum: 0, default: 3001 }),
});

const rootSchema = Type.Object({
  nodeEnv: Type.String({ default: "development" }),
  commitHash: Type.String({ default: "unknown" }),
  logLevel: Type.String({ default: "info" }),
  dryRun: Type.Boolean({ default: false }),
  wallets: Type.Record(Type.String(), walletSchema),
  network: networkSchema,
  venue: venueBase,
  pricing: pricingSchema,
  sizing: sizingSchema,
  risk: riskSchema,
  gas: gasSchema,
  timing: timingSchema,
  health: healthSchema,
});

export type MakerConfig = Static<typeof rootSchema>;

/** Parse a YAML file, expand ${VAR} tokens, validate against schema. */
export function loadConfig(opts: {
  path?: string;
  env?: NodeJS.ProcessEnv;
} = {}): MakerConfig {
  const env = opts.env ?? process.env;
  const configPath = opts.path ?? env.MAKER_CONFIG ?? parseConfigArg(process.argv);
  if (!configPath) {
    throw new ConfigError(
      "No config path provided. Use --config <path> or set MAKER_CONFIG env var.",
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

  const ajv = new Ajv.default({
    allErrors: true,
    useDefaults: true,
    coerceTypes: false,
  });
  addFormats.default(ajv);
  const validate = ajv.compile(rootSchema);
  if (!validate(expanded)) {
    const msgs = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`)
      .join("; ");
    throw new ConfigError(`Config validation failed: ${msgs}`);
  }

  const cfg = expanded as MakerConfig;

  if (!cfg.wallets[cfg.venue.wallet]) {
    throw new ConfigError(
      `venue.wallet "${cfg.venue.wallet}" is not declared in wallets map`,
    );
  }

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

export type { VenueKind };
