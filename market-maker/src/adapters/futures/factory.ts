import { encodeFunctionData, erc20Abi } from "viem";
import type { Log, WatchContractEventReturnType } from "viem";
import type pino from "pino";
import {
  type AdapterFactoryContext,
  type CollateralSnapshot,
  type InstrumentAdapter,
  type InstrumentContext,
  type OrderBookSnapshot,
  type OwnOrder,
  type Position,
  type Unsubscribe,
  type VenueAdapter,
  type VenueEvent,
  type WalletContext,
  registerAdapter,
} from "../../index.ts";
import { futuresAbi } from "./abi.ts";

const FUTURES_INSTRUMENT_ID = "futures";

interface FuturesVenueOptions {
  ctx: AdapterFactoryContext;
  address: `0x${string}`;
  wallet: WalletContext;
  logger: pino.Logger;
}

/**
 * Tracks a matched position so we can reverse it when it's closed.
 * Each PositionCreated event represents one unit (qty = ±1).
 */
interface TrackedPosition {
  isBuy: boolean;
  price: bigint;
}

type FuturesLog = Log<bigint, number, false, undefined, false, typeof futuresAbi>;

export class FuturesVenueAdapter implements VenueAdapter {
  readonly kind = "futures" as const;
  readonly wallet: WalletContext;
  readonly publicClient: AdapterFactoryContext["network"]["publicClient"];
  readonly chain: AdapterFactoryContext["network"]["chain"];
  readonly transport: AdapterFactoryContext["network"]["transport"];
  readonly address: `0x${string}`;

  private readonly logger: pino.Logger;
  private collateralTokenCache: `0x${string}` | null = null;

  /** Open own orders, keyed by orderId. Updated by events + bootstrapFromHistory. */
  readonly ownOrders = new Map<`0x${string}`, OwnOrder>();

  /** Open positions we are party to, keyed by positionId. */
  private readonly openPositions = new Map<`0x${string}`, TrackedPosition>();

  /** Net signed quantity across all open positions (+long, -short). */
  netQuantity = 0n;

  /** Average price across open positions (rough P&L reference). */
  entryPrice = 0n;

  constructor(opts: FuturesVenueOptions) {
    this.wallet = opts.wallet;
    this.publicClient = opts.ctx.network.publicClient;
    this.chain = opts.ctx.network.chain;
    this.transport = opts.ctx.network.transport;
    this.address = opts.address;
    this.logger = opts.logger.child({ component: "futures-venue" });
  }

  async listInstruments(): Promise<InstrumentAdapter[]> {
    return [new FuturesInstrumentAdapter(this)];
  }

  async getCollateralTokenAddress(): Promise<`0x${string}`> {
    if (this.collateralTokenCache) return this.collateralTokenCache;
    this.collateralTokenCache = await this.publicClient.readContract({
      address: this.address,
      abi: futuresAbi,
      functionName: "token",
    });
    return this.collateralTokenCache;
  }

  async getCollateral(): Promise<CollateralSnapshot> {
    const collateralTokenAddress = await this.getCollateralTokenAddress();
    const owner = this.wallet.account.address;

    const [balance, walletTokenBalance, minMarginSigned, nativeBalance] = await Promise.all([
      this.publicClient.readContract({
        address: this.address,
        abi: futuresAbi,
        functionName: "balanceOf",
        args: [owner],
      }),
      this.publicClient.readContract({
        address: collateralTokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
      this.publicClient.readContract({
        address: this.address,
        abi: futuresAbi,
        functionName: "getMinMargin",
        args: [owner],
      }),
      this.publicClient.getBalance({ address: owner }),
    ]);

    return {
      balance,
      walletTokenBalance,
      maintenanceMargin: minMarginSigned < 0n ? 0n : minMarginSigned,
      nativeBalance,
      collateralTokenAddress,
    };
  }

  async topUpCollateral(amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    const collateralTokenAddress = await this.getCollateralTokenAddress();

    this.logger.info({ amount: amount.toString() }, "approving collateral token");
    const approveHash = await this.wallet.walletClient.writeContract({
      address: collateralTokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.address, amount],
      account: this.wallet.account,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approveHash });

    this.logger.info({ amount: amount.toString() }, "adding margin to futures contract");
    const marginHash = await this.wallet.walletClient.writeContract({
      address: this.address,
      abi: futuresAbi,
      functionName: "addMargin",
      args: [amount],
      account: this.wallet.account,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: marginHash });
  }

  async multicall(calls: `0x${string}`[], opts: { maxFeePerGas?: bigint } = {}): Promise<`0x${string}`> {
    return await this.wallet.walletClient.writeContract({
      address: this.address,
      abi: futuresAbi,
      functionName: "multicall",
      args: [calls],
      account: this.wallet.account,
      chain: this.chain,
      maxFeePerGas: opts.maxFeePerGas,
    });
  }

  subscribeVenueEvents(handler: (event: VenueEvent) => void): Unsubscribe {
    const ownAddress = this.wallet.account.address.toLowerCase();
    const unwatch: WatchContractEventReturnType = this.publicClient.watchContractEvent({
      address: this.address,
      abi: futuresAbi,
      onLogs: (logs) => {
        for (const log of logs) {
          const evt = this._decodeAndApply(log as FuturesLog, ownAddress);
          if (evt) handler(evt);
        }
      },
    });
    return () => unwatch();
  }

  /**
   * Seed in-memory order/position state from on-chain event history.
   * Called once at startup, before live event subscription begins.
   * If fromBlock is omitted, scans the last 1000 blocks.
   */
  async bootstrapFromHistory(opts: { fromBlock?: bigint } = {}): Promise<void> {
    const owner = this.wallet.account.address;
    const fromBlock = opts.fromBlock ?? (await this._defaultFromBlock());

    this.logger.info({ fromBlock: fromBlock.toString() }, "bootstrapping futures state from history");

    // Seed own orders from OrderCreated / OrderClosed events.
    const [createdLogs, closedLogs] = await Promise.all([
      this.publicClient.getContractEvents({
        address: this.address,
        abi: futuresAbi,
        eventName: "OrderCreated",
        args: { participant: owner },
        fromBlock,
        toBlock: "latest",
      }),
      this.publicClient.getContractEvents({
        address: this.address,
        abi: futuresAbi,
        eventName: "OrderClosed",
        args: { participant: owner },
        fromBlock,
        toBlock: "latest",
      }),
    ]);

    for (const log of createdLogs) {
      const { orderId, pricePerDay, isBuy } = log.args;
      if (!orderId || pricePerDay === undefined || isBuy === undefined) continue;
      this.ownOrders.set(orderId, {
        orderId,
        price: pricePerDay,
        quantity: isBuy ? 1n : -1n,
        instrumentId: FUTURES_INSTRUMENT_ID,
      });
    }
    for (const log of closedLogs) {
      const { orderId } = log.args;
      if (orderId) this.ownOrders.delete(orderId);
    }

    // Seed positions from PositionCreated events (indexed on buyer and seller separately).
    const [buyerPositionLogs, sellerPositionLogs] = await Promise.all([
      this.publicClient.getContractEvents({
        address: this.address,
        abi: futuresAbi,
        eventName: "PositionCreated",
        args: { buyer: owner },
        fromBlock,
        toBlock: "latest",
      }),
      this.publicClient.getContractEvents({
        address: this.address,
        abi: futuresAbi,
        eventName: "PositionCreated",
        args: { seller: owner },
        fromBlock,
        toBlock: "latest",
      }),
    ]);

    for (const log of buyerPositionLogs) {
      const { positionId, buyPricePerDay } = log.args;
      if (!positionId || buyPricePerDay === undefined) continue;
      this.openPositions.set(positionId, { isBuy: true, price: buyPricePerDay });
      this.netQuantity += 1n;
    }
    for (const log of sellerPositionLogs) {
      const { positionId, sellPricePerDay } = log.args;
      if (!positionId || sellPricePerDay === undefined) continue;
      this.openPositions.set(positionId, { isBuy: false, price: sellPricePerDay });
      this.netQuantity -= 1n;
    }

    // Walk PositionClosed events and reverse any positions we were part of.
    if (this.openPositions.size > 0) {
      const myPositionIds = new Set(this.openPositions.keys());
      const closedPositionLogs = await this.publicClient.getContractEvents({
        address: this.address,
        abi: futuresAbi,
        eventName: "PositionClosed",
        fromBlock,
        toBlock: "latest",
      });
      for (const log of closedPositionLogs) {
        const { positionId } = log.args;
        if (!positionId || !myPositionIds.has(positionId)) continue;
        const pos = this.openPositions.get(positionId);
        if (!pos) continue;
        this.netQuantity += pos.isBuy ? -1n : 1n;
        this.openPositions.delete(positionId);
      }
    }

    this._recalcEntryPrice();

    this.logger.info(
      {
        orders: this.ownOrders.size,
        netQuantity: this.netQuantity.toString(),
        openPositions: this.openPositions.size,
      },
      "bootstrap complete",
    );
  }

  /** Decode a contract event log, update in-memory state, and return a VenueEvent. */
  _decodeAndApply(log: FuturesLog, ownAddressLower: string): VenueEvent | null {
    switch (log.eventName) {
      case "OrderCreated": {
        const { orderId, participant, pricePerDay, isBuy } = log.args;
        if (!orderId || !participant || pricePerDay === undefined || isBuy === undefined) return null;
        const isOwn = participant.toLowerCase() === ownAddressLower;
        const order: OwnOrder = {
          orderId,
          price: pricePerDay,
          quantity: isBuy ? 1n : -1n,
          instrumentId: FUTURES_INSTRUMENT_ID,
        };
        if (isOwn) this.ownOrders.set(orderId, order);
        return { type: "order-created", order, isOwn };
      }

      case "OrderClosed": {
        const { orderId, participant } = log.args;
        if (!orderId || !participant) return null;
        const isOwn = participant.toLowerCase() === ownAddressLower;
        if (isOwn) this.ownOrders.delete(orderId);
        return { type: "order-cancelled", orderId, isOwn, instrumentId: FUTURES_INSTRUMENT_ID };
      }

      case "PositionCreated": {
        const { positionId, seller, buyer, buyPricePerDay, sellPricePerDay } = log.args;
        if (!positionId || !seller || !buyer || buyPricePerDay === undefined || sellPricePerDay === undefined) {
          return null;
        }
        const isBuyer = buyer.toLowerCase() === ownAddressLower;
        const isSeller = seller.toLowerCase() === ownAddressLower;
        if (isBuyer) {
          this.openPositions.set(positionId, { isBuy: true, price: buyPricePerDay });
          this.netQuantity += 1n;
          this._recalcEntryPrice();
        } else if (isSeller) {
          this.openPositions.set(positionId, { isBuy: false, price: sellPricePerDay });
          this.netQuantity -= 1n;
          this._recalcEntryPrice();
        }
        return isBuyer || isSeller
          ? { type: "position-changed", instrumentId: FUTURES_INSTRUMENT_ID }
          : null;
      }

      case "PositionClosed": {
        const { positionId } = log.args;
        if (!positionId) return null;
        const pos = this.openPositions.get(positionId);
        if (!pos) return null;
        this.netQuantity += pos.isBuy ? -1n : 1n;
        this.openPositions.delete(positionId);
        this._recalcEntryPrice();
        return { type: "position-changed", instrumentId: FUTURES_INSTRUMENT_ID };
      }

      default:
        return null;
    }
  }

  private async _defaultFromBlock(): Promise<bigint> {
    const latest = await this.publicClient.getBlockNumber();
    return latest > 1000n ? latest - 1000n : 0n;
  }

  private _recalcEntryPrice(): void {
    if (this.openPositions.size === 0) {
      this.entryPrice = 0n;
      return;
    }
    let sum = 0n;
    for (const { price } of this.openPositions.values()) {
      sum += price;
    }
    this.entryPrice = sum / BigInt(this.openPositions.size);
  }
}

class FuturesInstrumentAdapter implements InstrumentAdapter {
  readonly id = FUTURES_INSTRUMENT_ID;
  readonly venue: FuturesVenueAdapter;

  /**
   * Nearest delivery date, cached from the last getContext() call.
   * Must be populated before buildCreateCalldata() is called.
   * getContext() is invoked by Quoter.initialize() before any order building.
   */
  private cachedDeliveryDate: bigint | null = null;

  constructor(venue: FuturesVenueAdapter) {
    this.venue = venue;
  }

  async getIndexPrice(): Promise<bigint> {
    return await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: futuresAbi,
      functionName: "getMarketPrice",
    });
  }

  async getMinTick(): Promise<bigint> {
    return await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: futuresAbi,
      functionName: "minimumPriceIncrement",
    });
  }

  async getOwnOrders(): Promise<OwnOrder[]> {
    return Array.from(this.venue.ownOrders.values());
  }

  async getPosition(): Promise<Position> {
    return {
      netQuantity: this.venue.netQuantity,
      entryPrice: this.venue.entryPrice,
    };
  }

  async getContext(): Promise<InstrumentContext> {
    const [deliveryDates, durationDays] = await Promise.all([
      this.venue.publicClient.readContract({
        address: this.venue.address,
        abi: futuresAbi,
        functionName: "getDeliveryDates",
      }),
      this.venue.publicClient.readContract({
        address: this.venue.address,
        abi: futuresAbi,
        functionName: "deliveryDurationDays",
      }),
    ]);

    if (deliveryDates.length === 0) {
      throw new Error("futures contract returned no delivery dates");
    }

    this.cachedDeliveryDate = deliveryDates[0];

    return {
      deliveryDate: Number(deliveryDates[0]),
      contractMultiplier: BigInt(durationDays),
    };
  }

  async getOrderBookSnapshot(_opts?: { depth?: number }): Promise<OrderBookSnapshot> {
    // The futures contract exposes no on-chain order book depth query.
    // The BookTracker will rely on live events for best bid/ask tracking.
    return { bids: [], asks: [] };
  }

  buildCancelCalldata(orderId: `0x${string}`): `0x${string}` {
    return encodeFunctionData({
      abi: futuresAbi,
      functionName: "closeOrder",
      args: [orderId],
    });
  }

  /**
   * Encode a createOrder calldata.
   * Uses the nearest delivery date cached from the last getContext() call.
   * Throws if getContext() has not been called yet (enforced by Quoter.initialize()).
   * quantity is a signed integer (positive = buy, negative = sell).
   */
  buildCreateCalldata(price: bigint, quantity: bigint): `0x${string}` {
    if (this.cachedDeliveryDate === null) {
      throw new Error(
        "FuturesInstrumentAdapter.getContext() must be called before buildCreateCalldata()",
      );
    }
    const qty = Number(quantity);
    if (qty < -128 || qty > 127) {
      throw new Error(`Futures quantity ${qty} out of int8 range`);
    }
    return encodeFunctionData({
      abi: futuresAbi,
      functionName: "createOrder",
      args: [price, this.cachedDeliveryDate, "", qty as number & { readonly __int8__: true }],
    });
  }

  async estimateCreateGas(account: `0x${string}`): Promise<bigint> {
    if (this.cachedDeliveryDate === null) return 0n;
    try {
      return await this.venue.publicClient.estimateContractGas({
        address: this.venue.address,
        abi: futuresAbi,
        functionName: "createOrder",
        args: [1_000_000n, this.cachedDeliveryDate, "", 1],
        account,
      });
    } catch {
      return 0n;
    }
  }
}

/** Register the futures adapter factory. Idempotent. */
let registered = false;
export function registerFuturesAdapter(): void {
  if (registered) return;
  registered = true;
  registerAdapter("futures", async (ctx) => {
    const wallet = ctx.wallets.get(ctx.config.venue.wallet);
    const adapter = new FuturesVenueAdapter({
      ctx,
      address: ctx.config.venue.address,
      wallet,
      logger: ctx.logger,
    });
    await adapter.bootstrapFromHistory({
      fromBlock:
        ctx.config.venue.eventsFromBlock !== undefined
          ? BigInt(ctx.config.venue.eventsFromBlock)
          : undefined,
    });
    return adapter;
  });
}
