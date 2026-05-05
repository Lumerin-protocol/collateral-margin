import { erc20Abi } from "viem";
import type { Chain, PublicClient, Transport } from "viem";
import type pino from "pino";
import type {
  CollateralAccount,
  CollateralSnapshot,
  InstrumentAdapter,
  VenueAdapter,
  VenueEvents,
  WalletContext,
} from "../../core/adapter.ts";
import type { NetworkClients } from "../../core/client.ts";
import { FuturesAbi } from "../../abi/Futures.ts";
import { CollateralVaultAbi } from "../../abi/CollateralVault.ts";
import { PortfolioMarginEngineAbi } from "../../abi/PortfolioMarginEngine.ts";
import { Multicall3Abi } from "../../abi/Multicall3.ts";
import { depositToVault } from "../../core/vaultDeposit.ts";
import { RawOracleReader } from "../../core/rawOracle.ts";
import { FuturesInstrumentAdapter } from "./instrument.ts";
import { FuturesVenueEvents } from "./events.ts";

export interface FuturesVenueOptions {
  network: NetworkClients;
  wallet: WalletContext;
  address: `0x${string}`;
  multicall3Address?: `0x${string}`;
  logger: pino.Logger;
}

/**
 * Futures venue: Futures contract, the shared CollateralVault, the
 * PortfolioMarginEngine.
 *
 * The futures contract exposes both `collateralVault` (the vault) and
 * `marginEngine` (the engine) on chain; we read both in one multicall.
 *
 * Single-instrument: `getInstrument()` returns the futures order book for
 * the **nearest** delivery date. Multi-delivery support could be layered
 * on later by exposing one InstrumentAdapter per delivery date and walking
 * them in a portfolio runner; this MVP locks the MM to the nearest date,
 * which is where the bulk of liquidity lives.
 */
export class FuturesVenueAdapter implements VenueAdapter {
  readonly kind = "futures" as const;
  readonly wallet: WalletContext;
  readonly publicClient: PublicClient;
  readonly chain: Chain;
  readonly transport: Transport;
  readonly address: `0x${string}`;

  readonly events: VenueEvents;
  readonly account: CollateralAccount;

  private readonly logger: pino.Logger;
  private readonly multicall3Address: `0x${string}`;
  private instrumentSingleton: FuturesInstrumentAdapter | null = null;

  private vaultAddressCache: `0x${string}` | null = null;
  private engineAddressCache: `0x${string}` | null = null;
  private collateralTokenCache: `0x${string}` | null = null;
  private deliveryDurationDaysCache: bigint | null = null;
  private marginPercentCache: bigint | null = null;
  private readonly rawOracle: RawOracleReader;

  constructor(opts: FuturesVenueOptions) {
    this.wallet = opts.wallet;
    this.publicClient = opts.network.publicClient;
    this.chain = opts.network.chain;
    this.transport = opts.network.transport;
    this.address = opts.address;
    this.logger = opts.logger.child({ component: "futures-venue" });

    const mc3 = opts.multicall3Address ?? (this.chain.contracts?.multicall3?.address as `0x${string}` | undefined);
    if (!mc3) throw new Error(`chain ${this.chain.name} has no multicall3 address`);
    this.multicall3Address = mc3;

    this.events = new FuturesVenueEvents(this.publicClient, this.address);
    this.account = new FuturesCollateralAccount(this);

    // Discover (oracle, divisor) from the futures contract on first read.
    // The divisor is precomputed on chain (`hashpriceScalingDivisor`), so we
    // just fetch both fields together.
    this.rawOracle = new RawOracleReader({
      publicClient: this.publicClient,
      label: "futures",
      resolve: async () => {
        const [oracle, divisor] = await this.publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: this.address, abi: FuturesAbi, functionName: "hashrateOracle" },
            { address: this.address, abi: FuturesAbi, functionName: "hashpriceScalingDivisor" },
          ],
        });
        return { oracle, divisor };
      },
    });
  }

  async getInstrument(): Promise<InstrumentAdapter> {
    if (!this.instrumentSingleton) {
      this.instrumentSingleton = new FuturesInstrumentAdapter(this, this.logger);
    }
    return this.instrumentSingleton;
  }

  async multicall(calls: `0x${string}`[], opts: { maxFeePerGas?: bigint } = {}): Promise<`0x${string}`> {
    return await this.wallet.walletClient.writeContract({
      address: this.address,
      abi: FuturesAbi,
      functionName: "multicall",
      args: [calls],
      account: this.wallet.account,
      chain: this.chain,
      maxFeePerGas: opts.maxFeePerGas,
    });
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  async resolveAddresses(): Promise<{ vault: `0x${string}`; engine: `0x${string}`; token: `0x${string}` }> {
    if (this.vaultAddressCache && this.engineAddressCache && this.collateralTokenCache) {
      return {
        vault: this.vaultAddressCache,
        engine: this.engineAddressCache,
        token: this.collateralTokenCache,
      };
    }
    const [vault, engine] = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: this.address, abi: FuturesAbi, functionName: "collateralVault" },
        { address: this.address, abi: FuturesAbi, functionName: "marginEngine" },
      ],
    });
    const token = await this.publicClient.readContract({
      address: vault,
      abi: CollateralVaultAbi,
      functionName: "collateralToken",
    });
    this.vaultAddressCache = vault;
    this.engineAddressCache = engine;
    this.collateralTokenCache = token;
    return { vault, engine, token };
  }

  getMulticall3Address(): `0x${string}` {
    return this.multicall3Address;
  }

  getLogger(): pino.Logger {
    return this.logger;
  }

  /**
   * Latest hashprice oracle answer rebased to token decimals (no tick
   * rounding). See `RawOracleReader` for rationale.
   */
  getRawMarketPrice(): Promise<bigint> {
    return this.rawOracle.read();
  }

  /**
   * Cache delivery-duration-days and marginPercent on the venue. Both are
   * static-ish (admin-changeable) so we read them once and reuse for the
   * `estimateOrderMargin` formula.
   */
  async getMarginInputs(): Promise<{ deliveryDurationDays: bigint; marginPct: bigint }> {
    if (this.deliveryDurationDaysCache !== null && this.marginPercentCache !== null) {
      return {
        deliveryDurationDays: this.deliveryDurationDaysCache,
        marginPct: this.marginPercentCache,
      };
    }
    const [duration, liqMarginPct] = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: this.address, abi: FuturesAbi, functionName: "deliveryDurationDays" },
        { address: this.address, abi: FuturesAbi, functionName: "liquidationMarginPercent" },
      ],
    });
    // Note: `getMarginPercent` on chain adds a breach-penalty term we don't
    // mirror here — we use `liquidationMarginPercent` as a slight over-estimate.
    // The on-chain check is the real authority; this is just our pre-trade gate.
    this.deliveryDurationDaysCache = BigInt(duration);
    this.marginPercentCache = BigInt(liqMarginPct);
    return { deliveryDurationDays: this.deliveryDurationDaysCache, marginPct: this.marginPercentCache };
  }
}

/**
 * `CollateralAccount` for the futures venue.
 *
 * `snapshot()` reads all 5 portfolio signals in one multicall: vault balance,
 * portfolio IM/MM, futures order margin (positive resting margin), futures
 * unrealized PnL (signed), wallet ERC20 balance, native ETH balance.
 */
class FuturesCollateralAccount implements CollateralAccount {
  private readonly venue: FuturesVenueAdapter;
  constructor(venue: FuturesVenueAdapter) {
    this.venue = venue;
  }

  async snapshot(): Promise<CollateralSnapshot> {
    const owner = this.venue.wallet.account.address;
    const { vault, engine, token } = await this.venue.resolveAddresses();
    const mc3 = this.venue.getMulticall3Address();

    const [
      vaultBalance,
      portfolioIM,
      portfolioMM,
      orderMargin,
      unrealizedPnl,
      walletTokenBalance,
      nativeBalance,
    ] = await this.venue.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: vault, abi: CollateralVaultAbi, functionName: "balanceOf", args: [owner] },
        { address: engine, abi: PortfolioMarginEngineAbi, functionName: "computePortfolioIM", args: [owner] },
        { address: engine, abi: PortfolioMarginEngineAbi, functionName: "computePortfolioMM", args: [owner] },
        { address: this.venue.address, abi: FuturesAbi, functionName: "getFuturesOrderMargin", args: [owner] },
        { address: this.venue.address, abi: FuturesAbi, functionName: "getFuturesUnrealizedPnl", args: [owner] },
        { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
        { address: mc3, abi: Multicall3Abi, functionName: "getEthBalance", args: [owner] },
      ],
    });

    return {
      vaultBalance,
      portfolioIM,
      portfolioMM,
      venueOrderMargin: orderMargin,
      venueUnrealizedPnl: unrealizedPnl,
      walletTokenBalance,
      nativeBalance,
      collateralToken: token,
    };
  }

  async imSpotShock(): Promise<bigint> {
    // Futures uses pricePerDay × deliveryDurationDays × marginPct/100, not a
    // spot-shock model. Returns 0 to signal "not applicable" — adapters don't
    // use this directly; estimateOrderMargin reads from getMarginInputs instead.
    return 0n;
  }

  async deposit(amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    const { vault, token } = await this.venue.resolveAddresses();
    await depositToVault({
      publicClient: this.venue.publicClient,
      walletClient: this.venue.wallet.walletClient,
      account: this.venue.wallet.account,
      chain: this.venue.chain,
      vaultAddress: vault,
      collateralToken: token,
      amount,
      logger: this.venue.getLogger(),
    });
  }

  async canPlace(additionalIM: bigint): Promise<boolean> {
    if (additionalIM === 0n) return true;
    const { engine } = await this.venue.resolveAddresses();
    return await this.venue.publicClient.readContract({
      address: engine,
      abi: PortfolioMarginEngineAbi,
      functionName: "canPlaceOrder",
      args: [this.venue.wallet.account.address, additionalIM],
    });
  }
}
