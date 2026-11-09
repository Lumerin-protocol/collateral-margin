import type {
  AccountSnapshot,
  MarginRequirement,
  MarkRange,
  MMParams,
  RestingOrders,
} from "./types.ts";

/**
 * Off-chain replica of `PortfolioMarginEngine._computeMargin`, restricted to
 * the pure-delta case (no options Greeks). Each venue reports its exposure at
 * its own marks (`getExposureView`: contracts × mark, perps at the glide, each
 * futures expiry at its mark range), and the engine stresses the sum:
 *
 *   netExposure = Σ venues' netPositionExposure (WAD-lifted)
 *
 *   stressLossWad = max over 4 (±spotShock, ±volShock) scenarios of
 *                   max(0, -(netExposure * spotShock / WAD + ½γ(deltaS)² + ν * deltaVol))
 *
 * For our pure-delta portfolios (γ=ν=0), the worst scenario is the one where
 * the shock opposes `netExposure`, giving `|netExposure| * spotShock / WAD` in
 * WAD. We then rescale to token decimals exactly the way `_fromWad` does.
 *
 * Marks are read once, at the snapshot's index, and follow the index in
 * proportion when the replica is evaluated at another index P (`markAt`): the
 * glide and the mark ranges are the index times a schedule factor.
 *
 * Resting orders are not a separate margin term any more. The engine runs that
 * stress twice — once at `netExposure + buyOrderExposure`, once at
 * `netExposure − sellOrderExposure` — and keeps the worse leg, which upper-bounds
 * the requirement after any subset of the account's orders fills. So the stress
 * term here is `max(|net + buy|, |net − sell|) × shock`, and the add-ons are:
 *
 *   - fillLoss(P): each side's Scarf bound from its quantity and price moments
 *     (`fillLossBound`), perps once and futures per expiry, charged in both legs
 *   - the unrealized-PnL term, the one place the two requirements differ in
 *     *shape* rather than just in shock:
 *
 *       IM: max(0, −perpPnl(P)) + max(0, −futuresPnl(P))
 *       MM: max(0, −(perpPnl(P) + futuresPnl(P)))
 *
 *     with one signed PnL per *venue* — `futuresPnl` already netted across every
 *     expiry, because that is the single number `Futures.getRiskView` hands the
 *     engine. IM clamps the two venues separately and so ignores gains entirely;
 *     MM clamps their sum once, so a gain at one venue offsets a loss at the other.
 *   - perp.fundingOwed (constant — short-term, refreshed on snapshot)
 *   - accountDebt (constant — unpaid loss owed to the insurance fund)
 *
 * Every term is convex in P. Stress is linear, the unrealized-PnL clamps are
 * piecewise-linear, and the fill-loss bound is a smooth hyperbola in the mark. The
 * unrealized-PnL kinks differ per requirement: on the IM path, one venue-aggregate
 * breakeven each (the perp's entry price, and the futures venue's netted breakeven
 * across all expiries); on the MM path a single portfolio-wide breakeven, which is
 * generally not any leg's entry price. `solve.ts` enumerates them. We deliberately
 * keep the math straight (no over-engineered piecewise representation) —
 * `mmRequired` is cheap and the solver bisects within each interval.
 *
 * All bigint arithmetic. Token-decimal rounding matches PME's integer division.
 */

const WAD = 10n ** 18n;

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * A mark read at the snapshot's index, moved to index `P`: `mark · P / index`. Without a
 * recorded mark (or index) the leg marks at the index itself.
 */
export function markAt(
  snap: AccountSnapshot,
  mark: bigint | undefined,
  P: bigint,
): bigint {
  if (mark === undefined || snap.index === undefined || snap.index === 0n)
    return P;
  return (mark * P) / snap.index;
}

/** The perps mark at index `P`. */
export function perpMark(snap: AccountSnapshot, P: bigint): bigint {
  return markAt(snap, snap.perp.mark, P);
}

/** A live futures expiry's mark at index `P` for the side valued: longs and bids at `low`, shorts and asks at `high`. */
export function futuresMark(
  snap: AccountSnapshot,
  range: MarkRange,
  isLong: boolean,
  P: bigint,
): bigint {
  return markAt(snap, isLong ? range.low : range.high, P);
}

/** A futures book's bid and ask marks at index `P`: both its settlement price once pinned. */
function bookMarks(
  snap: AccountSnapshot,
  book: AccountSnapshot["futures"]["orders"][number],
  P: bigint,
): [bigint, bigint] {
  if (book.settlementPrice !== 0n)
    return [book.settlementPrice, book.settlementPrice];
  return [futuresMark(snap, book, true, P), futuresMark(snap, book, false, P)];
}

/**
 * Net position exposure in token decimals at index `P`, as the venues' `getExposureView`
 * reports it: perps contracts × its mark (de-scaled, truncated toward zero), plus each live
 * futures expiry's contracts × its mark for the side held. A settled expiry carries none.
 */
export function netExposure(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): bigint {
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  let exposure = (snap.perp.netQty * perpMark(snap, P)) / perpQtyScale;
  for (const pos of snap.futures.positions) {
    if (pos.settlementPrice !== 0n) continue;
    exposure +=
      pos.netQuantity * futuresMark(snap, pos, pos.netQuantity > 0n, P);
  }
  return exposure;
}

/**
 * Resting order exposure per side in token decimals at index `P`: perps at its mark, each
 * futures book's bids at `low` and asks at `high` (its settlement price once pinned).
 */
export function orderExposure(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): { buy: bigint; sell: bigint } {
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  const mark = perpMark(snap, P);
  let buy = (snap.perp.orders.buyQty * mark) / perpQtyScale;
  let sell = (snap.perp.orders.sellQty * mark) / perpQtyScale;
  for (const book of snap.futures.orders) {
    const [bid, ask] = bookMarks(snap, book, P);
    buy += book.buyQty * bid;
    sell += book.sellQty * ask;
  }
  return { buy, sell };
}

/**
 * Net delta of *positions only*, in WAD: contracts, not exposure. The requirement
 * stresses `netExposure` (contracts at each leg's mark); this stays for callers that
 * reason in contracts, and equals exposure / P while every mark is the index.
 *
 *   perpDelta = perpNetQty * WAD / 10^perpQtyDecimals
 *   futuresDelta = sum_i netQuantity_i * WAD   over *unsettled* expiries only
 *
 * Settled-but-unswept expiries are skipped, matching `Futures.getRiskView`, which
 * folds an expiry into `netPositionDelta` only while `settlementPrice` is still
 * zero. Once the price is pinned the leg cannot move with spot, so stressing it
 * would charge for risk that no longer exists.
 *
 * Note: the on-chain `getNetPositionDelta` already returns this sum for the
 * futures leg; we re-derive it here off-chain because the snapshot carries
 * per-expiry aggregates (needed by the per-expiry close solver) and re-using them
 * avoids a second contract call. Both paths converge on the same value.
 */
export function netDeltaWad(snap: AccountSnapshot, params: MMParams): bigint {
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  let delta = (snap.perp.netQty * WAD) / perpQtyScale;
  for (const pos of snap.futures.positions) {
    if (pos.settlementPrice !== 0n) continue;
    delta += pos.netQuantity * WAD;
  }
  return delta;
}

/**
 * Order delta per side summed across venues, lifted to WAD. Venues report it
 * scaled by `10^tokenDecimals`, the same convention as `netPositionDelta`: perps
 * quantity de-scaled from its own decimals, futures whole contracts.
 */
export function orderDeltaWad(
  snap: AccountSnapshot,
  params: MMParams,
): {
  buy: bigint;
  sell: bigint;
} {
  const tokenScale = 10n ** BigInt(params.tokenDecimals);
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  let buy = (snap.perp.orders.buyQty * tokenScale) / perpQtyScale;
  let sell = (snap.perp.orders.sellQty * tokenScale) / perpQtyScale;
  for (const book of snap.futures.orders) {
    buy += book.buyQty * tokenScale;
    sell += book.sellQty * tokenScale;
  }
  const lift = 10n ** BigInt(18 - params.tokenDecimals);
  return { buy: buy * lift, sell: sell * lift };
}

/**
 * Scale a WAD-denominated value down to token decimals using PME's exact
 * convention (integer division by `10^(18 - tokenDecimals)`).
 */
function fromWad(wadValue: bigint, tokenDecimals: number): bigint {
  return wadValue / 10n ** BigInt(18 - tokenDecimals);
}

/**
 * Stress loss in token decimals on a delta in contracts valued at P:
 *
 *   |delta| * shock * P_wad / WAD²    (in WAD)
 *
 * where P_wad = P_token * 10^(18 - tokenDecimals). The engine's figure for a delta
 * valued at the index (options); linear markets go through `exposureStressLoss`.
 */
export function stressLoss(
  delta: bigint,
  shock: bigint,
  P: bigint,
  tokenDecimals: number,
): bigint {
  const Pwad = P * 10n ** BigInt(18 - tokenDecimals);
  const stressWad = (abs(delta) * shock * Pwad) / (WAD * WAD);
  return fromWad(stressWad, tokenDecimals);
}

/**
 * Stress loss in token decimals on an exposure in token decimals: `_worstStressLoss` on the
 * WAD-lifted exposure, `|exposure| · shock / WAD`, rescaled like `_fromWad`.
 */
export function exposureStressLoss(
  exposure: bigint,
  shock: bigint,
  tokenDecimals: number,
): bigint {
  const exposureWad = abs(exposure) * 10n ** BigInt(18 - tokenDecimals);
  return fromWad((exposureWad * shock) / WAD, tokenDecimals);
}

/**
 * Worse of the two fill legs, in token decimals: the engine stresses
 * `netExposure + buyOrderExposure` and `netExposure − sellOrderExposure` and takes
 * the maximum.
 */
export function worstLegStressLoss(
  snap: AccountSnapshot,
  params: MMParams,
  shock: bigint,
  P: bigint,
): bigint {
  const net = netExposure(snap, params, P);
  const order = orderExposure(snap, params, P);
  const buyLeg = exposureStressLoss(
    net + order.buy,
    shock,
    params.tokenDecimals,
  );
  const sellLeg = exposureStressLoss(
    net - order.sell,
    shock,
    params.tokenDecimals,
  );
  return buyLeg > sellLeg ? buyLeg : sellLeg;
}

/** `⌈√x⌉`, matching OpenZeppelin's `Math.sqrt(x, Rounding.Ceil)`. */
function sqrtCeil(x: bigint): bigint {
  if (x < 2n) return x;
  let r = 1n << BigInt(Math.ceil(x.toString(2).length / 2));
  for (;;) {
    const next = (r + x / r) >> 1n;
    if (next >= r) break;
    r = next;
  }
  return r * r < x ? r + 1n : r;
}

/** `⌈a / b⌉` for `a ≥ 0`, matching OpenZeppelin's `Math.ceilDiv`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/**
 * Port of the venues' `MathLib.fillLossBound`: an upper bound on one side's instant
 * fill loss, `Σ q·max(0, p − m)` for bids or `Σ q·max(0, m − p)` for asks, from that
 * side's `Σq`, `Σp·q` and `Σp²·q` at mark `m`. Scarf's bound: the worst case over
 * every book with the same three sums, exact for a single price level, rounded up
 * like the contract. Units are unscaled `price · qty`.
 *
 *   bound = ½ (√(Σq · Σq(p − m)²) ± (Σp·q − m·Σq))     (+ for bids, − for asks)
 */
export function fillLossBound(
  qty: bigint,
  pq: bigint,
  p2q: bigint,
  mark: bigint,
  isBuy: boolean,
): bigint {
  const mq = mark * qty;
  const pos = p2q + mark * mq;
  const neg = 2n * mark * pq;
  const spread = pos > neg ? pos - neg : 0n;
  const root = sqrtCeil(qty * spread);
  const [up, down] = isBuy ? [pq, mq] : [mq, pq];
  if (up >= down) return (root + (up - down) + 1n) / 2n;
  const gap = down - up;
  return root > gap ? (root - gap + 1n) / 2n : 0n;
}

/**
 * One book's fill loss at `mark`, both sides, in token decimals: each side's bound
 * divided by the venue's quantity scale and rounded up, as both venues'
 * `getRiskView` report it (futures quantities are whole contracts, scale 1).
 */
export function venueFillLoss(
  orders: RestingOrders,
  mark: bigint,
  quantityScale: bigint,
): bigint {
  return bookFillLoss(orders, mark, mark, quantityScale);
}

/** `venueFillLoss` with the bids bounded at `bidMark` and the asks at `askMark`. */
export function bookFillLoss(
  orders: RestingOrders,
  bidMark: bigint,
  askMark: bigint,
  quantityScale: bigint,
): bigint {
  const buy = fillLossBound(
    orders.buyQty,
    orders.buyPQ,
    orders.buyP2Q,
    bidMark,
    true,
  );
  const sell = fillLossBound(
    orders.sellQty,
    orders.sellPQ,
    orders.sellP2Q,
    askMark,
    false,
  );
  return ceilDiv(buy, quantityScale) + ceilDiv(sell, quantityScale);
}

/**
 * Both venues' fill loss at index P. The engine charges this in both stress legs.
 * Perps bounds its book at its mark. Futures books are bounded per expiry, bids at
 * the expiry's `low` mark and asks at its `high` (both its settlement price once it
 * has one), and summed — the venue never pools expiries.
 */
export function fillLoss(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): bigint {
  let loss = venueFillLoss(
    snap.perp.orders,
    perpMark(snap, P),
    10n ** BigInt(params.perpQuantityDecimals),
  );
  for (const book of snap.futures.orders) {
    const [bid, ask] = bookMarks(snap, book, P);
    loss += bookFillLoss(book, bid, ask, 1n);
  }
  return loss;
}

/**
 * Signed perp unrealized PnL at index P (token decimals), at the perps mark plus the
 * drift not yet folded into the entry value, as the venue's `getExposureView` reports it:
 *
 *   pnl = (mark(P) - entry) * netQty / 10^perpQtyDecimals + pendingDrift
 *
 * Signed and unclamped on purpose: the clamp belongs to the requirement, not the
 * venue, and where it lands differs between IM and MM. See `unrealizedLoss`.
 */
export function perpUnrealizedPnl(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): bigint {
  if (snap.perp.netQty === 0n) return 0n;
  const perpQtyScale = 10n ** BigInt(params.perpQuantityDecimals);
  return (
    ((perpMark(snap, P) - snap.perp.entryPrice) * snap.perp.netQty) /
      perpQtyScale +
    (snap.perp.pendingDrift ?? 0n)
  );
}

/**
 * Signed futures unrealized PnL at price P (token decimals), netted across every
 * active expiry. Each whole contract settles `pricePerDay` of notional (no
 * duration multiplier):
 *
 *   pnl = sum_i (mark_i * netQuantity_i - netEntryValue_i)
 *
 * `mark_i` is the expiry's pinned `settlementPrice` when it has one and otherwise
 * its live mark at P for the side held (`low` long, `high` short), mirroring the
 * venue's per-expiry choice. A settled leg's PnL is
 * therefore constant in P: it is a realized amount awaiting a sweep, not an
 * exposure, and revaluing it at a hypothetical price would invent PnL the account
 * can no longer gain or lose.
 *
 * The netting is not an off-chain approximation — it is what the engine sees.
 * `Futures.getRiskView` accumulates one signed `totalPnl` over the participant's
 * active expiries and reports that as the market's `unrealizedPnl`; individual
 * expiries never reach the PME. Clamping per expiry (which this module used to do)
 * over-charges every calendar spread, on both the IM and the MM path.
 */
export function futuresUnrealizedPnl(snap: AccountSnapshot, P: bigint): bigint {
  let pnl = 0n;
  for (const pos of snap.futures.positions) {
    const mark =
      pos.settlementPrice !== 0n
        ? pos.settlementPrice
        : futuresMark(snap, pos, pos.netQuantity > 0n, P);
    pnl += mark * pos.netQuantity - pos.netEntryValue;
  }
  return pnl;
}

/**
 * The engine's `pnlTerm` at price P (token decimals):
 *
 *   IM: max(0, -perpPnl) + max(0, -futuresPnl)   clamped per market, gains ignored
 *   MM: max(0, -(perpPnl + futuresPnl))          clamped once, gains offset losses
 *
 * Mirrors `_linearAggregate`'s `unrealizedLossPerMarket` / `netUnrealizedPnl` pair
 * and the `isIM` pick in `_marginFromAggregate`. "Per market" means per venue:
 * there are exactly two registered linear markets, and the futures leg arrives at
 * the engine already netted across its expiries, so the IM path clamps two
 * numbers — never one per expiry.
 */
export function unrealizedLoss(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
  requirement: MarginRequirement,
): bigint {
  const perp = perpUnrealizedPnl(snap, params, P);
  const futures = futuresUnrealizedPnl(snap, P);
  if (requirement === "mm") {
    const total = perp + futures;
    return total < 0n ? -total : 0n;
  }
  return (perp < 0n ? -perp : 0n) + (futures < 0n ? -futures : 0n);
}

/**
 * Shared body of `mmRequired` / `imRequired`. The requirement selects both the
 * shock and the unrealized-PnL clamp; taking one argument rather than two keeps
 * the pair from ever disagreeing.
 */
function requiredAt(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
  requirement: MarginRequirement,
): bigint {
  const shock = requirement === "im" ? params.imSpotShock : params.mmSpotShock;
  return (
    worstLegStressLoss(snap, params, shock, P) +
    fillLoss(snap, params, P) +
    unrealizedLoss(snap, params, P, requirement) +
    snap.perp.fundingOwed +
    snap.accountDebt
  );
}

/**
 * Maintenance-margin requirement at price P. Mirrors PME's
 * `_computeMargin(user, isIM=false)` for pure-delta portfolios.
 */
export function mmRequired(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): bigint {
  return requiredAt(snap, params, P, "mm");
}

/**
 * Initial-margin requirement at price P. Same shape, with the IM shock and the
 * per-market PnL clamp.
 */
export function imRequired(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): bigint {
  return requiredAt(snap, params, P, "im");
}

/** `balance - mmRequired(P)`. Negative = liquidatable. */
export function mmSurplus(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): bigint {
  return snap.balance - mmRequired(snap, params, P);
}

/** `balance - imRequired(P)`. Negative = below IM (warn / critical band). */
export function imSurplus(
  snap: AccountSnapshot,
  params: MMParams,
  P: bigint,
): bigint {
  return snap.balance - imRequired(snap, params, P);
}
