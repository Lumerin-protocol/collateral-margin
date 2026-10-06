# Insurance fund debt

Trading works with an empty insurance fund. When a winner closes before the matching loser, the vault borrows the winner's profit from the shared pool. That borrow is timing debt. It is repaid when the loser closes, is liquidated, or settles. The exchange is only out of pocket when a loser cannot cover. That remainder is trader bad debt, and it is never repaid.

Winners are paid in full. The debt cap is a circuit breaker, not a haircut.

## How a shortfall is settled

Venues call `settleTransfer(from, to, amount)` on the vault.

- Trader payer (a loss, funding owed, or a fee): the vault moves `min(balance, amount)` and emits `BadDebt` for the rest. `traderBadDebtTotal` increases only when the receiver is the insurance fund. A fee shortfall is lost revenue, not a reserve loss.
- Backstop payer (`BACKSTOP_ADDR`, the ledger that inherits liquidated positions): same path as a trader. The ledger is unfunded, so a loss it realizes is almost always `BadDebt` in full. It counts in `traderBadDebtTotal` and is split out as `backstopBadDebtTotal` on the dashboard. See [protocol-liquidation-exposure.md](./protocol-liquidation-exposure.md).
- Insurance-fund payer (a winner's profit, or funding the fund owes): the vault pays the fund balance first, mints the rest to the winner, and adds it to `insuranceDebt`. There is no borrow limit, so the winner is always paid.

Any inflow to the insurance fund repays debt first. The repaid amount is burned. While `insuranceDebt > 0`, the fund balance is 0, so `withdrawInsuranceFund` cannot move money.

`insuranceCapital` is protocol capital: `depositInsuranceFund` minus `withdrawInsuranceFund`. The v1.2.0 upgrade seeds it from the fund balance already in the vault (`initializeV2`). It can go negative if more is withdrawn than was deposited.

```
uncoveredLoss = max(0, traderBadDebtTotal - insuranceCapital)
timingDebt    = max(0, insuranceDebt - uncoveredLoss)
```

Uncovered loss is the top-up the protocol owes the pool. Timing debt is backed by losers who are still in the market. It is expected, and it is not alarmed.

Backing invariant: the vault's USDC balance is at least `totalSupply - insuranceDebt`.

Worked example, empty fund and no capital:

1. A closes +20. Debt 20, uncovered 0, timing 20.
2. B's loss is 60 against a 50 balance. B pays 50, bad debt is 10, the payment clears the debt and leaves the fund with 30. Uncovered is 10.
3. C closes +40. The fund pays 30 and borrows 10. Debt 10, uncovered 10, timing 0.
4. Top up 10. Capital is 10, the debt is repaid, uncovered is 0.

## Halt

The halt latches in three ways:

- A borrow takes `insuranceDebt` above the effective cap. The crossing transaction completes and pays the winner, then latches the halt. A withdrawal later in that same transaction reverts the whole transaction, including the borrow.
- The owner calls `halt()`.
- `setMarginEngine(address(0))` while debt is outstanding. The effective cap is 0 while the margin engine is unset.

Lowering the cap below the current debt does not halt by itself. The next borrow does. The halt does not lift itself when debt falls back under the cap. `resume()` reverts unless `insuranceDebt` is at or under the effective cap.

While halted:

- `withdraw` and `withdrawTo` revert, including the venues' `withdrawCollectedFees`.
- Futures and perps reject `createOrder`, `createOrders`, and `updateOrders` that contain creates.
- Liquidations, expiry settlement, settlement-price recording, and perps funding stay live. Cancels, size reductions, outdated-order cleanup, deposits, insurance top-ups, `internalTransfer`, and `settleTransfer` stay live.
- Owner configuration, authorization, and upgrades stay live.

If the suspected bug is in liquidation, settlement, funding, or the oracle those paths use, revoke that venue with `setAuthorizedCaller(venue, false)`. Those paths keep running during a halt until the venue is revoked.

## Thresholds

There is no alarm on debt above 0, on how long debt lasts, or on a low fund balance. Those are the base case.

Amounts below are USDC on the `col-mar-vault-{env}` dashboard. Alarm text matches these actions. Notifications ship only when `vault_monitoring.notifications_enabled` is true.

| Signal | Severity | What to do |
| --- | --- | --- |
| Timing debt above 0 | none | Backed by open losers. Leave it. |
| Uncovered loss above 0 | critical | Top up exactly that amount with `depositInsuranceFund`. The alarm clears on its own. Never raise the cap to cover it. |
| Backstop equity below 0 | warning | Positions the backstop inherited from liquidations are losing at the mark. Nothing is booked yet; it becomes uncovered loss when the legs unwind, offset, or settle. Make sure unwinds are flowing (keeper `BACKSTOP_UNWIND_ENABLED`, or call `unwindBackstop`) and plan the top-up. Do not deposit into the backstop. |
| Utilization at or above 50% | warning | Confirm uncovered loss is 0 and the keeper and oracle are healthy. If it is only timing debt, raise the cap. |
| Utilization at or above 80% | critical | Same checks. Raise the cap or top up before a borrow crosses 100% and halts the vault. |
| Vault halted | critical | Follow [Resume](#resume). |
| Backing gap above 0 | critical | Accounting is wrong. Halt if needed, compare the subgraph with the contract views, and revoke both venues before changing anything. |
| Margin engine unset | critical | The effective cap is 0. Restore the engine, then resume if the vault halted. |
| Keeper unhealthy or silent | critical | Restart the keeper, let overdue liquidations run, then top up the uncovered loss they record. |
| Check success missing or 0 for 15 minutes | critical | The monitor, subgraph, or RPC is down. Value alarms are blind. |
| Subgraph older than 15 minutes, or indexing errors | critical | Read the contract views directly until the indexer is redeployed or resynced. |
| Oracle data age | dashboard only | Hashprice-oracle's own alarms own the response. A stale price makes margin checks revert, which is safe for the debt. |

Scheduled hashprice steps (difficulty retarget, about every two weeks, and the halving) are a calendar item, not an alarm. A step larger than maintenance margin takes accounts near liquidation below zero before the keeper can act. Before a large expected step, raise the margin shocks. Consider lowering the cap for that window so the vault halts sooner if losses build up.

### Where a top-up comes from

`depositInsuranceFund` is the top-up. It counts as `insuranceCapital` and repays debt first.

Fee balances (`FuturesFeeBalance`, `PerpsFeeBalance` on the dashboard) are the venues' vault balances. They can be withdrawn with `withdrawCollectedFees` and then deposited into the fund. That withdrawal reverts while the vault is halted, so fees cannot fund a top-up until after `resume()`. While debt is outstanding and the vault is not halted, check the dashboard before taking fees out: once withdrawn, they are no longer available if part of the debt turns out to be uncollectible.

A top-up against timing debt is not lost. As losers pay in, the fund balance grows again and can be taken back with `withdrawInsuranceFund`.

The backstop ledger's own balance (`BackstopBalance`) is profit from inherited positions that closed in the money. `withdrawBackstop(recipient, amount)` moves it out; deposit it into the fund with `depositInsuranceFund`. It reverts while halted, like every withdrawal.

## Resume

Only the Safe can resume. `contracts/scripts/vault-halt.ts` prints the debt state and sends the transaction when the deployer is the owner, otherwise it prints Safe calldata.

1. Find what tripped it. A `CAP` halt's `VaultHaltEvent` transaction is the payout that crossed the cap. Join the venue events in that transaction. An `OWNER` halt is explained by the incident notes. `NO_MARGIN_ENGINE` means the engine was cleared while debt was outstanding.
2. If it looks like a bug or a bad price, follow the incident playbook before resuming.
3. If uncovered loss is above 0, top up at least that amount. Do not raise the cap to cover it. That would reopen withdrawals with a hole the last users to withdraw would absorb.
4. Confirm the rest is timing debt. Check the keeper, let overdue liquidations and settlement run, and verify the oracle. `uncoveredLoss()` cannot see losses on accounts that have not been liquidated yet.
5. Raise the cap above the remaining debt (`contracts/scripts/set-insurance-debt-cap.ts`, which reads `INSURANCE_DEBT_CAP` from the env file) or top up the difference, then call `resume()`. Both can go in one Safe batch. The script refuses to resume while debt is above the effective cap, and it warns when uncovered loss is above 0.
6. A single party holding a large losing position open is a reason to raise the cap. Their locked loss backs the debt.
7. Re-authorize a venue if it was revoked, after the fix is in place.

## Incident playbook

While halted, no new trade can be initiated and no collateral can leave the vault. Liquidations, settlement, and funding continue unless the venue is revoked. The Safe owns the vault and both venues.

Levers:

- Halt trading and withdrawals: `vault.halt()`, or `vault-halt.ts halt`. Use it for bugs that do not push the debt past the cap.
- Stop a suspect venue: `vault.setAuthorizedCaller(venue, false)`. Every money movement on that venue then reverts. Do this immediately when the suspected bug is in liquidation, settlement, funding, or the oracle those paths use.
- Fix the price: `setOracle` on the venue and on the margin engine.
- Fix the code: upgrade the venue with `update-futures.ts` or `update-perps.ts`.
- Correct balances: a one-off vault upgrade whose initializer reverses a listed set of transfers, for example burning receipts a bug minted and reducing the debt by the same amount. Upgrade back afterwards. The list comes from the vault and venue events. It is written and reviewed per incident. There is no standing tool for it.
- Cover real losses: `depositInsuranceFund`.
- Resume: re-authorize the venue if it was revoked, then `resume()`.

By cause:

- Losses not recorded yet (late keeper, price gap). This is not necessarily a bug. Keep the halt on, restart the keeper, and let liquidations and settlement reduce exposure and record any bad debt. Liquidated quantity lands on the backstop; its loss is recorded when it unwinds or settles, so watch `BackstopEquity` too. Top up the final uncovered loss, then raise the cap if needed and resume.
- Residual exposure that no ledger holds (positions liquidated before the backstop existed, or a venue bug that broke conservation). While halted, the owner calls `forceClosePositions` on the venue to close the listed positions at the mark against the fund, then tops up `insuranceDebt`, then resumes. This is the migration path for the backstop upgrade and a last resort afterwards.
- Venue profit-and-loss bug. Fix and upgrade the venue, reverse the overpayments, then resume.
- Bug in liquidation, settlement, or funding. Revoke the affected venue immediately. Fix and upgrade it, correct affected transfers, then re-authorize and resume.
- Wrong but fresh oracle price. Halt, revoke every venue using that oracle so liquidations and settlement stop, fix the oracle, reverse fake payouts, and compensate wrongly liquidated accounts before re-authorizing and resuming.
- Backing gap. The accounting itself is wrong. Revoke both venues and investigate before doing anything else.

## Bad debt recorded before this upgrade

Venue `BadDebt` logs from before the vault upgrade stay on-chain and are not migrated into `traderBadDebtTotal`. The venue subgraphs no longer index that event. These are the rows that existed when the handlers were removed:

| Env | Venue | Amount (6 decimals) | USDC | Transaction | Block | User |
| --- | --- | --- | --- | --- | --- | --- |
| dev | futures | 26667395 | 26.667395 | `0x7ca6da3045349b36ce72a9974690fdaa378c55c094aa1d59bafded626988c595` | 46251515 | `0x1441bc52156cf18c12cde6a92ae6bde8b7f775d4` |
| lmn | perps | 79963 | 0.079963 | `0x07bfb3a752eecf8d6fef5204af35bbe0eadaecc31f24459d5a5fd5bc3e936c08` | 51691874 | not set on the subgraph row |

Dev perps and lmn futures had no `BadDebtEvent` rows. New shortfalls are only on the vault, as `BadDebt` with the venue in the event.

## Rollout

Dev first, then lmn.

1. Upgrade the vault with the cap at 0, calling `initializeV2` in the same transaction (`update-collateral-vault.ts` passes that calldata to `upgradeToAndCall`). Behavior matches today, because the venues still call `internalTransfer` until they are upgraded.
2. Redeploy the vault indexer.
3. `terragrunt apply` with `vault_monitoring.notifications_enabled = false`. Check that the dashboard shows debt at 0, a fresh subgraph, a backing gap of 0, and not halted.
4. Set the cap with `set-insurance-debt-cap.ts` (Safe calldata on lmn). This has to happen before the venue upgrades. With the cap at 0, the first winning close against an empty fund halts the exchange.
5. Upgrade futures and perps, then redeploy those indexers without bad-debt tracking. The venue packages must depend on the collateral-margin commit that contains `settleTransfer`. A local `file:` link is only for compiling before that commit exists.
6. On dev, test the cycle: withdraw the fund to 0 and run the worked example; lower the cap below the debt and make a winning close, and confirm the triggering transaction finishes and the vault halts; confirm new orders, fee withdrawals, and user withdrawals revert, and that cancels, reductions, cleanup, liquidations, settlement, funding, deposits, top-ups, and owner recovery remain available; confirm revoking a venue stops its liquidation and settlement; raise the cap, `resume()`, and confirm orders and withdrawals work; then check `halt()` and `resume()` by hand.
7. Turn notifications on (`notifications_enabled = true` and apply).

The options payout path is not part of this. It is not deployed.
