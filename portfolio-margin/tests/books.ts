import type { FuturesRestingOrders, RestingOrders } from "../src/types.ts";

/** One price level: `[price, |quantity|]`, in the venue's own units. */
export type Level = readonly [price: bigint, quantity: bigint];

/** A resting book from its price levels, reduced to the moments the venue stores. */
export function book(
  bids: readonly Level[] = [],
  asks: readonly Level[] = [],
): RestingOrders {
  const side = (levels: readonly Level[]) => {
    let qty = 0n;
    let pq = 0n;
    let p2q = 0n;
    for (const [price, quantity] of levels) {
      qty += quantity;
      pq += price * quantity;
      p2q += price * price * quantity;
    }
    return { qty, pq, p2q };
  };
  const buy = side(bids);
  const sell = side(asks);
  return {
    buyQty: buy.qty,
    sellQty: sell.qty,
    buyPQ: buy.pq,
    buyP2Q: buy.p2q,
    sellPQ: sell.pq,
    sellP2Q: sell.p2q,
  };
}

/** One unsettled futures expiry's book. */
export function futuresBook(
  expirationAt: bigint,
  bids: readonly Level[] = [],
  asks: readonly Level[] = [],
  settlementPrice = 0n,
): FuturesRestingOrders {
  return { ...book(bids, asks), expirationAt, settlementPrice };
}
