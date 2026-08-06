# Unrealized profit as collateral: the Mango attack, and why it does not work here

This note explains the October 2022 Mango Markets exploit, extracts the general
attack it belongs to, and documents exactly which parts of this system make that
attack unprofitable. It exists because the margin engine deliberately allows
unrealized profit on one venue to offset an unrealized loss on another, and that
is precisely the design choice Mango is the cautionary tale for. The difference
between the two is narrow and load-bearing, so it is worth writing down.

## What happened at Mango

In October 2022 Avraham Eisenberg took roughly $110M out of Mango Markets, a
Solana perpetuals venue, and left the protocol about $47M short after partially
returning funds. The mechanism was not a bug in the usual sense. Every contract
did what it was written to do.

He funded two accounts and used them to take large opposing MNGO-PERP positions
against himself, so the pair carried no net market risk. He then bought MNGO spot
on the three thin venues that fed Mango's price oracle. MNGO's average daily
volume that month was under $100,000, so this was cheap. The oracle price rose
more than thirteenfold in about thirty minutes.

At that inflated mark, the long account showed an enormous unrealized profit.
Mango counted unrealized profit as collateral, so the account's borrowing power
rose with it, and he withdrew other users' real assets against it. The price then
returned to where it started. The profit that had backed the withdrawal evaporated;
the withdrawn assets did not.

The CFTC, SEC and DOJ all brought actions. For our purposes the legal outcome
matters less than the shape of the thing.

## The general attack

Mango is usually filed under "oracle manipulation", which is true but not the
useful description — plenty of systems survive a manipulated oracle. The exploit
needed three conditions to hold at the same time:

1. **A manipulable mark.** A thin instrument with few price sources.
2. **Unrealized profit increasing spendable collateral.** The inflated mark had
   to translate into more borrowing or withdrawal capacity.
3. **An exit.** Real assets had to be removable while the mark was inflated.

Break any one link and the attack stops paying. Condition 1 is a market property
and can only be managed, never eliminated — the JELLY incident on Hyperliquid in
March 2025 and the venue-local collateral marks that drove the October 2025
liquidation cascade are both reminders that thin marks stay manipulable in both
directions. Conditions 2 and 3 are design choices, and they are where this system
differs.

## How this system is built

Two properties do the work. The first is the important one.

### Unrealized profit never funds an exit

Withdrawals are gated on initial margin, not maintenance margin:

```solidity
// CollateralVault._checkMargin
uint256 required = IPortfolioMarginEngine(engine).computePortfolioIM(account);
if (balanceOf(account) < required) revert MarginBreach();
```

and initial margin clamps unrealized PnL **per market, with gains discarded**:

```solidity
// PortfolioMarginEngine._marginFromAggregate
uint256 pnlTokens = isIM
    ? agg.unrealizedLossPerMarket
    : (agg.netUnrealizedPnl < 0 ? uint256(-agg.netUnrealizedPnl) : 0);
```

So an unrealized gain, at any venue, on any instrument, contributes exactly zero
to the number that decides how much collateral can leave the vault. There is no
arithmetic path from an inflated mark to a larger withdrawal. Condition 3 is
absent by construction rather than by parameter choice, which means no oracle
configuration, shock setting or market listing can reintroduce it.

The same IM figure gates opening new positions — `_ensureInitialMargin` on both
venues, and `canPlaceOrder` on the engine — so an inflated mark cannot be levered
into a larger position either. Both of the levers Eisenberg pulled read a number
that ignores his profit.

### Profit can cancel a loss, but is never itself collateral

Maintenance margin does net PnL across venues, and this is the part that
superficially resembles what Mango did. It is not the same operation.

The term is `max(0, -Σ unrealizedPnl)`. A net gain contributes **zero**, not a
credit. Profit can stop a loss from being charged; it can never be charged
negatively. So the requirement can never fall below the stress term plus the
other add-ons, no matter how large the gain or how badly the mark is wrong.

That bound is what separates the two designs. At Mango, profit was *added to*
collateral and the ceiling on extraction was the size of the lie. Here, profit
can at most decline to charge for a loss the account genuinely carries, so the
ceiling on what a manipulated mark can buy is the size of a real, offsetting
loss the attacker already holds. To benefit at all, the attacker must first be
genuinely losing money somewhere else.

## What netting does still expose, honestly

Maintenance margin decides liquidation, so an attacker who inflates the mark on a
venue where they hold a gain can suppress their own maintenance requirement and
postpone their liquidation. They cannot withdraw anything, cannot open anything,
and cannot touch another account. When the mark reverts they are liquidated
anyway — later, and therefore possibly deeper, which can convert a clean
liquidation into bad debt absorbed by the insurance fund.

This is a real exposure and it is the price of the netting. Three things bound it.
The gain must sit on a genuine position, so the attacker carries real risk on the
leg they are inflating. The benefit is capped by an offsetting loss they must
actually be carrying. And the payoff is a delay rather than a transfer, which is
a far weaker incentive than $110M of withdrawable assets.

Against that, the failure the netting *removes* is not hypothetical either. Under
a per-market clamp a delta-flat hedge across two venues becomes liquidatable as
soon as the mark moves at all, because the losing leg is charged in full while
the winning leg is invisible. That liquidates solvent accounts as a matter of
routine, on exactly the hedged flow a cross-product margin engine exists to
attract. Binance's October 2025 episode is the industry's most expensive
demonstration of what liquidating economically solvent accounts costs: over $328M
in compensation from a single venue over roughly one day.

## Assumptions this rests on

**Both venues must mark against consistent prices.** `Futures.priceOracle`, the
perps equivalent and `PortfolioMarginEngine`'s own feed are separately configured
storage slots. In normal deployment they point at the same hashprice feed, but
nothing in the code enforces it, and they degrade differently under staleness —
futures reverts, the engine returns zero. Netting a gain measured against a
diverged feed against a loss measured against a live one is not a real offset.
Treat oracle consistency across the three as a deployment invariant.

**Cash is genuinely fungible between the legs.** Both venues settle into one
`CollateralVault`, in one currency, under one set of protocol rules. This is what
makes cross-venue netting an accounting identity rather than a bet on
correlation, and it is enforced: `addLinearMarket` rejects any market that pins a
different vault. If that ever stops being true, the netting argument stops
holding with it.

## Deliberately not implemented

The following would each tighten the residual exposure above. None is in place,
and each is a parameter decision rather than a structural one:

- **Conservative marks on the credited side** — value gains at the worse of the
  live oracle and a short TWAP, losses at the better. This is the most direct
  defence against a transient manipulated print and the cheapest to add.
- **A haircut on the credited gain**, per market, so thin or far-dated
  instruments offset at less than face value.
- **A liquidity floor** disabling the offset entirely below a volume or open
  interest threshold.

The reason none is urgent is the structural bound above: with no exit and no
credit beyond cancelling a real loss, these tighten a delay, not a leak. They
become materially more important if unrealized gain is ever allowed to support
withdrawal, opening, or transfer — at which point condition 3 is back and this
document is describing a system that no longer exists.
