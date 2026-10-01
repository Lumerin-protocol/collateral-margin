# Protocol exposure created by forced liquidation

## Status

Implemented (vault 1.3.0, futures 6.7.0, perps 6.7.0): liquidation hands the
closed quantity to an explicit, keyless **protocol backstop** ledger, and a
permissionless `unwindBackstop` reduces it against the book for a fee. The
"liquidate against the book first" path in [Step 2](#step-2-book-first-liquidation)
is not implemented; this document records it as the next iteration.

This document complements [liquidation-orchestration.md](./liquidation-orchestration.md).
That document describes how an underwater account is selected and reduced. This
document covers the other side of the operation: who owns the position after a
forced close, how protocol exposure is measured, and how the protocol exits it.
The insurance-fund side (debt, halt, top-ups) is in
[insurance-debt.md](./insurance-debt.md).

## Problem

Before this change Futures and Perps liquidated a position at the oracle mark by
realizing the user's PnL against the insurance fund and deleting the user's
position, without assigning the closed quantity to anyone. Normal trades
conserve position quantity; a forced close did not. Once one user's position was
removed, the remaining users had non-zero aggregate delta and the exchange was
the implicit counterparty, with no stored position, no entry price and no
visibility.

Example:

1. A is long 1 at 100 and B is short 1 at 100.
2. A is liquidated at 80 and pays 20 to the insurance fund.
3. B remains short 1. Economically, the exchange is now long 1 from 80.
4. If B later closes at 70, B receives 30. The fund received 20 from A and pays
   30 to B, realizing a 10 loss: the exchange's long lost 10 from 80 to 70.

Insurance debt and protocol exposure are different: `insuranceDebt` measures
receipt tokens issued without matching vault collateral; exposure measures
future PnL caused by unmatched aggregate user delta. Debt can be zero while the
exchange has material directional exposure.

## The backstop ledger

`CollateralVault.BACKSTOP_ADDR` (`0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB`) is a
vanity address with no key, like `INSURANCE_FUND_ADDR`. Both venues read it from
the vault at construction (`BACKSTOP` immutable) and use their ordinary position
accounting for it: `positions[BACKSTOP][expiry]` on futures,
`positions[BACKSTOP]` on perps, exact signed `netEntryValue` like any user.

It is a separate ledger from the insurance fund on purpose. The fund is the
clearing counterparty for PnL and the store of protocol capital; the backstop is
a position book. Keeping them apart means the fund balance keeps meaning "money
available for a top-up" and the backstop's exposure is visible as a position,
not as a drift in the fund.

The backstop cannot be a user: `liquidatePosition(s)`, `liquidateOrder(s)` and
the futures liquidation preflight revert `BackstopAccount` for it, it never
places orders except through `unwindBackstop`, and there is no margin check on
it. It is exempt from the taker fee on unwind fills (an unfunded ledger would
emit an uncollectable `BadDebt` per fill otherwise); makers keep their normal
rebate and points.

### Hand-off on liquidation

`liquidatePosition` / `liquidatePositions` price the close at the mark exactly as
before: the user's slice PnL is settled against the insurance fund, the user's
position shrinks or is deleted, `PositionLiquidated` is emitted. Then the closed
signed quantity is applied to the backstop at the same mark with the **user's
sign** (`_handOffToBackstop`), and `BackstopAssigned(user, [expirationAt,]
quantity, price)` is emitted.

So in the example above the backstop is long 1 from 80. B's short is matched
again. When B closes at 70 the fund pays B 30; the backstop's long from 80 is
carrying the 10 loss and books it when the leg leaves the ledger.

Applying to the backstop goes through the same position math as a fill
(`_applyFill` on futures, `_updateUserPosition` on perps), so a hand-off that
opposes what the backstop already holds nets down and realizes PnL against the
fund at the hand-off mark. Two opposite liquidations therefore cancel on the
ledger. On perps the backstop's funding is settled before the hand-off, so the
new quantity does not inherit accrued funding.

Conservation now holds on-chain:

```text
sum(user net positions) + backstop net position = 0
```

per perps market and per futures expiry. The contracts hold it by construction
(every fill and every backstop hand-off moves quantity between two accounts);
the venue invariant tests assert it.

### Matured futures legs

A futures position whose expiry has passed is not liquidated:
`liquidatePosition` reverts `PositionMatured`, `liquidatePositions` skips the
leg, and the keeper filters matured legs out of `reduceToTarget`. The leg is
settled by `settlePosition` at the pinned settlement price, which is the
correct exit; liquidating it at the current mark would move value to or from the
backstop for no reason. The backstop's own matured legs settle the same way as
anyone's.

### Perps funding

The backstop pays and receives funding like any position. Its funding is
settled on hand-off and on unwind. Funding it owes is paid through
`settleTransfer(BACKSTOP, fund, …)` and, because the ledger is unfunded, lands
as `BadDebt` with `payer = BACKSTOP_ADDR`. Funding it earns accrues to its vault
balance.

## Unwinding

`unwindBackstop(expirationAt, qty)` on futures and `unwindBackstop(qty)` on perps
are permissionless. The caller picks the quantity; the contract:

1. Reads `(unwindBandBps, unwindFeeBps)` from `vault.backstopParams()`. These
   are one global pair on the vault, set by the owner with
   `setBackstopParams`, bounded by `MAX_BACKSTOP_PARAM_BPS = 2 500`.
2. Places an IOC order for the backstop that reduces its position, never flips
   it (`min(qty, |net|)`), limited to `mark ± band` rounded to the tick
   (`_bandPrice`). A buy to cover a short is limited above the mark, a sell to
   close a long below it.
3. Reverts `TimeInForceNotFilled` if nothing filled, so a failed attempt costs
   only gas.
4. Pays the caller `min(mark × filled × feeBps / BPS, venue fee pot)` from the
   venue's collected fees (`_internalTransfer(venue, caller)`), and emits
   `BackstopUnwound(caller, [expirationAt,] filledQuantity, fee)`.

All zeros is the safe default: unwinds fill only at or better than the mark and
pay no fee. Widening the band gives up more slippage per contract in exchange
for more of the book; the fee is what makes running an unwinder worth the gas.

The fill is an ordinary match: the maker is a real user, the backstop is the
taker, `OrderMatched` fires, points and maker fees apply. The venue subgraphs
index it as a normal `Trade`/`Fill` for the backstop with the `BackstopUnwind`
row next to it.

The keeper ships an optional unwinder (`BACKSTOP_UNWIND_ENABLED`,
`BACKSTOP_UNWIND_INTERVAL_MS`, `BACKSTOP_UNWIND_MAX_QTY_FUTURES`,
`BACKSTOP_UNWIND_MAX_QTY_PERPS`) that walks the backstop's open legs, skips
matured ones, and sends `unwindBackstop` for up to the configured quantity per
leg per tick. It is off by default. Because the function is permissionless,
anyone can run their own.

Other exits: a futures leg can simply be held to expiry, where it settles at the
pinned price. An opposite liquidation nets it. There is no auto-deleveraging and
no auction; both were considered and left out (see
[Decisions](#decisions-taken)).

## Accounting: where the backstop's PnL goes

The backstop is left **unfunded**. Its vault balance starts at zero and nobody
deposits into it. Consequences:

- A loss the backstop realizes (unwind below its entry, an opposite hand-off,
  futures settlement against it, perps funding owed) is settled with
  `settleTransfer(BACKSTOP, fund, amount)`. The vault moves what the ledger has
  (usually nothing) and emits `BadDebt(payer = BACKSTOP_ADDR, receiver = fund)`.
  It counts in `traderBadDebtTotal`, and therefore in `uncoveredLoss`, exactly
  like a trader who could not cover. The vault indexer splits it out as
  `backstopBadDebtTotal`, on the vault and per venue.
- A gain accrues to the backstop's vault balance. The owner sweeps it with
  `withdrawBackstop(recipient, amount)` (`BackstopWithdrawn`), typically into
  the insurance fund via `depositInsuranceFund`.
- A loss is only booked when it is realized. While the backstop carries a losing
  leg, `uncoveredLoss` does not see it. The monitor's `BackstopEquity`
  (`balance + unrealized PnL at the mark + pending funding`, from the venues'
  `getRiskView(BACKSTOP)`) is the early signal; it alarms when negative.

The top-up for a realized backstop loss is the same as for any uncovered loss:
`depositInsuranceFund` for that amount, per
[insurance-debt.md](./insurance-debt.md#thresholds). Nothing is deposited into
the backstop itself.

## Migration of pre-existing implicit exposure

Positions liquidated before this upgrade left implicit exposure that no ledger
holds. There is no seeding step that reconstructs it into the backstop; every
account is settled out instead so both venues start from a conserved book. Dev
runs the identical procedure first as the rehearsal for production; `resetState`
is used only to cancel resting futures orders on accounts that are already flat.

Inside one maintenance window, per environment:

1. Inventory from the venue subgraphs: accounts with a futures pointer per
   expiry (split matured / live), perps positions, resting orders. Snapshot
   `insuranceDebt`, `insuranceCapital`, `traderBadDebtTotal`, and
   `sum(pointers)` per market.
2. `halt()` the vault. Upgrade the vault (1.3.0, backstop params 0), then both
   venues (6.7.0).
3. Settle everyone: `settlePositions` for matured futures legs (pinned price,
   permissionless); the new owner-only `forceClosePositions(users[,
   expirationAts])` for live futures legs and for perps, which requires
   `vault.halted()`, closes at the mark against the fund with no hand-off and
   no fee, emits `PositionLiquidated` with the caller as liquidator, and
   reverts `PositionMatured` for a matured leg. Include `BACKSTOP_ADDR` if a
   liquidation between the venue upgrade and this step gave it a leg. Then
   futures `resetState(accountsWithOrders)` to cancel resting orders; accounts
   are flat, so it only emits `OrderCancelled`. Verify every pointer is 0 and
   the backstop is flat.
4. `setFutureExpirationDatesCount(3)` on futures. The window shrinks from 5 to
   3 delivery dates as part of this migration; it must happen after step 3,
   because a shrink unlists the two furthest dates and `resetState` only walks
   the listed window. `.env.dev` / `.env.prd` carry
   `FUTURE_DELIVERY_DATES_COUNT=3` so a redeploy matches.
5. `depositInsuranceFund(insuranceDebt)`. The backstop is left unfunded.
6. Release keeper (unwinder off), indexers, UI, monitoring; `resume()`.
7. Dev only: exercise a liquidation, an unwind, and an expiry settlement
   against the backstop with test accounts and confirm the indexers, UI panel
   and dashboard agree before opening the production window.

Both venues lost two inert admin functions to stay under the EIP-170 bytecode
limit: futures `dropActiveOrders` and `setLiquidationMarginPercent`. Neither
had an effect on the live contracts.

## Visibility

On-chain:

- `getUserPosition(BACKSTOP[, expirationAt])`, `getActiveExpirationDates(BACKSTOP)`,
  `getRiskView(BACKSTOP)` (unrealized PnL, pending funding).
- `vault.balanceOf(BACKSTOP_ADDR)`, `vault.backstopParams()`.
- Events `BackstopAssigned`, `BackstopUnwound`, `BackstopWithdrawn`,
  `BackstopParamsSet`, and `BadDebt` with `payer = BACKSTOP_ADDR`.

Indexers:

- Venue subgraphs: the backstop is a `User`; a hand-off is a `Trade` flagged
  `isBackstopAssignment` with `backstopFromUser`, with no `Fill`; an unwind is a
  normal taker `Trade`/`Fill` plus a `BackstopUnwind` row.
- Vault subgraph: `Vault.backstopAddress`, `backstopBalance`,
  `backstopWithdrawn`, `backstopBadDebtTotal`, `backstopUnwindBandBps`,
  `backstopUnwindFeeBps`; `VaultVenue.backstopBadDebtTotal`;
  `BadDebtEvent.isBackstop`; `VaultWithdrawal.isBackstop`;
  `BackstopParamsChange`.

UI: the contract-specs modal has a "Protocol backstop" section (open legs with
entry, ledger balance, band, fee) for each venue, and the public trades feed
tags liquidation and backstop prints.

Monitoring (`col-mar-vault-{env}` dashboard, [monitor/](../monitor/src/index.ts)):

| Metric | Meaning |
| --- | --- |
| `BackstopEquity` | balance + unrealized PnL + pending funding at the subgraph block. Warning alarm below 0. |
| `BackstopBalance`, `BackstopUnrealizedPnl`, `BackstopPendingFunding` | The parts of equity. |
| `BackstopBadDebtTotal` | Realized backstop losses, vault-wide and per venue. Included in `TraderBadDebtTotal` and `UncoveredLoss`. |
| `BackstopFuturesNetQuantity` (total and per `ExpirationAt`), `BackstopPerpsNetQuantity`, `BackstopOpenLegs` | Exposure in raw units. |
| `BackstopUnwindBandBps`, `BackstopUnwindFeeBps` | Current parameters. |

## Operating the backstop

- Backstop equity negative: a loss is forming. Confirm unwinds are flowing (the
  keeper unwinder, or run `unwindBackstop` by hand), consider widening the band
  or raising the fee for the episode, and expect an uncovered-loss top-up when
  the legs unwind or settle. Do not deposit into the backstop.
- Uncovered loss rises after a backstop unwind or settlement: top up the fund
  by that amount. Same runbook as a trader shortfall.
- Backstop balance positive: sweep with `withdrawBackstop` into the fund when
  convenient. It is also margin-free collateral for nothing, so there is no
  reason to leave it.
- Parameters: `setBackstopParams(bandBps, feeBps)` on the vault applies to both
  venues at once. Start at `(0, 0)` and raise only when the ledger has legs that
  the book is not taking at the mark.

## Step 2: book-first liquidation

Not implemented. The hand-off at the mark keeps today's liquidation price and
guard semantics; the trade-off is that every liquidation creates backstop
exposure that then has to be unwound, and the unwind pays a fee and slippage
that a book-first close would not.

The next iteration would, inside `liquidatePosition(s)`, first submit a
reduce-only IOC for the user at `mark ± band` against the live book, realize the
user's PnL at actual fill prices, and hand only the unfilled residual to the
backstop at the band edge. Requirements carried over from the original design:

- The forced order can only reduce the existing position and cannot flip it.
- Execution uses matched prices; the band bounds a manipulated thin book.
- Partial fills are valid and observable; existing fill accounting is reused so
  the counterparty explicitly owns the other side.
- The portfolio-level over-liquidation guard still applies at the end.
- The keeper's off-chain close simulators need a book model, or the guard has to
  tolerate the difference between the mark and the fills.

Priority fills for the backstop (letting an unwind take the book ahead of
resting takers at the same price) belong to the same step.

## Invariants

- Liquidation changes the backstop by exactly the signed quantity removed from
  the user, at the same price the user was closed at.
- User aggregate quantity plus backstop quantity is zero per perps market and
  per futures expiry.
- `unwindBackstop` never increases or flips backstop exposure, never fills
  outside the band, and pays at most the venue's fee pot.
- Backstop PnL is realized once, through the same settlement paths as a user's.
- Insurance debt, trader bad debt, backstop bad debt and backstop position PnL
  remain separately observable.
- A vault halt does not hide backstop exposure; unwinds keep working while
  halted, `withdrawBackstop` does not.

## Decisions taken

- Dedicated `BACKSTOP_ADDR` ledger, not separate storage and not the insurance
  fund. The venues' existing position math applies unchanged.
- One global `(band, fee)` pair on the vault rather than per-venue or
  per-expiry parameters.
- No exposure cap. Liquidation must always be able to complete; a cap would
  turn a liquidation into a revert at the worst moment.
- No auto-deleveraging and no auction. Exits are the book (via `unwindBackstop`),
  netting against opposite liquidations, and futures expiry.
- The backstop participates in perps funding.
- No margin check on the hand-off; the backstop has no collateral by design.
- Backstop stays unfunded; its losses are ordinary uncovered loss and its gains
  are swept to the fund.
- No seed of legacy residual exposure; it is force-closed while halted instead.
