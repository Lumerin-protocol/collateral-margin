# collateral-margin keeper

Single long-running off-chain coordinator that monitors the shared
`CollateralVault` and force-closes underwater Perps and Futures accounts via the
permissionless `liquidate*` entry points landed in Phase 0 of the unified
margin keeper plan.

> **Status: implemented.** All Phase 1 and Phase 2 modules are wired and
> covered by `node:test` unit suites (run `pnpm test`). The keeper boots,
> tracks participants, runs the orders-then-positions plan and surfaces
> alerts. See `unified_margin_keeper_d6f69493.plan.md` for the full plan.

## Why one worker

| Concern              | Why a single worker                                           |
| -------------------- | ------------------------------------------------------------- |
| Shared vault         | Both venues spend the same collateral; one signer avoids races |
| Shared margin engine | `computePortfolioMM` is portfolio-wide → cross-venue ordering matters |
| Strict orders-first  | Cross-venue plan composes `liquidateOrders` → `liquidatePosition` atomically |
| One alert pipeline   | Same vault → same human-facing alerts                          |

## How it runs (per liquidation)

```
              ┌──────────────────────┐
events ──────►│ ParticipantTracker   │── onAdded / onChanged ─┐
              └──────────┬───────────┘                        │
                         │                                    ▼
                         │                  ┌──────────────────────────────┐
                         │                  │ PredictiveCoordinator        │
                         │                  │  · readAccountSnapshot       │
                         │                  │  · solveLiquidationThresholds│
                         │                  │  · index.upsert(P_down/P_up) │
                         │                  └────────────┬─────────────────┘
                         │                               │
        ┌────────────────┘                               │ index.crossings(prev,next)
        ▼                                                ▲
┌──────────────────────┐                                 │ AnswerUpdated
│ Scheduler            │── alerts ──► Notifier  ┌────────┴───────────┐
│  · runSweep (60 s)   │   (warn /              │ PriceFeed          │── reads ──► HashpriceUSDC
│    safety net only   │    critical)           │  (BTC/USDC events) │
└──────────┬───────────┘                        └────────────────────┘
           │ upsert(health)
           ▼
┌────────────────────────┐ pop() ┌───────────────────────────────────┐
│ CoordinatorQueue       │──────►│ Planner.run(user)                 │
│  (mmSurplus ASC,       │       │  1. snapshot health               │
│   underwater only)     │       │  2. liquidateOrders × venues      │
└────────────────────────┘       │  3. rank positions across venues  │
                                 │  4. liquidatePosition (worst)     │
                                 │  5. recheck, loop on race         │
                                 └───────────────────────────────────┘
```

The **PredictiveCoordinator** is the hot path: it watches BTC/USDC for
`AnswerUpdated`, re-reads the aggregated `HashpriceUSDC.latestRoundData`,
and uses pre-solved per-user liquidation prices to push exactly the
crossed users into the queue. The on-chain `mmSurplus` predicate stays the
source of truth — the planner re-reads it before any tx, so model drift
can only cause a spurious queue insert (caught instantly), never a
spurious liquidation.

The **Scheduler** sweep is now the safety net: it covers funding accrual,
futures `pricePerDay` decay, and any model drift the predictor can't
capture exactly. Default cadence dropped from 10 s to 60 s.

`Planner` calls into per-venue `Venue` adapters
(`src/venues/{perps,futures}.ts`). Each adapter encapsulates calldata,
multicall reads, gas estimation and decoding the recoverable reverts
(`OrdersStillOpen`, `NotLiquidatable`, …). Adding options later means
implementing one more adapter — the planner does not change.

## Module layout

```
src/
  index.ts             # Entry point — wires every module + graceful shutdown
  config.ts            # Env-driven config (LIQUIDATOR_PRIVATE_KEY, addresses, …)
  chain.ts             # Shared viem PublicClient + WalletClient + signer
  abi/                 # Generated ABI bundles, kept in sync via scripts/sync-abis.ts
  pme/
    health.ts          # readAccountHealthBatch via PME multicall (balance/IM/MM)
  oracle/
    abi.ts             # Minimal AggregatorV3 ABI (AnswerUpdated, latestRoundData, decimals)
    priceFeed.ts       # BTC/USDC subscription + HashpriceUSDC current-price reads
  predict/
    types.ts           # AccountSnapshot, MMParams, PriceThresholds
    snapshot.ts        # One-shot multicall: balance + perp/futures position state + PME shocks
    mm.ts              # Pure: mmRequired(snap, P), mmSurplus(snap, P), imRequired/imSurplus
    solve.ts           # Closed-form bisection: { liqDown, liqUp } per snapshot
    predictiveIndex.ts # Sorted threshold index (down ASC, up ASC) with O(log) crossings
    coordinator.ts     # PriceFeed + tracker → index → CoordinatorQueue + executor.kick
  discovery/
    tracker.ts         # Event-driven participant set + one-shot startup backfill
    webhook.ts         # Optional Goldsky webhook ingester (Bearer-token auth)
  venues/
    types.ts           # Venue interface (multi-market aware: perps, futures, options)
    perps.ts           # Perps adapter (HashPowerPerpsDEX)
    futures.ts         # Futures adapter (deliveryAt → marketId)
  coordinator/
    queue.ts           # mmSurplus-ordered cross-account priority queue
    planner.ts         # Per-account orders → positions liquidation plan
    executor.ts        # Pulls from queue, runs planner with bounded concurrency
  alert/
    notifier.ts        # Shared dedup'd webhook notifier (warn → critical promotion)
  tx/
    liquidate.ts       # Shared simulate → send → parse-fee + revert-decoding helper
  runtime/
    scheduler.ts       # Periodic safety-net sweep over the tracker's user set
    healthcheck.ts     # GET /health for k8s/ECS liveness probes

scripts/
  sync-abis.ts         # Copies sibling-package ABIs into src/abi/

tests/
  coordinator/, venues/, pme/, alert/, discovery/, runtime/   # node:test suites
```

## Local dev

```bash
# 1. Compile the source contracts so ABIs exist on disk.
pnpm -C ../../perps/contracts build
pnpm -C ../../futures-marketplace/contracts build
pnpm -C ../../collateral-margin/contracts build

# 2. Pull the ABIs into src/abi/.
pnpm sync-abis

# 3. Type-check + run the unit suite.
pnpm typecheck
pnpm test

# 4. Run the keeper against a local node (see Config below).
pnpm dev:dry      # dry-run — log planned actions but don't broadcast
pnpm dev          # broadcast — real liquidations
```

## Config (env vars)

See `src/config.ts` for the authoritative shape. The minimum-viable set:

| Var                            | Required | Purpose                                |
| ------------------------------ | -------- | -------------------------------------- |
| `NETWORK`                      | yes      | Chain label (e.g. `arbitrum-sepolia`)  |
| `ETH_NODE_ADDRESS`             | yes      | RPC URL                                |
| `LIQUIDATOR_PRIVATE_KEY`       | yes      | Signer (single key for both venues)    |
| `VAULT_ADDRESS`                | yes      | Shared CollateralVault                 |
| `PERPS_ADDRESS`                | yes      | HashPowerPerpsDEX                      |
| `FUTURES_ADDRESS`              | yes      | Futures                                |
| `PME_ADDRESS`                  | yes      | PortfolioMarginEngine                  |
| `HASHPRICE_USDC_ADDRESS`       | yes      | HashpriceUSD aggregator (current spot) |
| `BTC_USDC_FEED_ADDRESS`        | yes      | Chainlink BTC/USDC AggregatorProxy (event source) |
| `PRICE_MOVE_TRIGGER_BPS`       | no       | Skip ticks below this fractional move (default `1`) |
| `DISCOVERY_MODE`               | no       | `events` (default) \| `webhook` \| `both` |
| `BACKFILL_FROM_BLOCK`          | no       | Block to start the one-shot startup backfill from (vault/perps/futures discovery events). Unset = forward-only — only safe with webhook discovery or a previously-warm tracker. |
| `BACKFILL_CHUNK_SIZE`          | no       | Per-`getLogs` page size for backfill. Default `10000` (most public RPC limit). |
| `DRY_RUN`                      | no       | `true` to skip on-chain broadcasts     |
| `ALERT_WEBHOOK_URL`            | no       | Slack/Discord/PagerDuty endpoint       |
| `ALERT_DEDUPE_MS`              | no       | Dedupe window per (severity, user, market). Default `300_000` |
| `ALERT_IM_WARN_UTIL`           | no       | IM utilization triggering warn alert. Default `0.85`         |
| `ALERT_IM_CRITICAL_UTIL`       | no       | IM utilization triggering critical alert. Default `0.95`     |
| `WEBHOOK_PORT`                 | no       | Goldsky ingestion port. Default `3001` |
| `WEBHOOK_SECRET`               | no       | `Authorization: Bearer <token>` shared secret |
| `COORDINATOR_MAX_CONCURRENT`   | no       | Concurrent plans. Default `1` (safe)   |
| `COORDINATOR_CONFIRMATION_BLOCKS` | no    | Block confirmations after each tx. Default `1` |
| `KEEPER_MIN_PROFIT_MARGIN`     | no       | Bail on plans that would net ≤ this in token decimals. Default `0` |
| `SWEEP_INTERVAL_MS`            | no       | Periodic safety-net sweep cadence (predictor handles the hot path). Default `60_000` |
| `HEALTH_PORT`                  | no       | `GET /health` port. Default `3000`     |
| `LOG_LEVEL`                    | no       | pino level. Default `info`             |

## Dry run

`DRY_RUN=true` (or `pnpm dev:dry`) skips every `writeContract` and instead
logs the request that would have been broadcast — discovery, ranking,
simulate-revert decoding and alerting all run as in production. This is the
pre-cutover validation step: point dry-run at the production RPC for a few
hours and grep the logs for `[dryRun] would send liquidate tx` to confirm
the keeper would have triggered exactly when the legacy systems did.

## Cutover plan

This package replaces both `futures-marketplace/margin-call/` (Lambda) and
`perps/keeper/` (single-venue keeper). The contracts in Phase 0 added
permissionless `liquidate*` entry points alongside the legacy paths so
cutover is staged:

1. **Deploy** with `DRY_RUN=true` against production RPC. Verify alert
   webhook + healthcheck. Compare planned actions against the live Lambda /
   keeper logs for at least one liquidation cycle.
2. **Promote**: flip `DRY_RUN=false`. Leave the legacy systems running for a
   day as a fallback — the contracts dedupe (you cannot liquidate the same
   underwater account twice).
3. **Decommission** the legacy `margin-call` Lambda and `perps/keeper`
   service. Re-balance alert routing to point only at this keeper.
4. **Cleanup** (separate PR): the futures contract's `marginCall` (validator-
   only) entry point was preserved during Phase 0b for backward
   compatibility. Once this keeper owns production traffic, that path can be
   removed in a follow-up upgrade — see the plan's Phase 4.

## Test surface

```
$ pnpm test
…
ℹ tests 144
ℹ pass 144
ℹ fail 0
```

Suites cover:

- `pme/health` — multicall batching + `imUtilization` precision
- `venues/perps` — long/short PnL math, `PERPS_MARKET_ID` sentinel, position id
- `venues/futures` — buyer/seller PnL, `deliveryAt` → marketId, `deliveryDurationDays` caching
- `coordinator/queue` — BigInt-safe ordering, `upsert` re-ranking, snapshot semantics
- `coordinator/planner` — orders-leg, position ranking, `OrdersStillOpen`-replay, bad-debt
- `alert/notifier` — dedupe window, severity promotion, ordering, retry-on-failure
- `discovery/tracker` — checksum dedupe, `onAdded` / `onChanged` listeners, startup backfill
- `discovery/webhook` — payload extraction across `data` / `records` / array shapes
- `runtime/scheduler` — alert ladder thresholds, queue upsert + executor kick wiring
- `oracle/priceFeed` — rebase to token decimals, dispatch, no-op on unchanged answer
- `predict/mm` — net delta, stress, perp/futures unrealized loss, mm/im surplus
- `predict/solve` — long/short downside & upside thresholds, drag from orderMargin/funding
- `predict/predictiveIndex` — upsert/invalidate, sorted crossings on rise & drop
- `predict/snapshot` — multicall shape, funding-clamping, futures buyer/seller hydration
- `predict/coordinator` — end-to-end (priceFeed → solver → queue), drift safety net, bps gate
- `tx/liquidate` — exposed via venue tests (revert decoding round-trip)

## Predictive layer notes

Currently in scope:
- Pure-delta MM math (perps + futures). Closed-form bisection over kinks
  is < 100 µs per user; an N-user reindex on a price tick is dominated by
  the multicall RPC, not the solver.
- Single price axis (HashpriceUSDC) — both venues read the same upstream.
- Downside *and* upside crossings (covers leveraged longs and shorts).

Currently out of scope (deferred — periodic sweep covers them):
- Options Greeks (γ, ν stress terms — PME is delta-only until options engine registered).
- Predictive IM warn / critical alerts (warn / critical still fire from sweep).
- HashpriceBTC `HashpriceUpdated` subscription (10-min cadence; sweep covers it).
- Funding-rate-aware re-prediction at next funding tick.
- Futures `pricePerDay` time-decay scheduling.
