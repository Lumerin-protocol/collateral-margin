import { encodeFunctionData, erc20Abi } from "viem";
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
import { HashPowerPerpsDEXAbi } from "perps-contracts/abi/HashPowerPerpsDEX.ts";
import { CollateralVaultAbi } from "collateral-margin-contracts/abi/CollateralVault.ts";
import { PortfolioMarginEngineAbi } from "collateral-margin-contracts/abi/PortfolioMarginEngine.ts";
import { Multicall3Abi } from "perps-contracts/abi/Multicall3.ts";
import { depositToVault } from "../../core/vaultDeposit.ts";
import {
  RawOracleReader,
  chainlinkAggregatorAbi,
} from "../../core/rawOracle.ts";
import { attachTenderlyUrl } from "../../core/tenderly.ts";
import { PerpsInstrumentAdapter } from "./instrument.ts";
import { PerpsVenueEvents } from "./events.ts";

export interface PerpsVenueOptions {
  network: NetworkClients;
  wallet: WalletContext;
  address: `0x${string}`;
  multicall3Address?: `0x${string}`;
  /** Max calls per Multicall3 read batch. Default 100. */
  readBatchSize: number;
  /** Max cancelOrder calls per batch. Default 30. */
  cancelBatchSize: number;
  /** Max createOrder calls per batch. Default 30. */
  createBatchSize: number;
  logger: pino.Logger;
}

/**
 * Perps venue: HashPowerPerpsDEX, the shared CollateralVault, and the
 * PortfolioMarginEngine.
 *
 * Wiring is fixed at construction. The adapter discovers `vault` and
 * `portfolioMargin` from the DEX on the first call to `account.snapshot()`
 * and caches them.
 *
 * Single-instrument: `getInstrument()` returns the perps order book.
 */
export class PerpsVenueAdapter implements VenueAdapter {
  readonly kind = "perps" as const;
  readonly wallet: WalletContext;
  readonly publicClient: PublicClient;
  readonly chain: Chain;
  readonly transport: Transport;
  readonly address: `0x${string}`;

  readonly events: VenueEvents;
  readonly account: CollateralAccount;

  private readonly logger: pino.Logger;
  private readonly multicall3Address: `0x${string}`;
  readonly readBatchSize: number;
  readonly cancelBatchSize: number;
  readonly createBatchSize: number;
  private instrumentSingleton: PerpsInstrumentAdapter | null = null;

  /** Cached references discovered from the DEX. */
  private vaultAddressCache: `0x${string}` | null = null;
  private engineAddressCache: `0x${string}` | null = null;
  private collateralTokenCache: `0x${string}` | null = null;
  private imSpotShockCache: bigint | null = null;
  private readonly rawOracle: RawOracleReader;

  constructor(opts: PerpsVenueOptions) {
    this.wallet = opts.wallet;
    this.publicClient = opts.network.publicClient;
    this.chain = opts.network.chain;
    this.transport = opts.network.transport;
    this.address = opts.address;
    this.logger = opts.logger.child({ component: "perps-venue" });

    const mc3 =
      opts.multicall3Address ??
      (this.chain.contracts?.multicall3?.address as `0x${string}` | undefined);
    if (!mc3)
      throw new Error(`chain ${this.chain.name} has no multicall3 address`);
    this.multicall3Address = mc3;
    this.readBatchSize = opts.readBatchSize;
    this.cancelBatchSize = opts.cancelBatchSize;
    this.createBatchSize = opts.createBatchSize;

    this.events = new PerpsVenueEvents(this.publicClient, this.address);
    this.account = new PerpsCollateralAccount(this);

    // Discover (oracle, divisor) on first read. Unlike futures the divisor
    // isn't precomputed on chain — derive it from oracle.decimals() and the
    // collateral token's decimals.
    this.rawOracle = new RawOracleReader({
      publicClient: this.publicClient,
      label: "perps",
      resolve: async () => {
        const { token } = await this.resolveAddresses();
        const oracle = await this.publicClient.readContract({
          address: this.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "priceOracle",
        });
        const [oracleDecimals, tokenDecimals] =
          await this.publicClient.multicall({
            allowFailure: false,
            contracts: [
              {
                address: oracle,
                abi: chainlinkAggregatorAbi,
                functionName: "decimals",
              },
              { address: token, abi: erc20Abi, functionName: "decimals" },
            ],
          });
        if (tokenDecimals > oracleDecimals) {
          throw new Error(
            `perps: tokenDecimals (${tokenDecimals}) > oracleDecimals (${oracleDecimals})`,
          );
        }
        return {
          oracle,
          divisor: 10n ** BigInt(oracleDecimals - tokenDecimals),
        };
      },
    });
  }

  async getInstrument(): Promise<InstrumentAdapter> {
    if (!this.instrumentSingleton) {
      this.instrumentSingleton = new PerpsInstrumentAdapter(this);
    }
    return this.instrumentSingleton;
  }

  async multicall(
    calls: `0x${string}`[],
    opts: { maxFeePerGas?: bigint } = {},
  ): Promise<`0x${string}`> {
    try {
      return await this.wallet.walletClient.writeContract({
        address: this.address,
        abi: HashPowerPerpsDEXAbi,
        functionName: "multicall",
        args: [calls],
        account: this.wallet.account,
        chain: this.chain,
        maxFeePerGas: opts.maxFeePerGas,
      });
    } catch (err) {
      // Attach a Tenderly simulation URL so the failed multicall can be
      // replayed/debugged with one click from the log.
      throw attachTenderlyUrl(err, {
        chainId: this.chain.id,
        from: this.wallet.account.address,
        to: this.address,
        data: encodeFunctionData({
          abi: HashPowerPerpsDEXAbi,
          functionName: "multicall",
          args: [calls],
        }),
      });
    }
  }

  // ── Internal helpers used by the collateral account & instrument ─────────

  async resolveAddresses(): Promise<{
    vault: `0x${string}`;
    engine: `0x${string}`;
    token: `0x${string}`;
  }> {
    if (
      this.vaultAddressCache &&
      this.engineAddressCache &&
      this.collateralTokenCache
    ) {
      return {
        vault: this.vaultAddressCache,
        engine: this.engineAddressCache,
        token: this.collateralTokenCache,
      };
    }
    const [vault, engine, token] = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: this.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "vault",
        },
        {
          address: this.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "portfolioMargin",
        },
        {
          address: this.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "collateralToken",
        },
      ],
    });
    this.vaultAddressCache = vault;
    this.engineAddressCache = engine;
    this.collateralTokenCache = token;
    return { vault, engine, token };
  }

  async getMulticall3Address(): Promise<`0x${string}`> {
    return this.multicall3Address;
  }

  getLogger(): pino.Logger {
    return this.logger;
  }

  /**
   * Latest price oracle answer rebased to token decimals (no tick rounding).
   * See `RawOracleReader` for rationale.
   */
  getRawMarketPrice(): Promise<bigint> {
    return this.rawOracle.read();
  }

  async fetchImSpotShock(): Promise<bigint> {
    if (this.imSpotShockCache !== null) return this.imSpotShockCache;
    const { engine } = await this.resolveAddresses();
    const shock = await this.publicClient.readContract({
      address: engine,
      abi: PortfolioMarginEngineAbi,
      functionName: "imSpotShock",
    });
    this.imSpotShockCache = shock;
    return shock;
  }
}

/**
 * `CollateralAccount` for the perps venue.
 *
 * `snapshot()` pulls 8 reads in one multicall: vault balance, portfolio
 * IM/MM, perps order margin / unrealized PnL / pending funding (signed),
 * wallet ERC20 balance, native ETH balance.
 *
 * `deposit(amount)` is delegated to the shared `vaultDeposit` helper; the
 * old `addCollateralWithPermit` path no longer exists on the contract.
 */
class PerpsCollateralAccount implements CollateralAccount {
  private readonly venue: PerpsVenueAdapter;
  constructor(venue: PerpsVenueAdapter) {
    this.venue = venue;
  }

  async snapshot(): Promise<CollateralSnapshot> {
    const owner = this.venue.wallet.account.address;
    const { vault, engine, token } = await this.venue.resolveAddresses();
    const mc3 = await this.venue.getMulticall3Address();

    const [
      vaultBalance,
      portfolioIM,
      portfolioMM,
      orderMargin,
      perpsUnrealizedPnl,
      pendingFunding,
      walletTokenBalance,
      nativeBalance,
    ] = await this.venue.publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: vault,
          abi: CollateralVaultAbi,
          functionName: "balanceOf",
          args: [owner],
        },
        {
          address: engine,
          abi: PortfolioMarginEngineAbi,
          functionName: "computePortfolioIM",
          args: [owner],
        },
        {
          address: engine,
          abi: PortfolioMarginEngineAbi,
          functionName: "computePortfolioMM",
          args: [owner],
        },
        {
          address: this.venue.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "getOrderMargin",
          args: [owner],
        },
        {
          address: this.venue.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "getUnrealizedPnl",
          args: [owner],
        },
        {
          address: this.venue.address,
          abi: HashPowerPerpsDEXAbi,
          functionName: "getPendingFunding",
          args: [owner],
        },
        {
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        },
        {
          address: mc3,
          abi: Multicall3Abi,
          functionName: "getEthBalance",
          args: [owner],
        },
      ],
    });

    // Funding owed (positive) reduces effective unrealized PnL.
    const venueUnrealizedPnl = perpsUnrealizedPnl - pendingFunding;

    return {
      vaultBalance,
      portfolioIM,
      portfolioMM,
      venueOrderMargin: orderMargin,
      venueUnrealizedPnl,
      walletTokenBalance,
      nativeBalance,
      collateralToken: token,
    };
  }

  imSpotShock(): Promise<bigint> {
    return this.venue.fetchImSpotShock();
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
      logger: this.venue["logger"],
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
