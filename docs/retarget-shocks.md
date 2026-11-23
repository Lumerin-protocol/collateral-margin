# Raising margin shocks before a difficulty retarget

`HashpriceBTC` applies a Bitcoin difficulty retarget in one block, so the hashprice index steps by the whole adjustment: a difficulty change `d` moves it by `1 / (1 + d) - 1`. No keeper can liquidate inside that block. An account whose equity above maintenance is smaller than the step on its exposure goes straight to a loss, which the insurance fund pays, then insurance debt.

The vault monitor projects the step every run. The alarms are `col-mar-retarget-step-warn` (step at least 50% of the MM spot shock, 432 blocks or fewer to go, Slack), `col-mar-retarget-step-page` (80%, 144 blocks, pages) and `col-mar-retarget-bad-debt` (projected bad debt above the insurance fund, pages).

## 1. Read the projection

On the vault dashboard, the "Bitcoin retarget, halving and the perps glide" widget shows:

- `RetargetBlocksLeft`, about 10 minutes each.
- `RetargetProjectedStepPct`: the index step, negative when difficulty rises. It firms up as the epoch fills; check it against mempool.space's difficulty estimate.
- `RetargetStepShockPct`: the step as a percent of `mmSpotShock`.
- `RetargetAtRiskAccounts`: accounts whose cushion above maintenance is smaller than the step on their exposure, counting resting orders on the losing side as filled.
- `RetargetPotentialBadDebt`: equity that would go below zero after the step and the backstop unwind (`BackstopUnwindBandBps` + `BackstopUnwindFeeBps`), against `InsuranceFundBalance`.

With no accounts at risk and no potential bad debt, do nothing: the shock already covers the step.

## 2. Choose the temporary shocks

An account that is not liquidatable has equity of at least `mmSpotShock` × its exposure above its other charges. Raising the MM spot shock above the step plus the unwind cost makes every account that could not absorb the step liquidatable now, at the current price, before the step lands. Accounts that stay healthy can absorb it.

- MM spot shock: at least |step| + unwind band + unwind fee, rounded up with a point of margin. With a −8.2% step and the lmn backstop at 50 + 5 bps: 0.082 + 0.0055 → 10% already covers it; a −12% step needs about 13.5%.
- IM spot shock: keep it at least the MM spot shock (the engine's `reduceLimits` relies on it; `setShocks` itself does not check). Keep the usual 5-point gap.
- Vol shocks: unchanged (no options venue).

What users see: the moment the transaction lands, every account between the old and the new maintenance becomes liquidatable and the keeper starts liquidating it, and new orders need the higher initial margin. Announce it first if accounts are close.

## 3. Propose through the Safe

The margin engine is owned by Safe `0x57ac51Ad8b3B5a95e655eD2AF98D9881B136f924` on Base. Shocks are WAD (1e18 = 100%). Read the current values first:

```sh
PME=0x5F047CCE438ae7796140506a5edf3D711034aaF3
for f in imSpotShock mmSpotShock imVolShock mmVolShock; do cast call $PME "$f()(uint256)" --rpc-url https://mainnet.base.org; done
```

Build the calldata (example: IM 18.5%, MM 13.5%, vol 10% / 5%):

```sh
cast calldata "setShocks(uint256,uint256,uint256,uint256)" 185000000000000000 135000000000000000 100000000000000000 50000000000000000
```

In the Safe UI, Transaction Builder: to = the PME, value 0, the calldata above. Check the decoded arguments, then collect the signatures. Land it at least a few hours before the retarget so the keeper has time to work through the liquidations.

Afterwards `MmSpotShockPct` shows the new value, `RetargetStepShockPct` drops, and `RetargetAtRiskAccounts` should fall to 0 as the keeper liquidates.

## 4. Restore after the retarget

Once the retarget block is relayed (`RetargetBlocksLeft` jumps back to about 2,016 and the index has stepped), propose `setShocks` again with the config values from `config/prd.env` (lmn: 15% / 10% / 10% / 5%):

```sh
cast calldata "setShocks(uint256,uint256,uint256,uint256)" 150000000000000000 100000000000000000 100000000000000000 50000000000000000
```

Log both transactions in the dev log.
