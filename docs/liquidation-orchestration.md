# Liquidation orchestration under shared collateral

This note captures how the keeper drives **liquidate-to-IM-buffer** liquidations
across Futures and Perps when a single `CollateralVault` balance backs positions
on *both* venues, and why the mechanism is designed the way it is. It is the
reference for the `reduceToTarget` venue surface, the coordinator/planner loop,
gas-bounded chunking, and the keeper-incentive (fee) model.

## The problem

- **Trigger vs. target are different margins.** An account becomes liquidatable
  when its portfolio balance drops **below Maintenance Margin (MM)**. But we do
  not want to fully liquidate — we want to close *just enough* to bring it back
  into the **Initial Margin (IM) buffer**, i.e. land the balance in the
  `[MM, IM]` band. Fully closing every underwater account is bad UX and bleeds
  users through unnecessary realized losses + fees.

- **Collateral is shared.** `computePortfolioMM(user)` / `computePortfolioIM(user)`
  are portfolio-level (perps net position + each futures lot + options), read
  against **one** vault balance. Closing part of a position on Perps changes the
  *portfolio* IM/MM and therefore changes whether the Futures leg still needs to
  be touched — and vice-versa. The venues are **not** independent.

- **Gas is bounded.** A whale can hold many futures lots (up to
  `MAX_ORDERS_PER_PARTICIPANT`-adjacent counts of positions) or a large perps
  net position plus a flood of small resting orders. A single "close everything
  needed" transaction can exceed the block gas limit.

## Target behaviour

For an underwater account the keeper closes **worst-first** exposure until the
portfolio balance re-enters `[MM, IM]`:

- **Futures**: `liquidatePositions(participant, positionIds[])` closes a
  keeper-chosen **subset of lots** in one tx. No per-lot margin recompute; a
  single end-of-tx `OverLiquidation` guard enforces "with lots remaining and a
  real buffer (`IM > MM`), leftover balance ≤ IM".
- **Perps**: `liquidatePosition(user, closeQty)` closes a keeper-chosen
  **partial quantity** of the net position in one tx, with the same end-of-tx
  `OverLiquidation` guard.

The keeper sizes the subset / quantity **off-chain** (see
`keeper/src/predict/solve.ts`: `solveFuturesLotsToTarget`,
`solvePerpCloseToTarget`) against a fresh snapshot, using off-chain replicas of
the contract close math (`simulateFuturesClose`, `simulatePerpClose`) so the
band predicate the solver optimises against is exactly the one the contract
enforces.

## Orchestration algorithm (the planner)

The coordinator is **sequential and re-snapshots after every step**. This is the
key discipline that makes shared collateral tractable: never plan two venues off
one stale snapshot — a close on venue A changes venue B's surplus.

```
run(user):
  health = readHealth(user)                 # portfolio MM surplus
  if health.mmSurplus >= 0: return healthy

  # 1. Orders leg — clear resting orders on every venue first.
  #    Orders alone can break MM, and positions can't be closed while
  #    orders are open (OrdersStillOpen).
  for venue in venues: venue.liquidateOrders(user)
  re-read health; if healthy: return

  # 2. Position leg — loop, worst-venue-first.
  for iter in 0..MAX_POSITION_ITERATIONS:
     ranked = rankVenuesByLoss(user)         # sum(unrealizedLoss) desc, notional tiebreak
     if ranked empty: return badDebt         # nothing left to close, still < MM
     worst = first actionable venue
     result = worst.reduceToTarget(user)     # ONE gas-bounded batched tx
     if result == ordersStillOpen: replay orders leg
     if result == nothingToClose: park venue
     re-read health; if healthy: return liquidated
  return stalled (re-queue)                   # made progress, ran out of budget
```

`reduceToTarget` encapsulates: snapshot read → off-chain sizing → one batched
call. The planner is pure orchestration; venues own calldata, batching, gas
estimation, and the not-liquidatable / unprofitable skip predicates.

### Why sequential (not one giant multi-venue plan)

- A partial close on one venue frees shared collateral and can move the *other*
  venue from "must reduce" to "already fine" — computing both legs from one
  snapshot would over-liquidate the second venue.
- Re-snapshotting per step also **adapts to price drift** between txs: each
  `reduceToTarget` sizes against the latest mark, so a mid-liquidation price move
  simply changes the next chunk rather than invalidating a precomputed plan.

## Gas-bounded chunking (Option A)

We do **not** try to fit an unbounded liquidation into one tx. Instead:

- **Futures** caps the number of lots per `liquidatePositions` call at
  `maxLotsPerLiquidationTx` (keeper config, env `FUTURES_MAX_LOTS_PER_LIQUIDATION_TX`).
  `reduceToTarget` sends **one worst-first chunk** (the deepest-loss lots, capped)
  and returns. The account may remain between IM and MM after a chunk — that is
  acceptable (still de-risked relative to the MM trigger).
- The **planner loop re-invokes** `reduceToTarget` on the still-worst venue,
  re-snapshotting each time, until healthy or the iteration budget is exhausted.
  `MAX_POSITION_ITERATIONS` is sized generously so a large book drains across
  several chunks within one `run`.
- **Perps** does not need position chunking: a single `liquidatePosition(user,
  closeQty)` closes any quantity of the *one* net position in O(1) settlement.
  The perps gas concern is the **order flood**, handled by bundling
  `liquidateOrder` calls via `multicallStopOnFailure` (see below).

**Consequence to accept:** splitting into chunks means intermediate states can
sit in `(MM, IM)` — recovered past the trigger but not yet fully into the buffer.
The next chunk (or the next sweep) finishes the job. This is strictly better than
the old one-lot-per-tx churn and is safe because each chunk only ever reduces
risk.

## Keeper incentives / fee model

> **Status (current code): keeper incentives are DISABLED.** No `liquidationFee`
> is transferred on any liquidation path in either venue — `liquidatePosition`,
> `liquidatePositions`, `liquidateOrder(s)`, and their perps equivalents all emit
> a `0` fee and move no funds. The `liquidationFee` state variables and their
> owner setters are **retained** (so a future iteration can re-enable payouts
> without a storage migration), and the keeper's off-chain solvers model a **0
> fee** so their balance projections match on-chain reality. The protocol runs
> the only keeper for now, so there is nothing to incentivise; the anti-farming
> design below is preserved as the reference for when incentives are turned back
> on.

Liquidation fees drive keeper behaviour, so the fee model must not reward
value-destroying or farming behaviour.

- **Futures**: a flat `liquidationFee` **per lot closed**. Because it scales with
  the number of lots in the batch, a keeper is paid proportionally to the work
  and gas it spent — there is no incentive to split a batch into many txs (that
  only adds gas for the same total fee), nor to under-close (fewer lots = less
  fee).

- **Perps**: a **single flat `liquidationFee`, paid only if the close restored
  the account to the buffer** (post-close balance ≥ MM), or on a full close.
  - A naïve "flat fee on every `liquidatePosition` call regardless of
    `closeQty`" is a **fee-farming vector**: an attacker/keeper could drip-close
    an underwater position one sliver at a time, collecting a flat fee per call.
  - Gating the fee on *reaching the buffer* removes that vector: intermediate
    partial closes that leave the account still underwater earn **nothing**, so
    there is no reward for slicing. The keeper is paid once, for the close that
    actually cures the account (or for a full close in the bad-debt path).
  - **Known caveat (accepted): cross-venue free-riding.** Under shared collateral,
    a perps close can be the step that flips the *portfolio* healthy even though
    the perps balance change was small — and vice-versa, a futures chunk can heal
    the account so a would-be perps closer arrives to find nothing to do. With a
    single coordinated keeper (`COORDINATOR_MAX_CONCURRENT = 1`) this is a
    non-issue: the same operator performs all legs. It only matters in a
    competitive multi-keeper market, where the "reached the buffer" gate can let a
    late keeper capture the fee for a cure that an earlier keeper's work set up.
    We accept this for now; a per-unit perps fee (fee ∝ `closeAbs`) is the
    alternative if competitive keepers are introduced.

## Small-order flood on Perps

Concern: a user opens a flood of tiny-value resting orders; there is little
per-order incentive to cancel them during liquidation.

Mitigations (contract already supports these):

- **`MAX_ORDERS_PER_PARTICIPANT`** hard-caps how many resting orders one account
  can hold, bounding the worst-case fan-out.
- **`minimumMarginPerOrder > 0`** makes each order carry real margin, so dust
  orders are simply not creatable. Recommended to set non-zero in prod.
- **Bundling amortizes gas.** The keeper composes
  `multicallStopOnFailure([liquidateOrder × N, liquidatePosition])`: the orders
  are cleared in the *same* tx that closes the position, so the (large) position
  fee amortizes the per-order gas. Clearing the orders is a prerequisite anyway
  (`OrdersStillOpen`), so it is never "unpaid work" — it is part of the
  profitable position liquidation.
- If dust remains uneconomical, an **insurance-fund bounty** for order clearing
  is the escalation lever, but is not needed while the above hold.

## Contract invariants relied upon

- `liquidatePositions` / `liquidatePosition(user, closeQty)` do **not** recompute
  margin per unit closed. They close the keeper-supplied amount and enforce a
  **single** end-of-tx `OverLiquidation` guard: with exposure remaining and a
  real buffer (`IM > MM`), leftover balance must be ≤ IM. A full close skips the
  guard (the buffer is undefined once the position is gone — bad-debt path).
- Sizing the close so the account lands in `[MM, IM]` is the keeper's off-chain
  responsibility; the guard is only a backstop against over-liquidation, not a
  planner.
- Stale / foreign / already-closed ids in a Futures batch are **skipped**, not
  reverted, so a snapshot race degrades to "closed fewer than planned" (the
  planner's next iteration re-sizes) rather than a failed tx.

---

# Design exploration: on-chain orchestration, verifiable rules, and lot aggregation

Everything above describes the **current, keeper-driven** implementation
(sequential per-venue `reduceToTarget`, off-chain sizing, per-call
`OverLiquidation` guard). This section records the follow-on design discussion
about pushing more of the guarantee **on-chain** — a single cross-venue entry
point, a *verifiable* rule set so liquidation is not "random", and the data-model
change (lot aggregation) that makes deterministic liquidation actually
implementable. None of this is built yet; it is the agreed direction and its
trade-offs.

## Why the per-venue guard alone can't split cleanly across venues

The original intent was "restore margin to IM (or a bit more)". Two facts break
that framing:

1. **"a bit more" (above IM) is impossible** with the per-call `OverLiquidation`
   guard — you can land at IM but never above it.
2. **IM is a portfolio-level scalar, but closing happens per-venue.** You can't
   independently tell futures and perps to each "reach IM": whichever closes
   second overshoots and reverts. And you can't pre-allocate "x on futures, y on
   perps" off one snapshot either, because closing one leg changes the portfolio
   IM the other leg's sizing was based on (especially with cross-margin offsets).

Plain multicall does **not** fix this: the guard lives *inside* each venue call,
so bundling still runs each intermediate check. The problematic orderings are
exactly the ones the per-venue guard forbids — e.g. a **hedged book** where you
must close the *winning* leg too; closing it first realizes profit and pushes
balance above IM before you've touched the losing leg, tripping the guard even
though the *final* state is perfectly in-band.

## A single cross-venue entry point (LiquidationRouter)

Prerequisite (already satisfied): `PortfolioMarginEngine.computePortfolioIM/MM`
spans **all three legs** — it holds an `IFutures` ref and folds in
`getOrderMargin`, `getUnrealizedPnl`, `getNetPositionDelta`
alongside perps + options. So a single on-chain portfolio-margin check that
covers both venues already exists.

A `LiquidationRouter` (natural home: `collateral-margin`, next to Vault + PME)
with one entry point:

```
liquidate(user, futuresIds[], perpsCloseQty, feeTo):
  require underwater(user)                       # balance < portfolioMM
  clear orders on each venue (or require cleared)
  futures.liquidateFor(user, futuresIds)         # router-only, guard SUSPENDED
  perps.liquidateFor(user, perpsCloseQty)        # router-only, guard SUSPENDED
  bal = vault.balanceOf(user)
  im  = PME.computePortfolioIM(user)
  mm  = PME.computePortfolioMM(user)
  require(im <= mm || bal <= im)                 # single over-liquidation ceiling
  pay unified fee to feeTo                        # one decision, portfolio-level
```

What it buys: **atomic multi-venue close verified once** (unlocks the
hedged-book orderings the per-venue guard forbids), a **single PME evaluation**
(gas), and a **unified fee decision** (which dissolves the cross-venue
free-riding caveat noted earlier). The keeper still computes the joint split
off-chain; the router just executes + verifies.

What it costs: the safety invariant **moves into the router** — venues must
expose a guard-suspended, `onlyLiquidationRouter` close path (or honour an
EIP-1153 transient "liquidation in progress" flag), which widens the trusted
surface and couples three codebases (Futures + Perps + collateral-margin). If the
router forgets the final `≤ IM` check it can drain users, so it must be
governance-controlled and audited. It is also still gas-bounded, so whales still
chunk (the "verify once" then applies per chunk).

## Fee model under chunking

"Pay only when the account is **restored**" is a *completion* trigger, and
chunking means only the *last* tx completes — so intermediate chunks would do gas
work for zero fee, and a competitor could free-ride the cheap final chunk. The
resolution is to let the fee track each venue's **unit of work**:

| Venue | Work per liquidation | Fee | Non-progress rule |
| --- | --- | --- | --- |
| Perps | constant (O(1) settlement, any size) | **flat per call** | pay only if the close restored the account to the band |
| Futures | proportional to lots closed | **flat per lot** | pay per lot actually closed |

- **Perps stays flat**, not per-unit — the work is size-independent, so a
  `rate × closeAbs` fee would mis-tax. Flat + partial + no-farming already
  coexist via the restore gate: a correctly-sized partial collects one flat fee;
  a sub-restoring sliver pays 0; once restored, further calls revert
  `NotLiquidatable`. So there is at most one flat fee per underwater episode.
  This is exactly the shipped perps behaviour, and it does **not** conflict with
  chunking because perps never chunks.
- **Futures is already per-lot**, so each chunk is paid for the lots it closed —
  chunking + fees already coexist, no change needed.
- **Optional completion bonus.** If you want to keep rewarding "reached the
  buffer" while paying per-chunk, add a *one-time* flat bonus paid only on the
  close where balance crosses back to ≥ MM. It is farming-proof (health crosses
  MM at most once per episode) and it incentivises finishing the small final
  chunk that the proportional/flat base fee under-pays.
- **Router:** pays the sum of the per-venue leg fees for that tx; the restore
  gate, when used, is evaluated once at the portfolio level.

Keep the perps rule as **"pay 0 if not restored"** (not "revert if not
restored"): the 0-fee-succeed form is more composable — a future router can reuse
the standalone perps call for its leg and settle the fee at the portfolio level
without needing a separate suspended entry point.

## Making liquidation deterministic ("not random") and verifiable

The router can cheaply verify the **result** (in-band) but **cannot** cheaply
verify a plan is *optimal* — optimality is a counterfactual over alternative
plans, i.e. re-running the solver on-chain. To remove keeper discretion without
re-solving, define a **canonical rule set** whose *conformance* is a boundary
check, not a search.

### Rule set (each clause a router-enforced predicate)

- **R0 — Validity.** Closed ids belong to the user; `closeQty ≤ |net|`. Cheap.
- **R1 — Trigger.** `balance < portfolioMM(user)` at entry. One read.
- **R2 — Orders before positions.** No position closed while any order rests;
  order count = 0 after. Cheap.
- **R3 — Canonical close order.** One deterministic total priority over all
  closeable positions across both venues, computable from on-chain state at the
  current mark, with a deterministic tie-break `(venueRank, positionId)`.
  Recommended key: **descending unrealized loss**. *Verify:* the closed set is a
  **prefix** — `min(priority of closed) ≥ max(priority of still-open)`.
- **R4 — Sizing = IM ceiling.** With a position remaining, `balance ≤ IM`.
- **R5 — Maximality.** `balance ≥ IM − δ` (the continuous perps leg can fine-tune
  balance to hit IM exactly, so the prefix length is *forced*, not chosen).
- **R6 — Restoration / bad-debt terminal.** Either `balance ≥ MM` (in-band) or
  **all** positions closed (bad-debt full liquidation).

R3 + R4 + R5 make the plan **unique** — the longest canonical prefix that sits at
the IM ceiling — so the liquidation is deterministic, and every clause is a
boundary predicate + a couple of margin reads, with **no on-chain re-solve**.

Two free parameters are pure policy: the **priority key** (loss-first vs
margin-relief-first) and the **IM-ceiling vs MM-floor target** (buffer/less churn
vs minimal user harm). Fix them once and they become law.

### The cost of strict verification, and the cheaper invariant tier

Verifying R3's prefix property requires the priority of every *still-open*
position (to compute `max(open)`), so the router must **enumerate all of the
user's futures lots across all expiration dates** (plus the perp) — `O(total
lots)` storage reads even to close a few. And because the "most-underwater" key is
**mark-dependent**, no persisted sorted structure helps (price reshuffles the
order every block).

Cheaper alternative — verify **invariants**, not the exact order (`O(1)`):

- **Band:** `MM ≤ balance ≤ IM`.
- **Risk-monotonicity:** `|netDelta_after| ≤ |netDelta_before|` (reuses
  `getNetPositionDelta`; one read before, one after), optionally
  `stressLoss_after ≤ stressLoss_before`.

This rules out the genuinely harmful selections — above all **hedge-stripping**,
where closing an offsetting leg and leaving a naked position *increases*
`|netDelta|` and is rejected. It bites precisely on mixed/hedged books (where
selection is dangerous) and is permissive on one-directional books (where the
band alone suffices, since all lots share a sign). The trade-off: invariants
constrain the plan to the *set* of sensible risk-reducing liquidations rather
than pinning one unique plan.

**Recommendation:** enforce the `O(1)` invariant tier on-chain (band +
`netDelta`-monotonicity), and keep the canonical priority as the keeper's
off-chain policy (deterministic in practice, disciplined by competition). Pay for
strict on-chain prefix verification only against a concrete adversary the
invariants don't cover — and only after the aggregation change below makes it
affordable.

## Enabler: aggregate lots into one net position per expiration date

The `O(total lots)` scan is a direct consequence of the **data model**: today a
user holds *many individual futures lots* per delivery date, so the priority set
is unbounded and mark-dependent. Deterministic, cheaply-verifiable liquidation is
really only implementable if we **net a user's lots into a single position per
expiration date**:

- The closeable set collapses from "all lots across all expiries" to **one net
  position per delivery date** — a small, bounded set (`#expiries`, not
  `#lots`). R3's prefix scan becomes `O(#expiries)` instead of `O(#lots)`.
- Each per-expiry position becomes a **single signed net quantity** — i.e. it
  behaves like the perps net position: **continuous**, so a partial close can
  fine-tune balance to the IM ceiling **exactly** (R5 becomes exact and cheap on
  every venue, not just perps), and the awkward "which discrete lot is the last
  one" problem for maximality disappears.
- Sizing collapses to "choose a `closeQty` per expiry" — the same shape as perps
  — so the futures and perps solvers unify, and the canonical order is a clean
  ranking over a handful of net positions.
- It also shrinks the margin/PnL bookkeeping the PME and the guard walk over,
  reducing the per-liquidation gas independent of the verification question.

In short: **lot aggregation (one net position per expiration date) is the
prerequisite that turns the deterministic, verifiable rule set from `O(#lots)`
and discrete into `O(#expiries)` and continuous** — and it is the change to make
before investing in strict on-chain prefix verification or the router. The
maintenance-margin math and cross-margin offsets are unaffected (they already
operate on net delta / net exposure); what changes is that the *unit of
liquidation* becomes the per-expiry net position rather than the individual lot.
