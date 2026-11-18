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
exposure: each venue reports its contracts at its own marks (perps at the glide, each
futures expiry at its mark range, longs and bids at `low`, shorts and asks at `high`) and
the engine shocks the sum. Resting orders are stressed as part of net exposure — the
worse of the buy-side and sell-side fills — rather than charged as a flat add-on:

```
margin(P) = max( stress(netExposure + buyOrderExposure),
                 stress(netExposure - sellOrderExposure) )
          + fillLoss(P)
          + unrealizedLoss(P)
          + fundingOwed
          + accountDebt
```

`P` is the index. The snapshot records each mark and the index it was read at, and a
mark moves with the index in proportion (`markAt`: `mark · P / index`), since the glide
and the mark ranges are the index times a schedule factor. A snapshot without marks
values every leg at the index.

`fillLoss(P)` is each side's Scarf bound from the per-side quantity and price moments
the venues store (`Σq`, `Σp·q`, `Σp²·q`) at that side's mark: perps once, futures per
expiry. It never under-charges, so a deep order cannot hide a marketable one, and it is
exact for a single price level.

`accountDebt` is the account's unpaid realized loss to the insurance fund. It is
constant in price and is included in both IM and MM until a later fund payout
cancels it.

Every term is convex in `P`, so `balance - margin(P)` is concave: an account can have a
threshold below spot, above it, both, or neither, and at most one on each side. The
solvers bisect between the unrealized-PnL kinks rather than solving a closed form.

IM and MM are not the same function with a different shock. IM clamps unrealized PnL per
market, ignoring gains entirely; MM clamps the portfolio-wide sum, letting a gain at one
venue offset a loss at another. They therefore have different kink sets. See the notes in
`src/mm.ts` and `src/solve.ts`.

## Usage

```ts
import { mmRequired, solveLiquidationThresholds } from "@hashpower/portfolio-margin";

const required = mmRequired(snapshot, params, index);
const { liqDown, liqUp } = solveLiquidationThresholds(snapshot, params, index);
```

## Consumers

- `collateral-margin/keeper` — depends on it by relative path.
- `futures-marketplace/ui` — depends on it by git URL against this repository.

The package ships TypeScript sources with no build step: `exports` points straight at
`src/index.ts`. Both consumers already compile TypeScript from their own toolchain (Node
type stripping in the keeper, esbuild in the UI), so there is no `dist/` to rebuild and
nothing to publish or keep in sync — a git ref is the whole release process.
