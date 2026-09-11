import { encodeFunctionData, erc20Abi } from "viem";
import type { Chain, PublicClient, Transport } from "viem";
import type pino from "pino";
import type {
  BatchableCollateralAccount,
  CollateralAccount,
  CollateralSnapshot,
  InstrumentAdapter,
  MarginReadPlan,
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
import { QUANTITY_DECIMALS } from "../../core/math.ts";
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
        const [oracleDecimals, tokenDecimals] = await this.publicClient.multicall({
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

  /** Perps is single-instrument; the list is always one element. */
  async listInstruments(): Promise<InstrumentAdapter[]> {
    return [await this.getInstrument()];
  }

  async sendCall(
    data: `0x${string}`,
    opts: { maxFeePerGas?: bigint; nonce?: number } = {},
  ): Promise<`0x${string}`> {
    try {
      return await this.wallet.walletClient.sendTransaction({
        to: this.address,
        data,
        account: this.wallet.account,
        chain: this.chain,
        maxFeePerGas: opts.maxFeePerGas,
        nonce: opts.nonce,
      });
    } catch (err) {
      throw attachTenderlyUrl(err, {
        chainId: this.chain.id,
        from: this.wallet.account.address,
        to: this.address,
        data,
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
    const [vault, engine] = await this.publicClient.multicall({
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
      ],
    });
    // The current perps implementation exposes the shared vault, while the
    // collateral token is a getter on the vault itself.
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

  /**
   * The mark from the most recent `getRawMarketPrice()`, or `null` before the first
   * read. Lets the synchronous `estimateOrderMargin` charge an order's instant fill
   * loss against the same mark the quotes were built from.
   */
  cachedMarketPrice(): bigint | null {
    return this.rawOracle.lastPrice();
  }

  /**
   * Assert the compiled `QUANTITY_DECIMALS` matches the on-chain
   * `HashPowerPerpsDEX.QUANTITY_DECIMALS()`. The off-chain sizing/notional math
   * hardcodes this scale for performance, so the chain is the source of truth —
   * a mismatch (e.g. after a venue redeploy) must fail fast at startup rather
   * than silently misprice by orders of magnitude.
   */
  async validateQuantityDecimals(): Promise<void> {
    const onChain = (await this.publicClient.readContract({
      address: this.address,
      abi: HashPowerPerpsDEXAbi,
      functionName: "QUANTITY_DECIMALS",
    })) as number;
    if (Number(onChain) !== QUANTITY_DECIMALS) {
      throw new Error(
        `perps: on-chain QUANTITY_DECIMALS (${onChain}) != market-maker QUANTITY_DECIMALS (${QUANTITY_DECIMALS})`,
      );
    }
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
class PerpsCollateralAccount implements BatchableCollateralAccount {
  private readonly venue: PerpsVenueAdapter;
  constructor(venue: PerpsVenueAdapter) {
    this.venue = venue;
  }

  /**
   * Decompose the snapshot into shared (portfolio-wide) + venue-specific reads
   * so the portfolio aggregator can batch every venue into one multicall.
   * `shared` order is canonical across venues:
   *   [vaultBalance, portfolioIM, portfolioMM, walletTokenBalance, nativeBalance,
   *    portfolioOrderMargin]
   *
   * Order margin is a shared read rather than a venue read: the engine nets every
   * venue's per-side order delta into one portfolio net delta before stressing it, so
   * asking each venue for its own slice and adding them up would double-count the
   * stress and ignore the netting.
   */
  async buildMarginReadPlan(): Promise<MarginReadPlan> {
    const owner = this.venue.wallet.account.address;
    const { vault, engine, token } = await this.venue.resolveAddresses();
    const mc3 = await this.venue.getMulticall3Address();

    const shared = [
      { address: vault, abi: CollateralVaultAbi, functionName: "balanceOf", args: [owner] },
      { address: engine, abi: PortfolioMarginEngineAbi, functionName: "computePortfolioIM", args: [owner] },
      { address: engine, abi: PortfolioMarginEngineAbi, functionName: "computePortfolioMM", args: [owner] },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: mc3, abi: Multicall3Abi, functionName: "getEthBalance", args: [owner] },
      { address: engine, abi: PortfolioMarginEngineAbi, functionName: "orderMarginOf", args: [owner] },
    ] as MarginReadPlan["shared"];

    const venue = [
      { address: this.venue.address, abi: HashPowerPerpsDEXAbi, functionName: "getUnrealizedPnl", args: [owner] },
      { address: this.venue.address, abi: HashPowerPerpsDEXAbi, functionName: "getPendingFunding", args: [owner] },
    ] as MarginReadPlan["venue"];

    const decode = (results: readonly unknown[]): CollateralSnapshot => {
      const r = results as bigint[];
      const [vaultBalance, portfolioIM, portfolioMM, walletTokenBalance, nativeBalance] = r;
      const portfolioOrderMargin = r[5];
      const perpsUnrealizedPnl = r[6];
      const pendingFunding = r[7];
      // Funding owed (positive) reduces effective unrealized PnL.
      return {
        vaultBalance,
        portfolioIM,
        portfolioMM,
        portfolioOrderMargin,
        venueUnrealizedPnl: perpsUnrealizedPnl - pendingFunding,
        walletTokenBalance,
        nativeBalance,
        collateralToken: token,
      };
    };

    return { shared, venue, decode };
  }

  async snapshot(): Promise<CollateralSnapshot> {
    const plan = await this.buildMarginReadPlan();
    const results = await this.venue.publicClient.multicall({
      allowFailure: false,
      contracts: [...plan.shared, ...plan.venue],
    });
    return plan.decode(results);
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
