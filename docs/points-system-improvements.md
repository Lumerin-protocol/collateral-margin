# Points System — Deferred Features & Future Improvements

## Status

Backlog. These features were intentionally **removed from the shipped `PointsHook`** to
keep the first iteration minimal, auditable, and hard to game. Each entry records the
design (often the exact implementation that was cut) and the rationale, so it can be
re-introduced deliberately rather than reinvented.

The shipped hook keeps only: maker/taker notional weights, a flat keeper reward, a
per-side minimum-fee threshold, and self-match exclusion. Everything below is additive.

---

## 1. Loyalty / streak multiplier

**Idea.** Reward sustained activity by multiplying a fill's base points by a bonus that
grows with the number of *consecutive active days* an account has traded.

**Cut design (drop-in).** Two tunable parameters and two per-account storage slots:

- `loyaltyStepBps` — bonus added per consecutive active day (bps of base points).
- `loyaltyMaxBps` — cap on the cumulative bonus.
- `mapping(address => uint64) lastActivityDay` — day index of last earning activity.
- `mapping(address => uint32) streakDays` — current consecutive-day streak.

Applied inside accrual before minting:

```solidity
function _applyLoyalty(address account, uint256 base) internal returns (uint256) {
    if (loyaltyStepBps == 0 || base == 0) return base;

    uint64 today = uint64(block.timestamp / 1 days);
    uint64 last = lastActivityDay[account];
    uint32 streak = streakDays[account];

    if (last == 0 || today > last + 1) {
        streak = 1;            // first activity, or a missed day → reset
    } else if (today == last + 1) {
        streak += 1;           // consecutive day → extend streak
    }
    // today == last: same-day activity keeps the streak unchanged.

    lastActivityDay[account] = today;
    streakDays[account] = streak;

    uint256 bonusBps = uint256(streak - 1) * loyaltyStepBps; // day 1 has no bonus
    if (bonusBps > loyaltyMaxBps) bonusBps = loyaltyMaxBps;
    return base + (base * bonusBps) / BPS;                    // BPS = 10_000
}
```

**Why deferred.**

- Adds two SSTOREs to the trading hot path (`onFill` runs O(matched levels) per taker tx).
- A `block.timestamp / 1 days` boundary is sybil-amplifiable: a farmer can spread activity
  across sybils to build many streaks, and the deterministic day boundary is easy to
  optimise against. The benefit (retention) is real but not worth the added surface in v1.

**Improvement ideas before re-adding.**

- Weight the streak bonus by *volume* on the active day, not mere presence, so a dust
  trade can't keep a streak alive.
- Use a rolling, decaying activity score rather than a hard day boundary.
- Consider computing loyalty off-chain from the subgraph and applying it only at
  conversion time, keeping the hot path clean.

---

## 2. Referral rewards

**Idea.** A referrer earns `referralBps` of their referees' freshly-earned points.

**Cut design.** A self-registered `mapping(address => address) referrerOf` (set once,
never self-referential), plus a `_payReferral` step that mints `referralBps` of each
referee's award to their referrer.

**Why deferred — sybil-gameable by construction.**

Referral cannot be made sybil-resistant on-chain without identity / cluster detection,
which `points-system-design.md` §8 explicitly puts out of scope. Worse, it *undermines
the program's core economic deterrent*:

- An attacker points N sybils' referrals at one wallet and earns `referralBps` of **free**
  points on volume they were doing anyway — pure extra yield on top of fees, which lowers
  the effective cost of wash trading (the exact thing the positive-fees invariant is meant
  to make unprofitable).
- Splitting one trader's volume across sybils-all-referring-home also inflates that
  cluster's share of the pro-rata GOV pool versus an honest single-account user.

**Improvement ideas before re-adding.**

- Gate referral payouts on off-chain sybil/cluster scoring (out of scope for v1).
- Fund referral from a separate, capped budget instead of fresh mints, and cap per-referrer
  totals — limits magnitude but does not fix the underlying sybil incentive.
- Require referees to pass a meaningful activity/seniority threshold before referral accrues.

---

## 3. Per-account caps

**Idea.** A single-window cumulative cap on points any one account can earn, to flatten
whale dominance of the pro-rata pool.

**Cut design.** A `uint256 accountCap` (0 == uncapped) plus `mapping(address => uint256)
earned`, with awards clamped to the remaining room:

```solidity
function _mintCapped(address account, uint256 amount) internal returns (uint256) {
    if (amount == 0) return 0;
    if (accountCap != 0) {
        uint256 already = earned[account];
        if (already >= accountCap) return 0;
        uint256 room = accountCap - already;
        if (amount > room) amount = room;
    }
    earned[account] += amount;
    points.mint(account, amount);
    return amount;
}
```

**Why deferred.**

- A flat per-account cap is trivially defeated by splitting across wallets — without sybil
  detection it mostly penalises honest large traders rather than farmers.
- Adds an SSTORE (`earned`) to the hot path.

**Improvement ideas before re-adding.**

- Pair with sybil/cluster detection so the cap applies per *entity*, not per address.
- Prefer a soft diminishing-returns curve (e.g. sqrt of volume) over a hard cap.

---

## 4. Sybil / cluster detection (cross-cutting prerequisite)

Most of the above only become safe and meaningful once accounts can be clustered into
entities. This is explicitly out of scope for the bootstrap program (design §8), but it is
the single highest-leverage improvement: it would unlock referral, per-entity caps, and a
volume-weighted loyalty curve simultaneously. Most viable as an **off-chain scoring service
reading the points subgraph**, applied at conversion time rather than at mint time.
