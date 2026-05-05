import { encodeFunctionData, erc20Abi } from "viem";
import type { Log, WatchContractEventReturnType } from "viem";
import type pino from "pino";
import {
  type AdapterFactoryContext,
  type CollateralSnapshot,
  type DepthLevel,
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
import { hashPowerPerpsDexAbi, multicall3Abi } from "./abi.ts";
import { topUpCollateralWithPermit } from "./collateral.ts";

const PERPS_INSTRUMENT_ID = "perps";

interface PerpsVenueOptions {
  ctx: AdapterFactoryContext;
  address: `0x${string}`;
  wallet: WalletContext;
  logger: pino.Logger;
}

export class PerpsVenueAdapter implements VenueAdapter {
  readonly kind = "perps" as const;
  readonly wallet: WalletContext;
  readonly publicClient: AdapterFactoryContext["network"]["publicClient"];
  readonly chain: AdapterFactoryContext["network"]["chain"];
  readonly transport: AdapterFactoryContext["network"]["transport"];
  readonly address: `0x${string}`;

  private readonly logger: pino.Logger;
  private collateralTokenCache: `0x${string}` | null = null;

  constructor(opts: PerpsVenueOptions) {
    this.wallet = opts.wallet;
    this.publicClient = opts.ctx.network.publicClient;
    this.chain = opts.ctx.network.chain;
    this.transport = opts.ctx.network.transport;
    this.address = opts.address;
    this.logger = opts.logger.child({ component: "perps-venue" });
  }

  async listInstruments(): Promise<InstrumentAdapter[]> {
    return [new PerpsInstrumentAdapter(this)];
  }

  async getCollateralTokenAddress(): Promise<`0x${string}`> {
    if (this.collateralTokenCache) return this.collateralTokenCache;
    this.collateralTokenCache = await this.publicClient.readContract({
      address: this.address,
      abi: hashPowerPerpsDexAbi,
      functionName: "collateralToken",
    });
    return this.collateralTokenCache;
  }

  async getCollateral(): Promise<CollateralSnapshot> {
    const collateralTokenAddress = await this.getCollateralTokenAddress();
    const multicall3Address = this.chain.contracts?.multicall3?.address as `0x${string}` | undefined;
    if (!multicall3Address) {
      throw new Error(`chain ${this.chain.name} has no multicall3 address configured`);
    }
    const owner = this.wallet.account.address;
    const results = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: this.address, abi: hashPowerPerpsDexAbi, functionName: "balanceOf", args: [owner] },
        { address: collateralTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
        { address: this.address, abi: hashPowerPerpsDexAbi, functionName: "getMaintenanceMargin", args: [owner] },
        { address: multicall3Address, abi: multicall3Abi, functionName: "getEthBalance", args: [owner] },
      ],
    });
    return {
      balance: results[0],
      walletTokenBalance: results[1],
      maintenanceMargin: results[2],
      nativeBalance: results[3],
      collateralTokenAddress,
    };
  }

  async topUpCollateral(amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    const collateralTokenAddress = await this.getCollateralTokenAddress();
    await topUpCollateralWithPermit({
      publicClient: this.publicClient,
      walletClient: this.wallet.walletClient,
      account: this.wallet.account,
      chain: this.chain,
      perpsAddress: this.address,
      collateralTokenAddress,
      amount,
      logger: this.logger,
    });
  }

  async multicall(calls: `0x${string}`[], opts: { maxFeePerGas?: bigint } = {}): Promise<`0x${string}`> {
    return await this.wallet.walletClient.writeContract({
      address: this.address,
      abi: hashPowerPerpsDexAbi,
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
      abi: hashPowerPerpsDexAbi,
      onLogs: (logs) => {
        for (const log of logs) {
          const evt = decodeEvent(log as PerpsLog, ownAddress);
          if (evt) handler(evt);
        }
      },
    });
    return () => unwatch();
  }
}

class PerpsInstrumentAdapter implements InstrumentAdapter {
  readonly id = PERPS_INSTRUMENT_ID;
  readonly venue: PerpsVenueAdapter;

  constructor(venue: PerpsVenueAdapter) {
    this.venue = venue;
  }

  async getIndexPrice(): Promise<bigint> {
    return await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: hashPowerPerpsDexAbi,
      functionName: "getMarketPrice",
    });
  }

  async getMinTick(): Promise<bigint> {
    return await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: hashPowerPerpsDexAbi,
      functionName: "minimumPriceIncrement",
    });
  }

  async getOwnOrders(): Promise<OwnOrder[]> {
    const owner = this.venue.wallet.account.address;
    const orderIds = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [owner],
    });
    if (orderIds.length === 0) return [];
    const calls = orderIds.map((id) => ({
      address: this.venue.address,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrder" as const,
      args: [id] as const,
    }));
    const results = await this.venue.publicClient.multicall({ allowFailure: false, contracts: calls });
    return orderIds.map((orderId, i) => ({
      orderId,
      price: results[i].price,
      quantity: results[i].quantity,
      instrumentId: this.id,
    }));
  }

  async getPosition(): Promise<Position> {
    const owner = this.venue.wallet.account.address;
    const pos = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserPosition",
      args: [owner],
    });
    return { netQuantity: pos.netQuantity, entryPrice: pos.aggregatedEntryPrice };
  }

  async getContext(): Promise<InstrumentContext> {
    return {};
  }

  async getOrderBookSnapshot(opts: { depth?: number } = {}): Promise<OrderBookSnapshot> {
    const depth = BigInt(opts.depth ?? 200);
    const [bidPrices, askPrices] = await this.venue.publicClient.readContract({
      address: this.venue.address,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrderBookPrices",
      args: [depth],
    });
    if (bidPrices.length === 0 && askPrices.length === 0) {
      return { bids: [], asks: [] };
    }
    const depthCalls = [
      ...bidPrices.map((p) => ({
        address: this.venue.address,
        abi: hashPowerPerpsDexAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, true] as const,
      })),
      ...askPrices.map((p) => ({
        address: this.venue.address,
        abi: hashPowerPerpsDexAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, false] as const,
      })),
    ];
    const results = await this.venue.publicClient.multicall({
      allowFailure: false,
      contracts: depthCalls,
    });
    const bids: DepthLevel[] = bidPrices.map((p, i) => ({ price: p, quantity: results[i] }));
    const asks: DepthLevel[] = askPrices.map((p, i) => ({
      price: p,
      quantity: results[bidPrices.length + i],
    }));
    return { bids, asks };
  }

  buildCancelCalldata(orderId: `0x${string}`): `0x${string}` {
    return encodeFunctionData({
      abi: hashPowerPerpsDexAbi,
      functionName: "cancelOrder",
      args: [orderId],
    });
  }

  buildCreateCalldata(price: bigint, quantity: bigint): `0x${string}` {
    return encodeFunctionData({
      abi: hashPowerPerpsDexAbi,
      functionName: "createOrder",
      args: [price, quantity],
    });
  }

  async estimateCreateGas(account: `0x${string}`): Promise<bigint> {
    try {
      return await this.venue.publicClient.estimateContractGas({
        address: this.venue.address,
        abi: hashPowerPerpsDexAbi,
        functionName: "createOrder",
        args: [1_000_000n, 1_000_000n],
        account,
      });
    } catch {
      return 0n;
    }
  }
}

type PerpsLog = Log<bigint, number, false, undefined, false, typeof hashPowerPerpsDexAbi>;

function decodeEvent(log: PerpsLog, ownAddressLower: string): VenueEvent | null {
  switch (log.eventName) {
    case "OrderCreated": {
      const { orderId, participant, price, quantity } = log.args;
      if (!orderId || !participant || price === undefined || quantity === undefined) return null;
      const isOwn = participant.toLowerCase() === ownAddressLower;
      return {
        type: "order-created",
        order: { orderId, price, quantity, instrumentId: PERPS_INSTRUMENT_ID },
        isOwn,
      };
    }
    case "OrderCancelled": {
      const { orderId, participant } = log.args;
      if (!orderId || !participant) return null;
      return {
        type: "order-cancelled",
        orderId,
        isOwn: participant.toLowerCase() === ownAddressLower,
        instrumentId: PERPS_INSTRUMENT_ID,
      };
    }
    case "OrderUpdated": {
      const { orderId, participant, newQuantity } = log.args;
      if (!orderId || !participant || newQuantity === undefined) return null;
      return {
        type: "order-updated",
        orderId,
        newQuantity,
        isOwn: participant.toLowerCase() === ownAddressLower,
        instrumentId: PERPS_INSTRUMENT_ID,
      };
    }
    case "OrderMatched": {
      const { makerOrderId, maker, taker } = log.args;
      if (!makerOrderId) return null;
      const isOwn =
        (maker?.toLowerCase() === ownAddressLower) ||
        (taker?.toLowerCase() === ownAddressLower);
      return {
        type: "order-matched",
        makerOrderId,
        isOwn,
        instrumentId: PERPS_INSTRUMENT_ID,
      };
    }
    default:
      return null;
  }
}

/** Register the perps factory on import. Idempotent. */
let registered = false;
export function registerPerpsAdapter(): void {
  if (registered) return;
  registered = true;
  registerAdapter("perps", async (ctx) => {
    const wallet = ctx.wallets.get(ctx.config.venue.wallet);
    return new PerpsVenueAdapter({
      ctx,
      address: ctx.config.venue.address,
      wallet,
      logger: ctx.logger,
    });
  });
}
