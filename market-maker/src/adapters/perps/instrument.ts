import { encodeFunctionData } from "viem";
import type pino from "pino";
import type {
  BookSource,
  CancelIntent,
  DepthLevel,
  ExecuteOrdersIntent,
  ExecuteOrdersResult,
  InstrumentAdapter,
  InstrumentContext,
  OrderBookSnapshot,
  OrderIntent,
  OwnOrder,
  OwnOrderEvent,
  OwnOrderSource,
  Position,
  ReduceIntent,
  Unsubscribe,
} from "../../core/adapter.ts";
import { TimeInForce } from "../../core/adapter.ts";
import { HashPowerPerpsDEXAbi } from "perps-contracts/abi/HashPowerPerpsDEX.ts";
import { calculateNotional, fillLossFromNotionals } from "../../core/math.ts";
import type { PerpsVenueAdapter } from "./venue.ts";

const PERPS_INSTRUMENT_ID = "perps";

export class PerpsInstrumentAdapter implements InstrumentAdapter {
  readonly id = PERPS_INSTRUMENT_ID;
  readonly venue: PerpsVenueAdapter;
  readonly book: BookSource;
  readonly ownOrders: OwnOrderSource;

  private tickCache: bigint | null = null;

  constructor(venue: PerpsVenueAdapter) {
    this.venue = venue;
    this.book = new PerpsBook(this);
    this.ownOrders = new PerpsOwnOrders(this);
  }

  async getIndexPrice(): Promise<bigint> {
    // Read the raw oracle answer rebased to token decimals — `HashPowerPerpsDEX.getMarketPrice`
    // would round to the nearest tick, which collapses our reservation-price
    // shift onto a tick boundary and forces a 2-tick min spread. The unrounded
    // mid lets `roundDownToTick(r) → bidMid` and `roundUpToTick(r) → askMid`
    // produce a 1-tick spread naturally.
    return await this.venue.getRawMarketPrice();
  }

  async getPosition(): Promise<Position> {
    const owner = this.venue.wallet.account.address;
    const pos = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getUserPosition",
      args: [owner],
    });
    return {
      netQuantity: pos.netQuantity,
      entryPrice: pos.aggregatedEntryPrice,
    };
  }

  async getContext(): Promise<InstrumentContext> {
    // Eagerly cache the IM spot shock so `estimateOrderMargin` is synchronous.
    await this.venue.fetchImSpotShock();
    return {};
  }

  encodeCreate(intent: OrderIntent): `0x${string}` {
    // Perps' createOrder takes a SIGNED quantity (positive = buy, negative = sell).
    const signed = intent.side === "buy" ? intent.size : -intent.size;
    // Local ABI fragment until published perps-contracts carries the time-in-force arg.
    const createOrderAbi = [
      {
        type: "function",
        name: "createOrder",
        stateMutability: "nonpayable",
        inputs: [
          { name: "_price", type: "uint256" },
          { name: "_quantity", type: "int256" },
          { name: "_tif", type: "uint8" },
        ],
        outputs: [],
      },
    ] as const;
    return encodeFunctionData({
      abi: createOrderAbi,
      functionName: "createOrder",
      args: [intent.price, signed, TimeInForce.GTC],
    });
  }

  encodeUpdateOrders(
    cancels: CancelIntent[],
    reduces: ReduceIntent[],
    creates: OrderIntent[],
  ): `0x${string}` {
    // Local ABI fragment until published perps-contracts includes the reduces arg.
    const updateOrdersAbi = [
      {
        type: "function",
        name: "updateOrders",
        stateMutability: "nonpayable",
        inputs: [
          { name: "_cancelIds", type: "bytes32[]" },
          {
            name: "_reduces",
            type: "tuple[]",
            components: [
              { name: "orderId", type: "bytes32" },
              { name: "newQuantity", type: "int256" },
            ],
          },
          {
            name: "_intents",
            type: "tuple[]",
            components: [
              { name: "price", type: "uint256" },
              { name: "quantity", type: "int256" },
              { name: "timeInForce", type: "uint8" },
            ],
          },
        ],
        outputs: [],
      },
    ] as const;
    const reduceBatch = reduces.map((r) => {
      if (r.newSize <= 0n) {
        throw new Error(`perps: reduce newSize ${r.newSize} must be > 0`);
      }
      return {
        orderId: r.orderId,
        newQuantity: r.side === "buy" ? r.newSize : -r.newSize,
      };
    });
    const batch = creates.map((intent) => ({
      price: intent.price,
      quantity: intent.side === "buy" ? intent.size : -intent.size,
      timeInForce: TimeInForce.GTC,
    }));
    return encodeFunctionData({
      abi: updateOrdersAbi,
      functionName: "updateOrders",
      args: [cancels.map((c) => c.orderId), reduceBatch, batch],
    });
  }

  encodeCancel(intent: CancelIntent): `0x${string}` {
    return encodeFunctionData({
      abi: HashPowerPerpsDEXAbi,
      functionName: "cancelOrder",
      args: [intent.orderId],
    });
  }

  /**
   * Execute cancels + reduces + creates via `updateOrders` (IM checked once).
   */
  async executeOrders(
    intent: ExecuteOrdersIntent,
  ): Promise<ExecuteOrdersResult> {
    return this.executeOrdersImpl(intent, this.venue.getLogger());
  }

  // ── Private implementation ──────────────────────────────────────────

  /**
   * Shared implementation — the inner `logger` param makes this testable
   * without coupling to the full venue adapter.
   */
  private async executeOrdersImpl(
    intent: ExecuteOrdersIntent,
    logger: pino.Logger,
  ): Promise<ExecuteOrdersResult> {
    const reduces = intent.reduces ?? [];
    if (intent.cancels.length === 0 && reduces.length === 0 && intent.creates.length === 0) {
      return { receipts: [], errors: [] };
    }

    const data = this.encodeUpdateOrders(intent.cancels, reduces, intent.creates);

    if (intent.dryRun) {
      logger.info(
        {
          cancels: intent.cancels.length,
          reduces: reduces.length,
          creates: intent.creates.length,
        },
        "DRY RUN: would send updateOrders",
      );
      return { receipts: [], errors: [] };
    }

    try {
      const hash = await this.venue.sendCall(data, {
        maxFeePerGas: intent.maxFeePerGas,
      });
      const receipt = await this.venue.publicClient.waitForTransactionReceipt({
        hash,
      });
      logger.info(
        {
          cancels: intent.cancels.length,
          reduces: reduces.length,
          creates: intent.creates.length,
          gas: receipt.gasUsed.toString(),
        },
        "perps updateOrders executed",
      );
      return {
        receipts: [
          { gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice },
        ],
        errors: [],
      };
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: wrapped }, "perps updateOrders failed");
      return { receipts: [], errors: [wrapped] };
    }
  }

  /**
   * Upper bound on the IM a single new resting order adds, matching the two terms
   * `PortfolioMarginEngine` charges for it:
   *
   *   IM_added ≤ imSpotShock × mark × size / 1e18   (its delta joins one stress leg)
   *            + max(0, size × (limit − mark))       (bid) or
   *              max(0, size × (mark − limit))       (ask)
   *
   * A bound rather than the exact figure, deliberately, and for a reason that is now
   * structural rather than a convenience: the engine takes the *worse* of the
   * `netDelta + buyOrderDelta` and `netDelta − sellOrderDelta` legs, so a single
   * order's true marginal cost depends on the whole portfolio's net delta and can be
   * zero when the order moves the account toward flat. Charging it the full stress on
   * its own delta can only over-estimate: adding buy delta cannot raise the sell leg,
   * and vice versa. The `engine.canPlaceOrder` gate therefore has slack, not slop.
   *
   * The mark price matters here and did not before. The old estimate used the order's
   * *limit* price against the shock and nothing else, which under-charged both an
   * aggressive bid (whose fill loss is the dominant term) and a deep one (whose stress
   * is set by the mark, not the limit).
   *
   * Returns 0n if `imSpotShock` or the mark haven't been cached yet — caller treats
   * "0 additional" as "no information; proceed", which is fine on first
   * tick because the engine itself enforces the floor.
   */
  estimateOrderMargin(intent: OrderIntent): bigint {
    // Ensure the venue has a cached spot shock; if not, fall back to the
    // no-op estimate. The first canPlace call is allowed through optimistically.
    // The cached value is fetched lazily by `account.imSpotShock()` and cached.
    const cached = (this.venue as unknown as { imSpotShockCache?: bigint })
      .imSpotShockCache;
    if (!cached) return 0n;
    const mark = this.venue.cachedMarketPrice();
    if (mark === null) return 0n;

    const stress = (calculateNotional(mark, intent.size) * cached) / 10n ** 18n;
    const fillLoss = fillLossFromNotionals(
      calculateNotional(intent.price, intent.size),
      calculateNotional(mark, intent.size),
      intent.side,
    );
    return stress + fillLoss;
  }

  async estimateCreateGas(account: `0x${string}`): Promise<bigint> {
    try {
      return await this.venue.publicClient.estimateContractGas({
        address: this.venue.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "createOrder",
        args: [1_000_000n, 1_000_000n, 0],
        account,
      });
    } catch {
      return 0n;
    }
  }

  async getMinTick(): Promise<bigint> {
    if (this.tickCache !== null) return this.tickCache;
    const tick = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "minimumPriceIncrement",
    });
    this.tickCache = tick;
    return tick;
  }
}

class PerpsBook implements BookSource {
  private readonly inst: PerpsInstrumentAdapter;
  constructor(inst: PerpsInstrumentAdapter) {
    this.inst = inst;
  }

  tick(): Promise<bigint> {
    return this.inst.getMinTick();
  }

  async snapshot(opts: { depth?: number } = {}): Promise<OrderBookSnapshot> {
    const v = this.inst.venue;
    const depth = BigInt(opts.depth ?? 200);
    const [bidPrices, askPrices] = await v.publicClient.readContract({
      address: v.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getOrderBookPrices",
      args: [depth],
    });
    if (bidPrices.length === 0 && askPrices.length === 0)
      return { bids: [], asks: [] };

    const depthCalls = [
      ...bidPrices.map((p) => ({
        address: v.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, true] as const,
      })),
      ...askPrices.map((p) => ({
        address: v.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, false] as const,
      })),
    ];
    const results = await v.publicClient.multicall({
      allowFailure: false,
      contracts: depthCalls,
    });
    const bids: DepthLevel[] = bidPrices.map((p, i) => ({
      price: p,
      quantity: results[i],
    }));
    const asks: DepthLevel[] = askPrices.map((p, i) => ({
      price: p,
      quantity: results[bidPrices.length + i],
    }));
    return { bids, asks };
  }
}

/**
 * Stateless on-chain own-order source: every `list()` call hits the chain.
 * Subscribe filters venue events to the wallet and forwards them as
 * `OwnOrderEvent`s; no internal cache is required because `list()` is the
 * source of truth.
 */
class PerpsOwnOrders implements OwnOrderSource {
  private readonly inst: PerpsInstrumentAdapter;
  constructor(inst: PerpsInstrumentAdapter) {
    this.inst = inst;
  }

  async list(): Promise<OwnOrder[]> {
    const v = this.inst.venue;
    const owner = v.wallet.account.address;
    const orderIds = await v.publicClient.readContract({
      address: v.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getUserOrders",
      args: [owner],
    });
    if (orderIds.length === 0) return [];
    const calls = orderIds.map((id) => ({
      address: v.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getOrder" as const,
      args: [id] as const,
    }));
    const results = await v.publicClient.multicall({
      allowFailure: false,
      contracts: calls,
    });
    return orderIds.map((orderId, i) => {
      const q = results[i].quantity;
      return {
        orderId,
        price: results[i].price,
        side: q > 0n ? "buy" : "sell",
        size: q > 0n ? q : -q,
        instrumentId: PERPS_INSTRUMENT_ID,
      } satisfies OwnOrder;
    });
  }

  subscribe(cb: (event: OwnOrderEvent) => void): Unsubscribe {
    const own = this.inst.venue.wallet.account.address.toLowerCase();
    return this.inst.venue.events.subscribe((evt) => {
      switch (evt.type) {
        case "order-created": {
          if (evt.participant.toLowerCase() !== own) return;
          cb({
            type: "added",
            orderId: evt.orderId,
            order: {
              orderId: evt.orderId,
              price: evt.price,
              side: evt.side,
              size: evt.size,
              instrumentId: PERPS_INSTRUMENT_ID,
            },
          });
          return;
        }
        case "order-cancelled": {
          if (!evt.participant || evt.participant.toLowerCase() !== own) return;
          cb({ type: "removed", orderId: evt.orderId });
          return;
        }
        case "order-updated": {
          if (evt.participant.toLowerCase() !== own) return;
          if (evt.newSize === 0n) {
            cb({ type: "removed", orderId: evt.orderId });
          } else {
            // Price/side come from BookTracker's existing entry; patch size only.
            cb({ type: "updated", orderId: evt.orderId, newSize: evt.newSize });
          }
          return;
        }
      }
    });
  }

  async bootstrap(_opts?: { fromBlock?: bigint }): Promise<void> {
    // No-op: list() is the source of truth and reads from chain on demand.
  }
}
