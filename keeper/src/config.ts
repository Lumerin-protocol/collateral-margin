import { getAddress, isAddress, isHex } from "viem";
import type { Address, Hex } from "viem";
import type pino from "pino";

/**
 * Configuration for the unified margin keeper.
 *
 * Lives entirely in environment variables — same pattern as the legacy
 * perps keeper and futures margin-call lambda so secret management /
 * deployment templates can be reused unchanged.
 *
 * Keys grouped by responsibility, mirroring the module layout:
 *   - chain:      RPC + network id (shared)
 *   - vault:      shared CollateralVault address
 *   - perps:      Perps DEX address + per-venue overrides
 *   - futures:    Futures address + per-venue overrides
 *   - pme:        PortfolioMarginEngine address
 *   - keeper:     LIQUIDATOR_PRIVATE_KEY + tx behaviour
 *   - alerts:     notification webhook(s)
 *   - triggers:   thresholds for IM / MM utilization alerts
 *   - coordinator: cross-account ordering + concurrency
 *   - runtime:    healthcheck port, log level, dry-run, intervals
 */
export interface Config {
  chain: {
    network: string;
    rpcUrl: string;
    /** Optional: prefer to use Goldsky webhooks over RPC event subscriptions. */
    discoveryMode: "events" | "webhook" | "both";
    /**
     * Block to start the one-shot historical backfill from on startup. We
     * scan vault / perps / futures discovery events from this block up to
     * the head, then hand off to the live `watchContractEvent` stream.
     * Undefined disables backfill (forward-only mode — only safe if the
     * webhook ingester or a long-running prior keeper has primed the set).
     */
    backfillFromBlock?: bigint;
    /**
     * `getLogs` page size. Most public RPCs cap log ranges at 10k blocks,
     * so we chunk. Lower this if your provider is stricter.
     */
    backfillChunkSize: bigint;
  };
  vault: { address: Address };
  perps: {
    address: Address;
    /** Optional fast pre-filter: only consider users above this notional ($USDC token decimals). */
    minNotional?: bigint;
  };
  futures: {
    address: Address;
    /** Optional fast pre-filter (token decimals). */
    minNotional?: bigint;
  };
  pme: { address: Address };
  oracle: {
    /**
     * HashpriceUSD aggregator (`AggregatorV3Interface`) — single source for the
     * current hashprice in USDC. Both Perps and Futures contracts read from
     * the same upstream feed, so this one address covers both venues.
     */
    hashpriceUsdcAddress: Address;
    /**
     * Chainlink BTC/USDC `AggregatorProxy`. We subscribe to its `AnswerUpdated`
     * event as the trigger for re-evaluating the predictive index — BTC/USDC
     * dominates `HashpriceUSD = HashpriceBTC * BTC/USD` in update frequency
     * (BTC blocks are ~10 min; BTC/USDC moves on Chainlink's deviation/heartbeat
     * thresholds, much more often).
     */
    btcUsdcFeedAddress: Address;
    /**
     * Minimum fractional price move (in basis points) before the predictive
     * coordinator processes the new tick. Filters out micro-jitter that can't
     * possibly cross any user's liquidation threshold. 0 = process every event.
     */
    priceMoveTriggerBps: number;
  };
  keeper: {
    /** Single signer used for both perps and futures liquidations. */
    privateKey: Hex;
    /** When true, log planned actions but don't broadcast transactions. */
    dryRun: boolean;
    /**
     * If a coordinated plan would yield less than this in fees minus gas
     * estimate, skip it. Token decimals (USDC = 6).
     */
    minProfitMargin: bigint;
  };
  alerts: {
    /** Slack/Discord/etc. webhook URL. Disabled if undefined. */
    webhookUrl?: string;
    /** Once an account fires an alert, do not re-alert for this many ms. */
    dedupeMs: number;
    /** IM utilization (imRequired / balance) above this triggers a warn alert. */
    imWarnUtilization: number;
    /** Same, but a critical alert and ranks higher in the queue. */
    imCriticalUtilization: number;
  };
  triggers: {
    /** Webhook ingestion port. Only used when discoveryMode includes "webhook". */
    webhookPort: number;
    /** Optional shared secret required by `Authorization: Bearer <token>` from Goldsky. */
    webhookSecret?: string;
  };
  coordinator: {
    /** Max accounts processed concurrently — 1 means strict serial coordination. */
    maxConcurrentAccounts: number;
    /** Block-confirmation depth waited for before re-running planner on a target. */
    confirmationBlocks: number;
  };
  runtime: {
    /** Cadence of the periodic re-evaluation sweep in ms. Event-driven path is primary. */
    sweepIntervalMs: number;
    healthPort: number;
    logLevel: pino.Level;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalBigInt(name: string): bigint | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : BigInt(value);
}

/**
 * Read an env var that must be a 0x-prefixed 20-byte EVM address.
 * Returns the EIP-55 checksummed form so downstream comparisons / logs
 * are consistent regardless of how operators capitalize the input.
 */
function requireAddress(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value, { strict: false })) {
    throw new Error(`Environment variable ${name} must be a valid EVM address, got "${value}"`);
  }
  return getAddress(value);
}

/**
 * Read an env var that must be a 0x-prefixed hex string of the given byte length
 * (omit `bytes` to accept any length). Used for private keys and similar secrets.
 */
function requireHex(name: string, bytes?: number): Hex {
  const value = requireEnv(name);
  if (!isHex(value)) {
    throw new Error(`Environment variable ${name} must be a 0x-prefixed hex string`);
  }
  if (bytes !== undefined && value.length !== 2 + bytes * 2) {
    throw new Error(`Environment variable ${name} must be ${bytes} bytes (${2 + bytes * 2} chars), got ${value.length}`);
  }
  return value;
}

export function loadConfig(): Config {
  const discoveryMode = (process.env.DISCOVERY_MODE ?? "events") as Config["chain"]["discoveryMode"];
  if (!["events", "webhook", "both"].includes(discoveryMode)) {
    throw new Error(`DISCOVERY_MODE must be one of events|webhook|both, got "${discoveryMode}"`);
  }

  return {
    chain: {
      network: requireEnv("NETWORK"),
      rpcUrl: requireEnv("ETH_NODE_ADDRESS"),
      discoveryMode,
      backfillFromBlock: optionalBigInt("BACKFILL_FROM_BLOCK"),
      backfillChunkSize: BigInt(process.env.BACKFILL_CHUNK_SIZE ?? "10000"),
    },
    vault: { address: requireAddress("VAULT_ADDRESS") },
    perps: {
      address: requireAddress("PERPS_ADDRESS"),
      minNotional: optionalBigInt("PERPS_MIN_NOTIONAL"),
    },
    futures: {
      address: requireAddress("FUTURES_ADDRESS"),
      minNotional: optionalBigInt("FUTURES_MIN_NOTIONAL"),
    },
    pme: { address: requireAddress("PME_ADDRESS") },
    oracle: {
      hashpriceUsdcAddress: requireAddress("HASHPRICE_USDC_ADDRESS"),
      btcUsdcFeedAddress: requireAddress("BTC_USDC_FEED_ADDRESS"),
      priceMoveTriggerBps: Number(process.env.PRICE_MOVE_TRIGGER_BPS ?? "1"),
    },
    keeper: {
      privateKey: requireHex("LIQUIDATOR_PRIVATE_KEY", 32),
      dryRun: process.env.DRY_RUN === "true",
      minProfitMargin: BigInt(process.env.KEEPER_MIN_PROFIT_MARGIN ?? "0"),
    },
    alerts: {
      webhookUrl: process.env.ALERT_WEBHOOK_URL,
      dedupeMs: Number(process.env.ALERT_DEDUPE_MS ?? "300000"),
      imWarnUtilization: Number(process.env.ALERT_IM_WARN_UTIL ?? "0.85"),
      imCriticalUtilization: Number(process.env.ALERT_IM_CRITICAL_UTIL ?? "0.95"),
    },
    triggers: {
      webhookPort: Number(process.env.WEBHOOK_PORT ?? "3001"),
      webhookSecret: process.env.WEBHOOK_SECRET,
    },
    coordinator: {
      maxConcurrentAccounts: Number(process.env.COORDINATOR_MAX_CONCURRENT ?? "1"),
      confirmationBlocks: Number(process.env.COORDINATOR_CONFIRMATION_BLOCKS ?? "1"),
    },
    runtime: {
      // Default 60s. The predictive coordinator drives the hot-path
      // re-evaluation off price events; this sweep is now the safety net
      // for things the predictor can't model exactly (funding accrual,
      // futures `pricePerDay` decay, model drift).
      sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? "60000"),
      healthPort: Number(process.env.HEALTH_PORT ?? "3000"),
      logLevel: (process.env.LOG_LEVEL as pino.Level) ?? "info",
    },
  };
}
