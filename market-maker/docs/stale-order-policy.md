# Stale-order / band policy

How `OrderExecutor` decides what to cancel, reduce, or place when reconciling the resting book against the quoter’s desired grid.

## Terms

- **Desired grid**: current `OrderIntent[]` from `Quoter`.
- **Worst desired bid / ask**: least-aggressive desired buy (min price) / sell (max price).
- **Band allowance** (`timing.staleBandAllowanceUsd`): extra price distance **outside** the worst desired level that still counts as keep. Denominated in USD (6dp price units), independent of venue tick size. Default `0.03` (≈ 3 ticks when tick = $0.01).
- **Keep zone**:
  - Bids: `price >= worstDesiredBid - bandAllowance`
  - Asks: `price <= worstDesiredAsk + bandAllowance`
- **Size allowance** (`timing.staleSizeAllowanceUsd`): on-grid `|have − want|` tolerance in USD notional (both reduce and top-up). Default `50` (~1 futures contract at ~$95).
- **On-grid**: resting `(side, price)` equals a desired intent price.
- **Better leftover**: inside keep zone, more aggressive than the current grid, not on a desired price.
- **Stale / worse**: outside the keep zone.

## Diff actions

| Resting order | Action |
|---|---|
| Buy with `price < worstDesiredBid - bandAllowance` | **Cancel** |
| Sell with `price > worstDesiredAsk + bandAllowance` | **Cancel** |
| Side with no desired levels | **Cancel all** on that side |
| Buy/sell inside keep zone but off-grid | **Keep** |
| On-grid, size delta above `staleSizeAllowanceUsd` | **Downsize** or **top-up** (below) |
| On-grid, size delta within `staleSizeAllowanceUsd` | **Keep** (no reduce, no place) |

Better leftovers are not credited toward a different desired price. Grid slides may place new levels while older in-band orders still rest (temporary extra size/IM).

## On-grid size allowance

`timing.staleSizeAllowanceUsd` (default `50`) gates both directions. The USD amount is converted to **venue-native size** at the level price and rounded to the nearest qty unit:

`allowanceQty = roundNearest(sizeAllowanceUsd × quantityScale / price)`

- Perps: `quantityScale = 1e6` (same as on-chain quantity decimals).
- Futures: `quantityScale = 1` (size is whole contracts; 1 contract ≈ `$price`).

Then `|have − want|` is compared to `allowanceQty`:

- `delta ≤ allowanceQty` → treat as matched (no reduce, no top-up).
- `have > want` and above allowance → **downsize** from the trailing order (FIFO kept):
  1. Trailing `size <= excess` → cancel whole order, continue.
  2. Trailing `size > excess` → reduce-only amend to `size - excess`.
- `have < want` and above allowance → **place** only the deficit at that price.

At ~`$95` hashprice, a `$50` allowance rounds to **1 contract** on futures and ~0.5 qty units on perps. Band price allowance does not affect this size check.

## Requote gates (`shouldRequote`)

| Gate | Condition | Threshold |
|---|---|---|
| Cooldown | elapsed since last requote | `requoteCooldownSec` (×3 if gas-budget throttled) |
| Order-count deficit | `ownOrders.size < desired.length` | — |
| Quantity deficit | on-grid size shortfall above size allowance | `staleSizeAllowanceUsd` |
| Stale / excess | band cancels or on-grid downsizes exist | `staleBandAllowanceUsd` + `staleSizeAllowanceUsd` |

Mid drift is **not** a requote trigger (band + size allowance cover structural changes). Drift is only used after a requote is already warranted: gas spike may still defer unless drift ≥ `urgentRequoteThresholdTicks`.

With band allowance, small grid slides that stay inside `worst ± bandAllowance` avoid cancel storms; new levels still place when the size delta exceeds the size allowance.

## Related knobs

| Knob | Role |
|---|---|
| `timing.staleBandAllowanceUsd` | Outward keep-zone price allowance |
| `timing.staleSizeAllowanceUsd` | On-grid size allowance (reduce and top-up) |
| `timing.levelSpacingTicks` / `sizing.numLevelsPerSide` | Where worst desired edge sits |
| Spreads / vol / skew | Move the grid |
| `risk.maxUtilizationPct` / position caps | Drop a side → cancel that side |
| Gas budget / spike knobs | Throttle or defer requotes |

## Full cancel-all

Risk halt, shutdown with `cancelOrdersOnShutdown: true`, futures roll drop, health `/stop` — outside per-tick band diff.
