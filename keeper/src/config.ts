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
export type NetworkName = "hardhat" | "base-sepolia" | "base-mainnet";

export const SUPPORTED_NETWORKS: readonly NetworkName[] = [
  "hardhat",
  "base-sepolia",
  "base-mainnet",
] as const;

export interface Config {
  chain: {
    /** Logical network selector. Drives both `rpcUrl` and the viem chain object. */
    network: NetworkName;
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
    /**
     * Optional Chainlink ETH/USD `AggregatorProxy`. Used purely for logging:
     * when set, every confirmed tx log gets a `gasCostUsd` field alongside
     * `gasCostEth` so operators can read tx cost without doing wei-math at
     * 4 a.m. When unset, the keeper skips the USD field and logs native cost
     * only — no operational dependency, so deployments without a configured
     * feed still run normally.
     */
    ethUsdcFeedAddress?: Address;
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
    /**
     * Cadence of the gas-token balance check on the keeper signer in ms.
     * Defaults to 5 minutes — frequent enough to catch a draining wallet
     * within a few percent of its remaining headroom, infrequent enough
     * that the log isn't noisy.
     */
    balanceCheckIntervalMs: number;
    /**
     * Native gas balance below which the monitor logs WARN ("top up
     * soon"). Sized for Base at ~current gas: 10 mETH ≈ a few hundred
     * mid-sized txs of headroom. Wei.
     */
    balanceLowWei: bigint;
    /**
     * Native gas balance below which the monitor logs ERROR ("top up
     * NOW"). 1 mETH ≈ a handful of txs left before insufficient-funds
     * reverts start. Wei.
     */
    balanceCriticalWei: bigint;
  };
  outdatedOrders: {
    /**
     * Cadence of the futures expired-order sweep in ms. Default 5 min —
     * expired orders aren't time-critical (they just pin a slot under
     * `MAX_ORDERS_PER_PARTICIPANT` and leave a dead level on the book),
     * so we don't need the sub-minute cadence used by liquidations. Set
     * to 0 to disable the sweep entirely (e.g. when another keeper is
     * the designated cleaner).
     */
    sweepIntervalMs: number;
    /**
     * Maximum number of `removeOutdatedOrder` calls bundled into a
     * single `Futures.multicall(bytes[])` tx. Each call is roughly
     * 50-80k gas (one `_closeOrder` traversal); 50 keeps us well under
     * Base's 30M block-gas limit (~4M worst case). Larger user-side
     * fan-outs split across multiple sequential txs.
     */
    maxBatchSize: number;
  };
  delivery: {
    /**
     * Opt-in: when true, the keeper acts as the futures `validator` and calls
     * `closeDelivery(positionId, blameSeller)` on every active futures position
     * the moment its `deliveryAt` is reached. Defaults to `false` so a stock
     * keeper deployment doesn't accidentally start cash-settling positions on a
     * chain where it isn't the configured validator.
     *
     * Requires the keeper signer (`LIQUIDATOR_PRIVATE_KEY`) to equal the
     * Futures contract's `validatorAddress` — otherwise `closeDelivery` reverts
     * `OnlyValidatorOrPositionParticipant` and the module logs the skip.
     */
    enabled: boolean;
    /**
     * Side blamed for the breach when settling at delivery start. The breach
     * penalty is paid by the blamed party to the counterparty; with
     * `breachPenaltyRatePerDay = 0` (the default in production) the choice is
     * cosmetic. Set `true` to blame the seller (default: they're the ones
     * who didn't deliver hashrate), `false` to blame the buyer.
     */
    blameSeller: boolean;
    /**
     * Cadence of the periodic safety-net sweep over tracked positions. Picks
     * up anything the per-position timers missed (process restarts, missed
     * `LotCreated` events, clock skew). Live timers are the hot path.
     */
    sweepIntervalMs: number;
    /**
     * Delay after `position.deliveryAt` before attempting `closeDelivery`.
     * Adds a small cushion so the on-chain `block.timestamp >= deliveryAt`
     * guard is satisfied even when local and miner clocks drift slightly.
     */
    settleDelayMs: number;
    /**
     * Manual seed list of addresses whose futures positions the delivery
     * coordinator should index immediately on boot, in addition to whatever
     * the participant tracker has discovered. Useful as an emergency lever
     * when log backfill fails (e.g. Alchemy free tier capping `eth_getLogs`
     * to 10 blocks) and a known user has an unsettled position the
     * coordinator would otherwise never see. Comma-separated EVM addresses.
     */
    bootstrapUsers: readonly Address[];
    /**
     * Maximum number of `closeDelivery` calls bundled into a single
     * `Futures.multicall(bytes[])` transaction. Trades a single nonce per
     * sweep tick (no replacement-underpriced races) for one bigger tx.
     * Capped to keep gas usage well under the block limit — Base has 30M
     * block gas, each `closeDelivery` is roughly 200-300k gas, so 50 is
     * conservative (~15M gas worst case). Set lower if your participants
     * have unusually expensive settlement paths.
     */
    maxBatchSize: number;
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
 * Like `requireAddress` but returns `undefined` when the env var is unset
 * or empty. Still validates the address shape when present so a typo fails
 * at boot rather than silently rendering a feed inert.
 */
function optionalAddress(name: string): Address | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`Environment variable ${name} must be a valid EVM address, got "${raw}"`);
  }
  return getAddress(raw);
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
    throw new Error(
      `Environment variable ${name} must be ${bytes} bytes (${2 + bytes * 2} chars), got ${value.length}`,
    );
  }
  return value;
}

/**
 * Parse a comma/whitespace-separated list of EVM addresses from an optional
 * env var. Each entry is checksummed via `getAddress`; an invalid entry
 * throws so a typo in deployment config fails fast instead of silently
 * dropping the user.
 */
function parseAddressList(name: string): readonly Address[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [];
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.map((value) => {
    if (!isAddress(value, { strict: false })) {
      throw new Error(`Environment variable ${name} contains invalid address "${value}"`);
    }
    return getAddress(value);
  });
}

function requireNetwork(): NetworkName {
  const value = requireEnv("NETWORK");
  if (!(SUPPORTED_NETWORKS as readonly string[]).includes(value)) {
    throw new Error(
      `NETWORK must be one of ${SUPPORTED_NETWORKS.join("|")}, got "${value}"`,
    );
  }
  return value as NetworkName;
}

/**
 * Build the RPC URL for the chosen network. Hardhat resolves to the local node
 * and ignores `ALCHEMY_API_KEY`. An explicit `ETH_NODE_ADDRESS` always wins so
 * operators can point at a custom RPC without touching this logic.
 */
function resolveRpcUrl(network: NetworkName): string {
  const explicit = process.env.ETH_NODE_ADDRESS;
  if (explicit) return explicit;

  if (network === "hardhat") {
    return process.env.HARDHAT_RPC_URL ?? "http://127.0.0.1:8545";
  }

  const alchemySubdomain: Record<Exclude<NetworkName, "hardhat">, string> = {
    "base-sepolia": "base-sepolia",
    "base-mainnet": "base-mainnet",
  };
  const apiKey = requireEnv("ALCHEMY_API_KEY");
  return `https://${alchemySubdomain[network]}.g.alchemy.com/v2/${apiKey}`;
}

export function loadConfig(): Config {
  const discoveryMode = (process.env.DISCOVERY_MODE ??
    "events") as Config["chain"]["discoveryMode"];
  if (!["events", "webhook", "both"].includes(discoveryMode)) {
    throw new Error(`DISCOVERY_MODE must be one of events|webhook|both, got "${discoveryMode}"`);
  }

  const network = requireNetwork();

  return {
    chain: {
      network,
      rpcUrl: resolveRpcUrl(network),
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
      hashpriceUsdcAddress: requireAddress("HASHPRICE_USD_ADDRESS"),
      btcUsdcFeedAddress: requireAddress("BTC_USD_FEED_ADDRESS"),
      priceMoveTriggerBps: Number(process.env.PRICE_MOVE_TRIGGER_BPS ?? "1"),
      ethUsdcFeedAddress: optionalAddress("ETH_USD_FEED_ADDRESS"),
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
      balanceCheckIntervalMs: Number(process.env.BALANCE_CHECK_INTERVAL_MS ?? "300000"),
      // Defaults: 10 mETH low, 1 mETH critical. Override via env vars
      // when running on a chain with materially different gas prices.
      balanceLowWei: BigInt(process.env.BALANCE_LOW_WEI ?? "10000000000000000"),
      balanceCriticalWei: BigInt(process.env.BALANCE_CRITICAL_WEI ?? "1000000000000000"),
    },
    outdatedOrders: {
      sweepIntervalMs: Number(process.env.OUTDATED_ORDERS_SWEEP_INTERVAL_MS ?? "300000"),
      maxBatchSize: Number(process.env.OUTDATED_ORDERS_MAX_BATCH_SIZE ?? "50"),
    },
    delivery: {
      enabled: process.env.DELIVERY_KEEPER_ENABLED === "true",
      blameSeller: process.env.DELIVERY_BLAME_SELLER !== "false",
      sweepIntervalMs: Number(process.env.DELIVERY_SWEEP_INTERVAL_MS ?? "60000"),
      settleDelayMs: Number(process.env.DELIVERY_SETTLE_DELAY_MS ?? "5000"),
      bootstrapUsers: parseAddressList("DELIVERY_BOOTSTRAP_USERS"),
      maxBatchSize: Number(process.env.DELIVERY_MAX_BATCH_SIZE ?? "50"),
    },
  };
}
