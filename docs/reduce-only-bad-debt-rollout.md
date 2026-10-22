# Rollout: reduce-only bad-debt fix

This release stops reducing orders from booking bad debt. It ships engine 2.2.0 and venues 6.8.0 in three PRs: [collateral-margin#98](https://github.com/Lumerin-protocol/collateral-margin/pull/98), [derivatives-marketplace#116](https://github.com/Lumerin-protocol/derivatives-marketplace/pull/116) (perps) and [futures-marketplace#325](https://github.com/Lumerin-protocol/futures-marketplace/pull/325). The vault does not change.

| Contract | dev before | lmn on chain | Target |
| --- | --- | --- | --- |
| `PortfolioMarginEngine` | 2.1.0 | 2.1.0 | 2.2.0 |
| `HashPowerPerpsDEX` | 6.7.0 | 6.5.0 | 6.8.0 |
| `HashPowerFutures` | 6.7.0 | 6.5.0 | 6.8.0 |
| `CollateralVault` | 1.3.0 | 1.1.0 | 1.3.0, from the backstop release |

The lmn column was read from the chain on 2026-10-06; `main` holds newer code than lmn runs. Each update script prints the deployed version before it asks to proceed.

## Ordering rules

- The engine goes first in every environment. Venues 6.8.0 call `reduceLimits` and `meetsTradeMargin` on every order, so every order reverts against a 2.1.0 engine. `update-perps.ts` and `update-futures.ts` refuse to run until the venue's wired engine is at 2.2.0 or later.
- Engine 2.2.0 works with 6.6.0 and 6.7.0 venues. It only adds views and removes `setVault`, so it can go out ahead of them. lmn runs 6.5.0, which should behave the same; confirm it on a Base fork before executing the engine upgrade.
- Perps and futures can go in either order. Each stays exploitable until it is upgraded, so upgrade them back to back.
- Rollback runs the other way: venues first, then the engine.

## Before you start

- Run the scripts from each repo's `contracts/` directory. `--env dev` or `--env prd` loads that repo's `config/<env>.env`, which holds the addresses and the network; lmn is `--env prd`. Put secrets in `.env` at the repo root or in `contracts/`: `PRIVATE_KEY`, `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY`, and `SAFE_API_KEY` for the lmn venue proposals.
- Record each proxy's current implementation, for rollback:

  ```bash
  cast implementation <proxy> --rpc-url <rpc>
  ```

- On lmn, one Safe owns the engine, both venues and the vault: `0x57ac51Ad8b3B5a95e655eD2AF98D9881B136f924`, 2-of-3. `SAFE_OWNER_ADDRESS` in each repo's `config/prd.env` names it; perps and futures got it in [derivatives-marketplace#117](https://github.com/Lumerin-protocol/derivatives-marketplace/pull/117) and [futures-marketplace#326](https://github.com/Lumerin-protocol/futures-marketplace/pull/326). Every owner action, including `halt()` and `resume()`, needs two signatures.
- Both venue scripts propose Safe upgrades from the deployer key, which is a registered proposer on that Safe. `update-futures.ts` gained this fallback in futures-marketplace#325; before it, the script always threw on lmn.

## 1. Merge into dev

1. Merge collateral-margin#98. This publishes `@hashpower/collateral-abi` on the npm `dev` tag and redeploys the dev keeper, because the PR touches a keeper test file. The keeper code does not change.
2. Merge derivatives-marketplace#116 and futures-marketplace#325. Each publishes its ABI package on `dev`. The venue ABIs are unchanged except for the vendored engine interface, which gains two functions. Both PRs already pin `collateral-margin` to `d4b3dac`, the commit in #98.

No subgraph needs redeploying, because no indexed event changes.

## 2. Upgrade dev

The deployer owns every dev contract, so each script upgrades directly. It prompts before each transaction.

1. Engine, from `collateral-margin/contracts`:

   ```bash
   pnpm hardhat --env dev run scripts/update-portfolio-margin-engine.ts
   ```

   The script builds the implementation with the proxy's current vault. Expect 2.1.0 before and 2.2.0 after. It throws if the vault changed.

2. Perps, from `perps/contracts`:

   ```bash
   pnpm hardhat --env dev run scripts/update-perps.ts
   ```

   Expect 6.7.0 to 6.8.0 with both initializers skipped.

3. Futures, from `futures-marketplace/contracts`:

   ```bash
   pnpm hardhat --env dev run scripts/update-futures.ts
   ```

   Leave `MARGIN_ENGINE_ADDRESS` unset, because setting it also switches the venue's engine.

4. Check on dev:
   - Reproduce the exploit with two test accounts. A opens a long well above the mark, B rests a bid far below it, and A sells part of the long into B's bid. Expect `InsufficientMarginBalance` and no `BadDebt` event on the vault.
   - An account below maintenance can still close part of its position at the mark.
   - The keeper still liquidates, and the backstop unwind still fills.
   - The market maker keeps quoting, with no `InsufficientMarginBalance` reverts in its logs.
   - Orders resting from before the upgrade skipped the new check. An off-market reducing order its owner could not pay puts the account below maintenance, so the keeper cancels it. Confirm no such order is left.

## 3. Promote to main

Open dev-to-main PRs in all three repos. `main` is still on the pre-backstop release, so these PRs also carry vault 1.3.0 and the 6.7.0 venue code. The lmn rollout therefore includes the backstop migration.

Merging into `main` changes lmn immediately. The lmn keeper redeploys from `main`, and the ABI packages publish on `latest`. `@hashpower/collateral-abi` takes a major bump, because `setVault` and `VaultUpdated` are removed. Time the merges with the window in step 4, because the backstop migration releases the keeper only at its step 6.

## 4. Upgrade lmn

Run this inside the backstop migration window from [protocol-liquidation-exposure.md](./protocol-liquidation-exposure.md#migration-of-pre-existing-implicit-exposure), with these changes:

1. Upgrade the engine before the window opens:

   ```bash
   pnpm hardhat --env prd run scripts/update-portfolio-margin-engine.ts
   ```

   The deployer is not the owner, so the script deploys and verifies the implementation and prints the `upgradeToAndCall` calldata. Execute that from the Safe. Confirm `VERSION()` is 2.2.0 and `vault()` is unchanged. The 6.5.0 venues keep working.

2. In the migration's step 2, halt and upgrade the vault from the Safe:

   ```bash
   pnpm hardhat --env prd run scripts/vault-halt.ts -- halt        # in collateral-margin/contracts
   pnpm hardhat --env prd run scripts/update-collateral-vault.ts
   ```

   Both print Safe calldata; batch them into one Safe transaction. The vault is on 1.1.0, so the upgrade calls `initializeV2`, which records the insurance fund balance as insurance capital.

   Then upgrade the venues straight to 6.8.0 instead of 6.7.0:

   ```bash
   pnpm hardhat --env prd run scripts/update-perps.ts     # in perps/contracts
   pnpm hardhat --env prd run scripts/update-futures.ts   # in futures-marketplace/contracts
   ```

   With `SAFE_OWNER_ADDRESS` set, each script deploys the implementation and proposes the upgrade to the venues' Safe. The engine-version check reads the chain when the script runs, so the engine's Safe transaction must already be executed. `update-perps.ts` includes whichever initializers the proxy still needs; futures has none. Execute the two proposals back to back.

3. Finish the migration as written: settle every account, deposit, release the keeper and indexers, then `resume()`.

4. Check that both venues report 6.8.0, the market maker is quoting, and voluntary closes after the window emit no `BadDebt`.

5. Turn on unwinding. With the backstop params at 0, an unwind fills only at the mark or better, and the market maker quotes 7–10 bps away, so the backstop keeps every leg it takes. Perps legs never expire. From the Safe, call `setBackstopParams(50, 5)` on the vault. Then set `BACKSTOP_UNWIND_ENABLED=true` and the `BACKSTOP_UNWIND_MAX_QTY_*` limits on the lmn keeper.

6. Propose the fee batch to the Safe. On both venues, call `setTakerFeeBps(10)`, `setLiquidationFeeBps(200)` and `setLiquidatorShareBps(2000)`. The liquidation fee is sized to cover backstop unwinds, so it waits for 6.8.0.

## Rollback

- Venues: the owner calls `upgradeToAndCall(<previous implementation>, 0x)`. On dev, the previous implementation is 6.7.0. On lmn it is 6.5.0, which predates the backstop migration, so roll forward instead, or deploy a 6.7.0 implementation from `dev` before these PRs.
- Engine: roll back only after both venues are below 6.8.0. The 2.1.0 implementation still works, because 2.2.0 never clears the old vault and decimals storage slots.
