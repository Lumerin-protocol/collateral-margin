# @hashpower/portfolio-margin

Off-chain replica of `PortfolioMarginEngine._computeMargin`, plus the price-threshold
solvers built on top of it.

## Why this package exists

Two clients need the same answer to "at what spot price does this account become
liquidatable?": the keeper, which acts on it, and the trading UI, which shows it to the
user. While each kept a private copy of the math they drifted apart — at one point they
clamped unrealized PnL differently, so they genuinely disagreed about who was
liquidatable. One implementation makes that class of bug impossible.

The package is pure: no dependencies, no side effects, no I/O. It is bigint arithmetic
over a plain snapshot struct. Reading that snapshot from chain is deliberately left to
the caller, because the keeper (batched RPC) and the UI (wagmi hooks) do it very
differently.

## The model

The engine's stress model is a four-scenario (±spot, ±vol) grid. These portfolios are
pure delta, so gamma and vega drop out and the worst case is the spot move opposing net
delta. Resting orders are stressed as part of net delta — the worse of the buy-side and
sell-side fills — rather than charged as a flat add-on:

```
margin(P) = max( stress(netDelta + buyOrderDelta),
                 stress(netDelta - sellOrderDelta) )
          + fillLoss(P)
          + unrealizedLoss(P)
          + fundingOwed
```

`margin(P)` is piecewise-linear in `P` with kinks at each break-even, so
`balance - margin(P)` is a tent: an account can have a threshold below spot, above it,
both, or neither. The solvers enumerate kinks and bisect within each monotone interval
rather than solving a closed form.

IM and MM are not the same function with a different shock. IM clamps unrealized PnL per
market, ignoring gains entirely; MM clamps the portfolio-wide sum, letting a gain at one
venue offset a loss at another. They therefore have different kink sets. See the notes in
`src/mm.ts` and `src/solve.ts`.

## Usage

```ts
import { mmRequired, solveLiquidationThresholds } from "@hashpower/portfolio-margin";

const required = mmRequired(snapshot, params, markPrice);
const { liqDown, liqUp } = solveLiquidationThresholds(snapshot, params, markPrice);
```

## Consumers

- `collateral-margin/keeper` — depends on it by relative path.
- `futures-marketplace/ui` — depends on it by git URL against this repository.

The package ships TypeScript sources with no build step: `exports` points straight at
`src/index.ts`. Both consumers already compile TypeScript from their own toolchain (Node
type stripping in the keeper, esbuild in the UI), so there is no `dist/` to rebuild and
nothing to publish or keep in sync — a git ref is the whole release process.
