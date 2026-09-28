# Protocol exposure created by forced liquidation

## Status

Design note. The mechanisms proposed below are not implemented.

This document complements [liquidation-orchestration.md](./liquidation-orchestration.md).
That document describes how an underwater account is selected and reduced. This
document covers the other side of the operation: who owns the position after a
forced close, how protocol exposure is measured, and how the protocol exits it.

## Problem

Futures and Perps currently liquidate a position at the oracle mark by:

1. realizing the user's PnL against the insurance fund;
2. reducing or deleting the user's position; and
3. not assigning the closed quantity to another market participant.

Normal trades conserve position quantity because one participant buys and
another sells. A forced liquidation does not. Once one user's position is
removed, the remaining users can have non-zero aggregate delta. The exchange is
the implicit counterparty to that residual delta even though no protocol
position is stored.

Example:

1. A is long 1 at 100 and B is short 1 at 100.
2. A is liquidated at 80 and pays 20 to the insurance fund.
3. B remains short 1. Economically, the exchange is now long 1 from 80.
4. If B later closes at 70, B receives 30. The fund received 20 from A and pays
   30 to B, realizing a 10 loss: the exchange's long lost 10 from 80 to 70.

Normal trading can move B's short to another trader, but it cannot eliminate
the exchange's implicit long. Futures exposure ends at expiry when all
positions settle. Perpetual exposure has no natural expiry and can persist
indefinitely.

Insurance debt and protocol exposure are different:

- `insuranceDebt` measures receipt tokens issued without matching vault
  collateral.
- Protocol position exposure measures future PnL caused by unmatched aggregate
  user delta.

Debt can be zero while the exchange has material directional exposure.

## 1. Current exposure visibility

### Current state

There is no explicit protocol position, protocol net delta, or protocol entry
value in either venue. The vault balance, insurance-fund balance, and proposed
insurance-debt fields do not reveal this exposure.

Exposure can be reconstructed off-chain from indexed user positions:

```text
protocolNetPosition = -sum(all user net positions)
```

For Futures this must be calculated separately for every expiry. For Perps it
is one signed net quantity. An indexer can derive the value, but the contract
cannot enforce limits against an off-chain-only figure.

### Required visibility

At minimum, publish:

- protocol net quantity per venue and, for Futures, per expiry;
- protocol net entry value and average entry price;
- mark-to-market protocol PnL;
- gross quantity assumed through fallback liquidations;
- quantity exited through market trades, auctions, expiry, and ADL;
- age of the oldest open protocol exposure;
- configured exposure limit and utilization;
- realized protocol PnL from exposure exits.

The preferred invariant is:

```text
sum(user net positions) + protocol net position = 0
```

This should be checked per Perps market and per Futures expiry.

### On-chain representation

Use an explicit protocol/backstop position rather than deriving exposure only
in the indexer. It can be represented by either:

- a dedicated `BACKSTOP_ACCOUNT` using the venue's normal position accounting;
  or
- separate protocol-position storage with the same quantity and exact entry
  value fields as user positions.

Separate storage is clearer if the backstop needs special margin, funding,
authorization, or exit rules. The insurance-fund ledger address should not
silently acquire positions unless all of those semantics are defined.

## 2. Liquidate against the market first

The primary liquidation path should close the user's position against real
order-book liquidity. This preserves position conservation and avoids creating
protocol exposure.

Suggested flow:

1. Confirm the account is below portfolio MM.
2. Cancel its resting orders.
3. Calculate a risk-reducing close quantity.
4. Submit a forced reduce-only IOC order on the user's behalf.
5. Match at available book prices within a configured slippage bound.
6. Recompute portfolio health after the fill.
7. Repeat in gas-bounded chunks until the account is restored or liquidity is
   exhausted.

Requirements:

- The forced order can only reduce the existing position and cannot flip it.
- Execution uses actual matched prices, not an assumed oracle fill.
- A mark-based limit bounds slippage and prevents a manipulated thin book from
  taking the whole position at an arbitrary price.
- Partial fills are valid and observable.
- Existing position/PnL accounting is reused so the matched counterparty
  explicitly owns the other side.
- The final portfolio-level over-liquidation guard still applies.

The keeper may choose the price limit, but the contract must enforce a
governance-configured maximum deviation from the accepted oracle mark.

## 3. Exchange fallback

If market liquidity cannot close enough quantity, the exchange can assume the
residual as an explicit fallback.

For residual quantity `q` at fallback mark `P`:

1. Realize the user's closed-slice PnL at `P`.
2. Reduce the user's position by `q`.
3. Increase the protocol position by the same signed `q`, with entry value
   based on `P`.
4. Emit one event linking the user reduction and protocol acquisition.

The protocol position has the same direction as the liquidated user's removed
position. It starts with zero unrealized PnL at `P`; subsequent price movement
belongs to the protocol until the position is exited.

Fallback controls:

- per-transaction and total protocol-exposure limits;
- per-venue and per-expiry limits;
- optional owner-controlled enable/disable switch;
- stricter limit while the vault is halted;
- explicit behavior when the limit is exhausted;
- no fallback at a malformed oracle price;
- liquidation fee based only on quantity actually closed.

The fallback limit is distinct from the insurance-debt cap. Both can be
breached independently and require separate monitoring.

## 4. Removing exchange exposure

Protocol exposure must have an executable exit path. Merely waiting for normal
user trading moves the unmatched user position between users and does not
guarantee that the protocol delta disappears.

### Preferred: market unwind

An authorized backstop keeper places reduce-only IOC orders for the protocol
position:

- never increase or flip protocol exposure;
- enforce oracle-relative slippage limits;
- unwind gradually to avoid moving a thin book;
- account for realized PnL against the insurance fund;
- emit protocol-exit events for monitoring.

### Position auction

Auction all or part of the protocol position to market makers or backstop
participants. The winning bidder takes the position and receives any explicit
incentive. This provides price discovery when the visible order book is too
thin for an immediate unwind.

### Futures expiry

A Futures protocol position can be held to expiry and settled at the same
pinned settlement price as user positions. This guarantees eventual closure,
but the insurance fund bears the mark movement until expiry.

### ADL as last resort

Auto-deleveraging can reduce the protocol position against profitable users on
the opposite side. It should be a last resort with deterministic ranking,
bounded quantity, explicit events, and clear user-facing policy because it
forcibly closes otherwise healthy positions.

### External hedge

The operator may hedge the protocol delta on an external venue. This reduces
economic risk but adds custody, basis, execution, and operational risk. It does
not replace the on-chain protocol-position record or exit accounting.

## Proposed liquidation state machine

```text
UNDERWATER
  -> cancel resting orders
  -> market reduce-only close
       -> healthy: DONE
       -> partial/no liquidity: FALLBACK
  -> transfer residual to explicit protocol position
  -> user healthy or fully closed: USER DONE
  -> protocol market unwind / auction / expiry / ADL
  -> protocol position zero: EXPOSURE DONE
```

## Required invariants

- Market liquidation transfers quantity between participants and does not
  increase absolute protocol exposure.
- Fallback liquidation changes the protocol position by exactly the quantity
  removed from the user.
- User aggregate quantity plus protocol quantity is conserved per market and
  Futures expiry.
- Protocol exits cannot increase or flip exposure unless governance explicitly
  opens a new fallback position.
- Protocol PnL is realized exactly once.
- Insurance debt, bad debt, and protocol position PnL remain separately
  observable.
- A vault halt does not hide protocol exposure or reset its limits.

## Open decisions

- Whether the protocol position uses a dedicated account or separate storage.
- Market-close slippage limits and chunk sizes.
- Perps and per-expiry Futures exposure limits.
- Whether protocol Perps positions participate in funding.
- Auction design and incentive source.
- ADL trigger, ranking, and user compensation policy.
- Whether position fallback remains available while the insurance-debt cap is
  already exceeded.
- Whether stale-but-previously-valid oracle prices may be used for fallback
  liquidation, and how the margin engine and venue pin the same oracle round.
