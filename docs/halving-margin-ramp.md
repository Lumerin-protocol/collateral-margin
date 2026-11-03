# Halving margin ramp

The next Bitcoin halving, at block 1,050,000 (about April 2028), roughly halves the hashprice
index in a single oracle update. The margin shocks are sized for much smaller moves, so without
preparation every leveraged long goes below zero equity in one block, the loss beyond its balance
is paid by the insurance fund, and a colluding long/short pair can farm it (audit finding
CF-321). The index itself stays honest: no smoothing, capping or early pricing of the halving.
The margin engine absorbs it instead.

The Safe raises the spot shocks by hand in four steps over the month before the halving, then
lowers them after the first post-halving retarget. The shocks are portfolio-wide, so the ramp
applies to perps and futures alike, and to longs and shorts alike.

## Why these levels

Hashprice is about (subsidy + fees) / difficulty. The halving cuts the subsidy from 3.125 to
1.5625 BTC while fees and difficulty stay put, so the index drops by
1.5625 / (3.125 + fees): about 49.5% at typical fees and never more than 50%.

The margin engine charges the spot shock on each account's net position across both venues and
adds unrealized losses on top, so an account that is not liquidatable has equity of at least
`mmSpotShock` times its notional. With `mmSpotShock` at 50%, such an account still has equity of
zero or more after the drop: the keeper liquidates it after the step without bad debt. Only the
liquidation fee may go uncovered. `imSpotShock` stays 5 points above, so a newly opened position
does not start at the liquidation line.

Raising margin at the last minute does not work. Accounts that do not top up are liquidated, and
their positions pass to the backstop at the index price. Close to the halving the market already
prices in the drop, so the unwinder cannot sell them near the index and the insurance fund holds
them through the step. The ramp starts early and front-loads the increase so those liquidations
happen while the unwinder can still sell.

## Schedule

Steps are keyed to Bitcoin height, not dates: the halving's date drifts by days. The
`BtcBlocksUntilHalving` metric on the `col-mar-vault-{env}` dashboard shows the countdown, and
the halving alarms fire at 30, 14 and 7 days.

| Bitcoin height | Before the halving | `imSpotShock` / `mmSpotShock` |
| --- | --- | --- |
| before 1,045,680 | | 15% / 10% (`config/{env}.env`) |
| 1,045,680 | about 30 days | 30% / 25% |
| 1,046,976 | about 21 days | 40% / 35% |
| 1,047,984 | about 14 days | 50% / 45% |
| 1,048,992 | about 7 days | 55% / 50% |
| after 1,050,336 | about 2 days after | back to the `config/{env}.env` values |

- The last retarget before the halving is at 1,048,320, about 12 days out, and also moves the
  index in one block. MM is already 45% by then.
- The first retarget after the halving is at 1,050,336, about 2.3 days after it. Hashrate often
  leaves after a halving, so that retarget can push the index up and hit shorts. Hold the 50%
  level until it has landed.
- Lowering the shocks only frees collateral, so the step down can be one transaction.
- The vol shocks only matter for options and stay unchanged.

## Each step

1. A week before the step, announce it with its height and new levels in the UI banner and
   docs, so users can top up instead of being liquidated.
2. Propose `PortfolioMarginEngine.setShocks(imSpot, mmSpot, imVol, mmVol)` to the engine owner
   Safe (dev: the deployer sends it). Arguments are WAD fractions, IM before MM; for the first
   step:

   ```sh
   cast calldata "setShocks(uint256,uint256,uint256,uint256)" \
     300000000000000000 250000000000000000 100000000000000000 50000000000000000
   ```

   `setShocks` has no on-chain bounds. Review the values against the table before signing.
3. Execute at the listed height. The keeper and the market maker react to `ShocksUpdated` at
   once (10-minute re-read as a fallback), and the keeper liquidates accounts now below MM.
4. Check `imSpotShock()` and `mmSpotShock()` on the engine and the shock on the dashboard, and
   watch keeper errors, `BackstopEquity` and the unfilled-backstop alarm until the liquidations
   from the step have unwound.

## Effects to plan for

- During the last week every account, long or short, is limited to about 2x leverage. A
  long-only ramp would spare shorts but needs margin-engine code; this ramp does not.
- Resting-order margin uses `imSpotShock` (`linearOrderMargin`), so at 55% the market maker's
  collateral supports about a quarter of the quote size it does at 15%. Fund it, or plan smaller
  quotes, for the window, and cut its long inventory before the last steps.
- Each step liquidates accounts that have not topped up. Keep the keeper, the backstop unwinder
  and the insurance fund's headroom under the debt cap checked before each step.

## Not covered

- Difficulty retargets outside this window still move the index in one block, by more than 5%
  several times a year. The everyday shock levels are a separate decision.
- Futures expiring after the halving are marked at the current index, not with the halved
  subsidy (Luxor's method). The ramp covers them through the shocks instead.
