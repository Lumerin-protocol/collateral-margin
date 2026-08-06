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
import { FuturesAbi } from "futures-contracts/abi/Futures";
import { CollateralVaultAbi } from "collateral-margin-contracts/abi/CollateralVault.ts";
import { PortfolioMarginEngineAbi } from "collateral-margin-contracts/abi/PortfolioMarginEngine.ts";
import { Multicall3Abi } from "perps-contracts/abi/Multicall3.ts";
import { depositToVault } from "../../core/vaultDeposit.ts";
import { RawOracleReader } from "../../core/rawOracle.ts";
import { attachTenderlyUrl } from "../../core/tenderly.ts";
import { FuturesInstrumentAdapter } from "./instrument.ts";
import { FuturesVenueEvents } from "./events.ts";

/**
 * How the venue picks which delivery dates to quote out of the rolling window
 * returned by `getExpirationDates()` (ordered nearest-first).
 *
 *  - `nearest`: the first `count` dates (count=1 reproduces the legacy MVP).
 *  - `indices`: explicit relative offsets into the window (0 = nearest).
 */
export type FuturesMarketSelection =
  | { mode: "nearest"; count: number }
  | { mode: "indices"; indices: number[] };

export interface FuturesVenueOptions {
  network: NetworkClients;
  wallet: WalletContext;
  address: `0x${string}`;
  multicall3Address?: `0x${string}`;
  /** Max calls per Multicall3 read batch. Default 100. */
  readBatchSize: number;
  /** Max closeOrder calls per cancellation batch. Default 20. */
  writeBatchSize: number;
  /** Which delivery dates to quote. Defaults to `{ mode: "nearest", count: 1 }`. */
  marketSelection?: FuturesMarketSelection;
  logger: pino.Logger;
}

/** Outcome of a `resolveMarkets()` roll check. */
export interface FuturesMarketSet {
  /** Instruments the venue currently wants quoted, nearest-first. */
  active: FuturesInstrumentAdapter[];
  /** Instruments newly added since the previous resolve (need bootstrap). */
  added: FuturesInstrumentAdapter[];
  /** Instruments dropped since the previous resolve (matured / rolled off). */
  dropped: FuturesInstrumentAdapter[];
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
  readonly readBatchSize: number;
  readonly writeBatchSize: number;
  private readonly marketSelection: FuturesMarketSelection;
  /** expirationAt → instrument, memoized so each expiry has one adapter. */
  private readonly instruments = new Map<string, FuturesInstrumentAdapter>();
  /** expirationAts currently selected (as strings), from the last resolve. */
  private activeKeys: string[] = [];

  private vaultAddressCache: `0x${string}` | null = null;
  private engineAddressCache: `0x${string}` | null = null;
  private collateralTokenCache: `0x${string}` | null = null;
  private marginPercentCache: bigint | null = null;
  private imSpotShockCache: bigint | null = null;
  private readonly rawOracle: RawOracleReader;

  constructor(opts: FuturesVenueOptions) {
    this.wallet = opts.wallet;
    this.publicClient = opts.network.publicClient;
    this.chain = opts.network.chain;
    this.transport = opts.network.transport;
    this.address = opts.address;
    this.logger = opts.logger.child({ component: "futures-venue" });

    const mc3 =
      opts.multicall3Address ??
      (this.chain.contracts?.multicall3?.address as `0x${string}` | undefined);
    if (!mc3)
      throw new Error(`chain ${this.chain.name} has no multicall3 address`);
    this.multicall3Address = mc3;
    this.readBatchSize = opts.readBatchSize;
    this.writeBatchSize = opts.writeBatchSize;
    this.marketSelection = opts.marketSelection ?? { mode: "nearest", count: 1 };

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
            {
              address: this.address,
              abi: FuturesAbi,
              functionName: "hashrateOracle",
            },
            {
              address: this.address,
              abi: FuturesAbi,
              functionName: "hashpriceScalingDivisor",
            },
          ],
        });
        return { oracle, divisor };
      },
    });
  }

  /** Nearest-expiry instrument. Back-compat / single-market entrypoint. */
  async getInstrument(): Promise<InstrumentAdapter> {
    const dates = await this.readExpirationAts();
    if (dates.length === 0) throw new Error("futures contract returned no delivery dates");
    return this.instrumentFor(dates[0]);
  }

  /** All currently-selected expiries, nearest-first. */
  async listInstruments(): Promise<InstrumentAdapter[]> {
    const { active } = await this.resolveMarkets();
    return active;
  }

  /**
   * Re-read the rolling delivery-date window, apply the configured selection,
   * and diff against the previously-active set. Instruments are memoized per
   * expiry, so `added`/`dropped` let the runner bootstrap new markets and tear
   * down matured ones without disturbing the survivors.
   */
  async resolveMarkets(): Promise<FuturesMarketSet> {
    const dates = await this.readExpirationAts();
    const selected = this.selectDates(dates);
    const selectedKeys = selected.map((d) => d.toString());

    const prev = new Set(this.activeKeys);
    const next = new Set(selectedKeys);

    const added: FuturesInstrumentAdapter[] = [];
    for (const d of selected) {
      if (!prev.has(d.toString())) added.push(this.instrumentFor(d));
    }
    const dropped: FuturesInstrumentAdapter[] = [];
    for (const key of this.activeKeys) {
      if (!next.has(key)) {
        const inst = this.instruments.get(key);
        if (inst) dropped.push(inst);
        this.instruments.delete(key);
      }
    }

    this.activeKeys = selectedKeys;
    const active = selected.map((d) => this.instrumentFor(d));

    if (added.length > 0 || dropped.length > 0) {
      this.logger.info(
        {
          active: active.map((i) => i.expirationAt.toString()),
          added: added.map((i) => i.expirationAt.toString()),
          dropped: dropped.map((i) => i.expirationAt.toString()),
        },
        "futures markets resolved",
      );
    }
    return { active, added, dropped };
  }

  private instrumentFor(expirationAt: bigint): FuturesInstrumentAdapter {
    const key = expirationAt.toString();
    let inst = this.instruments.get(key);
    if (!inst) {
      inst = new FuturesInstrumentAdapter(this, expirationAt, this.logger);
      this.instruments.set(key, inst);
    }
    return inst;
  }

  private async readExpirationAts(): Promise<bigint[]> {
    const dates = await this.publicClient.readContract({
      address: this.address,
      abi: FuturesAbi,
      functionName: "getExpirationDates",
    });
    return [...dates];
  }

  private selectDates(dates: bigint[]): bigint[] {
    if (dates.length === 0) return [];
    if (this.marketSelection.mode === "nearest") {
      return dates.slice(0, Math.max(0, this.marketSelection.count));
    }
    const out: bigint[] = [];
    for (const idx of this.marketSelection.indices) {
      if (idx >= 0 && idx < dates.length) out.push(dates[idx]);
    }
    return out;
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

  /** @deprecated Prefer {@link sendCall} with a single `updateOrders` encoding. */
  async multicall(
    calls: `0x${string}`[],
    opts: { maxFeePerGas?: bigint; nonce?: number } = {},
  ): Promise<`0x${string}`> {
    try {
      return await this.wallet.walletClient.writeContract({
        address: this.address,
        abi: FuturesAbi,
        functionName: "multicall",
        args: [calls],
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
        data: encodeFunctionData({
          abi: FuturesAbi,
          functionName: "multicall",
          args: [calls],
        }),
      });
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────

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
          abi: FuturesAbi,
          functionName: "collateralVault",
        },
        {
          address: this.address,
          abi: FuturesAbi,
          functionName: "marginEngine",
        },
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
   * The mark from the most recent `getRawMarketPrice()`, or `null` before the first
   * read. Lets the synchronous `estimateOrderMargin` charge an order's instant fill
   * loss against the same mark the quotes were built from.
   */
  cachedMarketPrice(): bigint | null {
    return this.rawOracle.lastPrice();
  }

  /**
   * Cache marginPercent on the venue. It is static-ish (admin-changeable) so we
   * read it once and reuse it.
   *
   * No longer feeds `estimateOrderMargin`: the engine stresses a futures contract's
   * delta with the portfolio-wide `imSpotShock`, not the venue's own
   * `liquidationMarginPercent`. Kept because the liquidation-margin figure is still
   * the right thing to report and reason about for positions.
   */
  async getMarginInputs(): Promise<{ marginPct: bigint }> {
    if (this.marginPercentCache !== null) {
      return { marginPct: this.marginPercentCache };
    }
    const liqMarginPct = await this.publicClient.readContract({
      address: this.address,
      abi: FuturesAbi,
      functionName: "liquidationMarginPercent",
    });
    this.marginPercentCache = BigInt(liqMarginPct);
    return { marginPct: this.marginPercentCache };
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

  /** The cached IM spot shock, or `null` before the first fetch. */
  cachedImSpotShock(): bigint | null {
    return this.imSpotShockCache;
  }
}

/**
 * `CollateralAccount` for the futures venue.
 *
 * `snapshot()` reads all 5 portfolio signals in one multicall: vault balance,
 * portfolio IM/MM, futures order margin (positive resting margin), futures
 * unrealized PnL (signed), wallet ERC20 balance, native ETH balance.
 */
class FuturesCollateralAccount implements BatchableCollateralAccount {
  private readonly venue: FuturesVenueAdapter;
  constructor(venue: FuturesVenueAdapter) {
    this.venue = venue;
  }

  /**
   * Decompose the snapshot into shared (portfolio-wide) + venue-specific reads.
   * `shared` order matches the perps account so the aggregator can decode one
   * shared result slice for every venue:
   *   [vaultBalance, portfolioIM, portfolioMM, walletTokenBalance, nativeBalance,
   *    portfolioOrderMargin]
   */
  async buildMarginReadPlan(): Promise<MarginReadPlan> {
    const owner = this.venue.wallet.account.address;
    const { vault, engine, token } = await this.venue.resolveAddresses();
    const mc3 = this.venue.getMulticall3Address();

    const shared = [
      { address: vault, abi: CollateralVaultAbi, functionName: "balanceOf", args: [owner] },
      { address: engine, abi: PortfolioMarginEngineAbi, functionName: "computePortfolioIM", args: [owner] },
      { address: engine, abi: PortfolioMarginEngineAbi, functionName: "computePortfolioMM", args: [owner] },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: mc3, abi: Multicall3Abi, functionName: "getEthBalance", args: [owner] },
      { address: engine, abi: PortfolioMarginEngineAbi, functionName: "orderMarginOf", args: [owner] },
    ] as MarginReadPlan["shared"];

    const venue = [
      { address: this.venue.address, abi: FuturesAbi, functionName: "getUnrealizedPnl", args: [owner] },
    ] as MarginReadPlan["venue"];

    const decode = (results: readonly unknown[]): CollateralSnapshot => {
      const r = results as bigint[];
      const [vaultBalance, portfolioIM, portfolioMM, walletTokenBalance, nativeBalance] = r;
      return {
        vaultBalance,
        portfolioIM,
        portfolioMM,
        portfolioOrderMargin: r[5],
        venueUnrealizedPnl: r[6],
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
    // The engine treats a futures contract as one unit of delta and stresses it with
    // the same portfolio-wide shock it applies to perps, so this is no longer "not
    // applicable" — it is the coefficient `estimateOrderMargin` needs.
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
