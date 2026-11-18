# On-chain parameter sync

Contract parameters (fees, margin shocks, backstop settings, oracles) are set by hand today, with `cast send` on dev and one-off Safe proposals on lmn. The config files and the chain drift apart, and nothing shows it.

This doc proposes treating each repo's `config/<env>.env` as the desired state and the chain as the actual state. A `plan` step shows the difference; an `apply` step sends or proposes exactly that difference and nothing else. The same model covers which implementation each proxy points to; see [Upgrades](#upgrades).

Status: proposal. Nothing is built yet.

## What goes wrong today

- Values that live only on chain. Futures deploys never set the liquidation fee; the 50 bps on lmn was set by hand.
- Stale keys. Perps config carried `LIQUIDATION_FEE=1000000`, a flat fee nothing reads, while `deploy-perps.ts` requires `LIQUIDATION_FEE_BPS`, which was missing.
- Owners that differ from config. Perps and futures set `SAFE_OWNER_ADDRESS` to Safe 0x63E0…, but the lmn venues and margin engine are owned by Safe 0x57ac… (same three signers). `update-perps.ts` refuses to run on that mismatch. The lmn vault is owned by the deployer EOA 0x1441….
- Two code paths. Deploy scripts set the first value inline; every later change goes through something else.

## Model

- Desired state: `config/<env>.env` in each repo. A key missing from config is unmanaged, never "set to 0".
- Actual state: read from the contracts with `eth_call`. There is no state file; the chain is the state.
- `plan`: reads every managed value, prints only the differences, and exits 1 on drift.
- `apply`: does only what `plan` shows, grouped by each contract's on-chain `owner()`, not by config:
  - an EOA we hold the key for: send the calls directly;
  - a Safe: propose one batched Safe transaction from the deployer, which is a registered proposer on both lmn Safes.
- Re-running is always safe. After a partial failure, the next `plan` shows only what is left.

## Tools considered

| Tool | Diffs against live chain | Safe | Status |
|---|---|---|---|
| Hardhat Ignition | No, against its own journal | No | Ties parameters to deployment modules |
| Cannon | No, against its previous build on IPFS | Through its website | Maintained, GPL-3.0 |
| Cardstack upgrade-manager | Yes | Yes | Needs ownership handed to its manager contract; abandoned since 2023 |
| Sphinx | Deployments only | Yes | Hosted service shut down |
| OpenZeppelin Defender | No | Yes | Retired July 1, 2026 |
| ChainForm | Yes | Exports a Safe Transaction Builder batch | MIT, Go, about 3,200 lines, one maintainer, created June 2026 |

Ignition and Cannon record what they executed rather than reading the chain, so a value changed by hand is invisible to them, and our contracts would first have to be imported into their formats. OpenZeppelin Monitor, Defender's open-source successor, can alert when a setter is called, but has no plan or apply.

ChainForm ([aleksandarknezevic/chainform](https://github.com/aleksandarknezevic/chainform)) matches the model. Its gaps are contained.

## Proposal: fork ChainForm

Fork it into the Lumerin-protocol org. The code is small and cleanly split: pluggable resource types, a read-only `chain.Reader`, and all ABI encoding in `internal/chain`. `plan --json` already carries the target address, method, arguments and calldata of every operation.

What upstream supports today:

- the `contract` resource: an attribute `X` is read with `X()` and set with `setX(T)`, both taken from the ABI, same type;
- `expect` blocks: read-only values that `plan` reports as drift but never turns into calls;
- `import` (snapshot a live contract into config), Safe Transaction Builder export, and a GitHub Action.

What the fork adds, in order:

1. Explicit getter/setter mapping and multi-value setters. Covers `setShocks`, `setBackstopParams` and `priceOracle()` → `setOracle`. An argument the config does not declare is filled from its current on-chain value, so declaring one shock never zeroes the others. Roughly 150–250 lines.
2. Values from our env files, either numeric strings or an `env_file` setting. Upstream `env()` returns strings and has no number conversion. Roughly 20–50 lines.
3. Settings keyed by an argument, such as `setAuthorizedCaller(address, bool)`. Optional; these change rarely. Roughly 150 lines.
4. Apply, as a TypeScript Hardhat task in our repos that reads `plan --json` and reuses `lib/safe.ts` (about 100–150 lines). It stays in TypeScript rather than moving into the fork: [migrations](#migrations) are TypeScript code using our ABIs, and they run inside apply.
5. Upgrades: storage-slot reads in `chain.Reader`, a `proxy` resource type, and preconditions on other contracts' values. Roughly 150–250 lines, plus about 100 lines in the apply task for the fork simulation. See [Upgrades](#upgrades).

Items 1, 2 and 5 are general; proxy resources are already on the author's roadmap. Offer them upstream to keep the fork thin. ChainForm's job is diffing settings and proxy targets; our apply task owns execution, upgrades and migrations.

## Parameter coverage

| Contract | Setting | Getter / setter | Upstream | Fork item |
|---|---|---|---|---|
| Perps, futures | Taker and maker fee | `takerFeeBps()` / `setTakerFeeBps(int16)`, same for maker | Yes | |
| Perps, futures | Liquidation fee, liquidator share | `liquidationFeeBps()` / `setLiquidationFeeBps(uint16)`, `liquidatorShareBps()` / `setLiquidatorShareBps(uint16)` | Yes | |
| Perps, futures | Oracle | `priceOracle()` / `setOracle(address)` | No, names differ | 1 |
| Vault | Insurance debt cap | `insuranceDebtCap()` / `setInsuranceDebtCap(uint256)` | Yes | |
| Vault | Backstop band, unwind fee | `backstopUnwindBandBps()`, `backstopUnwindFeeBps()` / `setBackstopParams(uint16, uint16)` | No | 1 |
| Vault | Authorized venues | `authorizedCallers(address)` / `setAuthorizedCaller(address, bool)` | No | 3 |
| Margin engine | Margin shocks | `imSpotShock()`, `mmSpotShock()`, `imVolShock()`, `mmVolShock()` / `setShocks(uint256 ×4)` | No | 1 |
| Margin engine | Linear markets | `addLinearMarket(address)` | No | Manual |

Until a fork item lands, the setting can still be declared as an `expect` entry, so `plan` alarms on drift.

## Upgrades

The tool manages which implementation each proxy points to. It does not deploy implementations.

- Desired state: an implementation address per proxy in config, for example `PERPS_IMPLEMENTATION=0x…`, plus the initializer call when a version needs one (`initializeV3()`, say). The update scripts (`update-perps.ts`, `update-futures.ts`, `update-collateral-vault.ts`) keep deploying and verifying the implementation and running the storage-layout check. Their output becomes a pull request that sets the address.
- Actual state: the proxy's ERC1967 implementation slot and the implementation's `VERSION()`.
- `plan` shows the move, for example `perps implementation 6.5.0 → 6.8.0`.
- `apply` calls `upgradeToAndCall(implementation, initData)` through the owner, like any other change. Setters that belong to the new version go into the same Safe batch, after the upgrade. Vault 1.3.0 and `setBackstopParams(50, 5)` then land in one transaction, so there is no window with the band at 0 and unwinds unable to fill.
- Preconditions sit next to the target: for example, margin engine `VERSION()` at least 2.2.0 before futures moves to 6.8.0, the guard `update-futures.ts` has today. Apply refuses when one fails.
- The nightly `plan` flags a proxy pointing at an implementation that is not in config.

Before an upgrade, `plan` cannot read settings that exist only in the new version; vault 1.2.0 has no backstop settings. So apply simulates the batch first:

1. Start an anvil fork of the target chain.
2. Impersonate the owner and execute the whole batch.
3. Run `plan` against the fork. It must come back empty.

This doubles as the dry run for the batch.

Out of scope, and staying in the update scripts and runbooks:

- deploying implementations, which needs compiler output, constructor arguments (such as the margin engine's immutable vault) and explorer verification;
- storage-layout checks, which need compiler output too;
- migrations that need a halt, such as the backstop rollout (halt, upgrade, settle accounts, unhalt). The tool can perform the individual upgrade steps inside them; see [Migrations](#migrations).

## Migrations

Some versions need more than the upgrade itself. Migrations work like database migrations: each declares the version it belongs to, and the tool runs the ones between a proxy's current version and its target, in order. Whether a migration has run is read from the chain; there is no migration log.

- Each repo keeps one file per version, for example `migrations/perps/6.8.0.ts`, declaring the target version, a done check that reads the chain, and its steps.
- `plan` reads the proxy's `VERSION()`, takes the target version from config, and lists every migration in between whose done check fails.
- `apply` runs them in version order, after the preconditions pass and the fork simulation succeeds.

Steps come in four kinds, each run differently:

| Kind | Example | How it runs | Done check |
|---|---|---|---|
| Initializer in the upgrade call | perps `initializeV3()`, vault `initializeV2()` | Inside `upgradeToAndCall`, same transaction | OpenZeppelin's stored initializer version |
| Owner calls after the upgrade | `setBackstopParams` after vault 1.3.0 | Same Safe batch, after the upgrade | The setting's getter |
| Bulk or permissionless work | `rebuild-order-aggregate-cache.ts` | Script from an EOA after the upgrade, resumable | A view confirming the data is consistent |
| Halted migration | The backstop rollout: halt, upgrade, settle every account, unhalt | Phase by phase, a human confirming each one; never automated in CI | Per phase, from on-chain and subgraph reads |

Rules:

- Every migration can be re-run. Its done check turns a second run into a no-op, so after a partial run `plan` lists only what is left.
- Skipped versions still run. Going from 6.5.0 to 6.8.0 runs the 6.6.0, 6.7.0 and 6.8.0 migrations in order. The proxy is upgraded once, to the final implementation, so that implementation must keep the older initializers or one combined initializer that covers them.
- Ordering across contracts uses preconditions, for example margin engine at least 2.2.0 before futures 6.8.0.
- The fork simulation covers the whole sequence: the upgrade, every migration, then an empty `plan` and passing invariant checks.

## Safety rules

- A key missing from config is unmanaged.
- Owners come from the chain, never from config.
- Every call is dry-run from its owner before it is sent or proposed.
- Cross-parameter checks run in the apply task before anything is sent; ChainForm has no rules across resources:
  - the liquidation fee stays well below the margin engine's maintenance shock, because each liquidated unit improves the account by the shock minus the fee;
  - the venue's share of the liquidation fee covers the backstop unwind band plus the unwind fee;
  - the unwind band is wider than the market maker's half-spread, or unwinds never fill (warning only).
- The `plan` output is the review artifact. The Safe UI decodes the same calls for the signers.

## Layout

Each repo manages its own contracts: perps for perps, futures for futures, collateral-margin for the vault and the margin engine. One HCL file per environment (for example `params/dev.hcl`, `params/prd.hcl`) reads addresses and values from that repo's `config/<env>.env`. Commands along the lines of `pnpm params:plan --env prd` and `pnpm params:apply --env prd`.

## CI

- Pull request touching `config/*.env` or `params/`: run `plan` and post the diff. Read-only, no keys.
- Merge to `dev`: apply to dev.
- Merge to `main`: propose the lmn Safe batch.
- Nightly `plan` on both environments as a drift alarm.

Note that in futures, a change to `config/*.env` already triggers the notifications deploy and the oracle-update workflow.

## Rollout

1. Fork, add items 1 and 2, write the TypeScript apply task. First run: the pending fee change (taker fee 10 bps, liquidation fee 200 bps, liquidator share 20% on both venues), applied on dev and proposed as one six-call Safe batch on lmn.
2. Vault and margin engine settings in collateral-margin, the CI `plan`, and the nightly drift check.
3. Deploy and upgrade scripts stop setting parameters and call apply instead.
4. Upgrades: implementation addresses in config, the `proxy` resource, and the fork simulation in apply. The update scripts stop calling `upgradeToAndCall` themselves and end by opening the config pull request.
5. Migrations: the per-version migration folders, starting with today's initializers and `rebuild-order-aggregate-cache.ts` rewritten as migration files with done checks.

## Open questions

- Who owns the Go fork.
- Whether upstream accepts multi-value setters and proxy resources.
- Whether implementations keep every older initializer, or each release folds them into one combined initializer.
- Fix perps and futures `SAFE_OWNER_ADDRESS` to 0x57ac…, or rely on owners read from chain everywhere, including `update-perps.ts` and `update-futures.ts`.
- Move the lmn vault from the deployer EOA to the Safe. Vault settings would then go through Safe proposals too.
