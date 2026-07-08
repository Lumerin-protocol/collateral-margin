import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  encodeFunctionData,
  http,
  parseUnits,
  publicActions,
  walletActions,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { artifacts, type CompiledArtifact } from "./artifacts.ts";

/**
 * Programmatic deployment of the full collateral-margin stack against a
 * running Hardhat node. Mirrors the wiring done by
 * `perps/contracts/tests/fixtures.ts::deployPerpsFixture` and
 * `futures-marketplace/contracts/tests/fixtures.ts::deployOnlyFuturesFixture`,
 * but goes through raw viem `deployContract({ abi, bytecode, args })` rather
 * than Hardhat's named-artifact resolver — that way the test can run from
 * the keeper package without needing its own Hardhat config.
 *
 * Deterministic Hardhat private keys (well-known across the team's
 * tooling) are baked in so test scenarios can sign with the SAME keys the
 * deploy script uses. Account #3 is reserved for the keeper liquidator,
 * matching `e2e/setup/keeper.ts` in the perps repo.
 */
export const HARDHAT_PRIVATE_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0 owner
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1 alice
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2 bob
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3 liquidator
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4 validator
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5 dave (second test trader)
] as const satisfies readonly Hex[];

export interface Wallet {
  account: Account;
  client: WalletClient;
}

export interface DeployedStack {
  publicClient: PublicClient;
  testClient: TestClient;
  /** The shared HTTP transport — reused by every test keeper to avoid socket listener accumulation. */
  transport: ReturnType<typeof http>;
  rpcUrl: string;
  accounts: {
    owner: Wallet;
    alice: Wallet;
    bob: Wallet;
    liquidator: Wallet;
    validator: Wallet;
    /** Spare trader for multi-account scenarios. */
    dave: Wallet;
  };
  addresses: {
    usdc: Address;
    hashpriceOracle: Address;
    btcUsdcFeed: Address;
    vault: Address;
    pme: Address;
    perps: Address;
    futures: Address;
    /**
     * Deployed Multicall3 — fed into the keeper's chain config so viem's
     * `multicall` action (used by `pme/health.ts`) has somewhere to dispatch
     * batched reads. In production this would be the canonical
     * `0xcA11bde05977b3631167028862bE2a173976CA11` address; on a fresh
     * Hardhat node we deploy it ourselves and pin the dynamic address.
     */
    multicall3: Address;
  };
  abis: {
    usdc: Abi;
    hashpriceOracle: Abi;
    btcUsdcFeed: Abi;
    vault: Abi;
    pme: Abi;
    perps: Abi;
    futures: Abi;
  };
  /** Configuration values used during deploy — handy for scenarios. */
  config: {
    tokenDecimals: number;
    oracleDecimals: number;
    /**
     * Raw hashprice oracle answer (per 100 TH/s·day, i.e. `ORACLE_UNIT_HPS_DAY`).
     * Both venues rebase this to a per-contract mark via
     * `market = answer × CONTRACT_SIZE_HPS_DAY / ORACLE_UNIT_HPS_DAY` (= ×10),
     * so this seed is `initialMarketPrice / 10`. Fixtures that need to re-post
     * the oracle (e.g. delivery settlement) write this value directly.
     */
    initialHashprice: bigint;
    /**
     * Per-contract mark at deploy time (= `initialHashprice × 10`). This is the
     * unit orders and positions are denominated in — scenarios use it as the
     * at-the-money entry price.
     */
    initialMarketPrice: bigint;
    initialBtcUsdc: bigint;
    minimumPriceIncrement: bigint;
    quantityDecimals: number;
    perpsLiquidationFee: bigint;
    perpsTakerFeeBps: bigint;
    perpsMakerFeeBps: bigint;
    futuresTakerFee: bigint;
    futuresLiquidationFee: bigint;
    futuresFirstDeliveryDate: bigint;
    insuranceFund: bigint;
    initialUserBalance: bigint;
  };
}

const TOKEN_DECIMALS = 6;
const ORACLE_DECIMALS = 6;
const QUANTITY_DECIMALS = 6;

/**
 * Ratio by which both venues rebase the oracle answer into a per-contract mark:
 * `CONTRACT_SIZE_HPS_DAY / ORACLE_UNIT_HPS_DAY = 1e15 / 1e14 = 10`. The oracle
 * quotes 100 TH/s·day; one contract settles 1 PH/s·day, so the mark is ×10 the
 * raw answer. Exported so scenarios convert market prices → oracle answers in
 * one place.
 */
export const ORACLE_TO_MARKET_MULTIPLIER = 10n;

/**
 * Per-contract mark at deploy time. Positions and orders are denominated in this
 * (contract) unit; the oracle answer is seeded at `/ ORACLE_TO_MARKET_MULTIPLIER`
 * so `getMarketPrice()` (answer × 10) lands back here. Kept at $4.21 so the
 * pre-existing perps fixtures (which never carried the duration factor) keep
 * their dollar sizing unchanged.
 */
const INITIAL_MARKET_PRICE = parseUnits("4.21", TOKEN_DECIMALS);
/** Raw hashprice oracle answer (per 100 TH/s·day) — rebased ×10 into the mark above. */
const INITIAL_HASHPRICE = INITIAL_MARKET_PRICE / ORACLE_TO_MARKET_MULTIPLIER;
/** Reference BTC/USDC mid-price; only the *delta* matters for predictor tests. */
const INITIAL_BTC_USDC = parseUnits("65000", ORACLE_DECIMALS);

const MIN_PRICE_INCREMENT = parseUnits("0.01", TOKEN_DECIMALS);
const PERPS_LIQUIDATION_FEE = parseUnits("1", TOKEN_DECIMALS);
const PERPS_TAKER_FEE_BPS = 5n;
const PERPS_MAKER_FEE_BPS = 0n;
const FUTURES_TAKER_FEE = parseUnits("1", TOKEN_DECIMALS);
const FUTURES_LIQUIDATION_FEE = parseUnits("1", TOKEN_DECIMALS);
const FUTURES_LIQUIDATION_MARGIN_PCT = 20;
/** Spacing, in days, between successive expiries (renamed from delivery interval). */
const FUTURES_EXPIRATION_INTERVAL_DAYS = 7;
const FUTURES_FUTURE_DELIVERY_DATES_COUNT = 10;
const INSURANCE_FUND = parseUnits("100000", TOKEN_DECIMALS);
const INITIAL_USER_BALANCE = parseUnits("10000", TOKEN_DECIMALS);

const APPROVE_MAX = (1n << 256n) - 1n;

/**
 * Deploys USDC + oracles + vault + PME + perps + futures, wires every
 * authorization, sets per-venue fees, funds test accounts. The returned
 * stack is the canonical baseline; scenario fixtures stack additional
 * actions (deposits, orders, positions) on top via `loadFixture`.
 */
export async function deployStack(rpcUrl: string): Promise<DeployedStack> {
  const transport = http(rpcUrl, { timeout: 30_000 });
  const publicClient = createPublicClient({ chain: hardhat, transport });
  const testClient = createTestClient({
    chain: hardhat,
    mode: "hardhat",
    transport,
  })
    .extend(publicActions)
    .extend(walletActions);

  const wallets = HARDHAT_PRIVATE_KEYS.map((pk) => {
    const account = privateKeyToAccount(pk);
    return {
      account,
      client: createWalletClient({ account, chain: hardhat, transport }),
    } satisfies Wallet;
  });
  // Destructure with non-null assertions — the array literal above guarantees
  // 6 elements, but TS can't see that through `Array.prototype.map`.
  const owner = wallets[0]!;
  const alice = wallets[1]!;
  const bob = wallets[2]!;
  const liquidator = wallets[3]!;
  const validator = wallets[4]!;
  const dave = wallets[5]!;

  // ── Infrastructure: Multicall3 ────────────────────────────────────────
  // Deployed first because `buildKeeper` reads its address into the chain
  // config — keeper components must see it before they make any read call.
  const multicall3 = await deploy(
    publicClient,
    owner.client,
    artifacts.multicall3(),
    [],
  );

  // ── Tokens & oracles ──────────────────────────────────────────────────
  const usdcArt = artifacts.usdc();
  const aggArt = artifacts.aggregatorEventMock();
  const usdc = await deploy(publicClient, owner.client, usdcArt, []);
  const hashpriceOracle = await deploy(publicClient, owner.client, aggArt, [
    INITIAL_HASHPRICE,
    ORACLE_DECIMALS,
    "HashpriceUSDC mock",
  ]);
  const btcUsdcFeed = await deploy(publicClient, owner.client, aggArt, [
    INITIAL_BTC_USDC,
    ORACLE_DECIMALS,
    "BTC/USDC mock",
  ]);

  // ── Vault (UUPS proxy) ────────────────────────────────────────────────
  const vaultArt = artifacts.vault();
  const vaultImpl = await deploy(publicClient, owner.client, vaultArt, []);
  const vault = await deployProxy(
    publicClient,
    owner.client,
    vaultImpl,
    vaultArt.abi,
    "initialize",
    [usdc],
  );

  // ── Perps (UUPS proxy) ────────────────────────────────────────────────
  const perpsArt = artifacts.perps();
  const perpsImpl = await deploy(publicClient, owner.client, perpsArt, [
    MIN_PRICE_INCREMENT,
  ]);
  const perps = await deployProxy(
    publicClient,
    owner.client,
    perpsImpl,
    perpsArt.abi,
    "initialize",
    [hashpriceOracle, vault],
  );

  // ── Futures (UUPS proxy, takes vault in constructor) ──────────────────
  const futuresArt = artifacts.futures();
  const futuresImpl = await deploy(publicClient, owner.client, futuresArt, [
    vault,
  ]);
  const latestBlock = await publicClient.getBlock();
  // First expiry sits one interval out from now (the duration constant is gone —
  // hashpower settles per-day, so only the expiry spacing schedules the book).
  const firstDeliveryDate =
    latestBlock.timestamp + BigInt(FUTURES_EXPIRATION_INTERVAL_DAYS * 24 * 3600);
  // initialize(hashrateOracle, liquidationMarginPercent, minimumPriceIncrement,
  //            expirationIntervalDays, futureDeliveryDatesCount, firstFutureDeliveryDate)
  const futures = await deployProxy(
    publicClient,
    owner.client,
    futuresImpl,
    futuresArt.abi,
    "initialize",
    [
      hashpriceOracle,
      FUTURES_LIQUIDATION_MARGIN_PCT,
      MIN_PRICE_INCREMENT,
      FUTURES_EXPIRATION_INTERVAL_DAYS,
      FUTURES_FUTURE_DELIVERY_DATES_COUNT,
      firstDeliveryDate,
    ],
  );

  // ── PME (UUPS proxy) ──────────────────────────────────────────────────
  const pmeArt = artifacts.pme();
  const pmeImpl = await deploy(publicClient, owner.client, pmeArt, []);
  const pme = await deployProxy(
    publicClient,
    owner.client,
    pmeImpl,
    pmeArt.abi,
    "initialize",
    [vault],
  );

  // ── Wire PME ↔ venues ↔ vault ─────────────────────────────────────────
  // PME -> learn about each venue so portfolio MM math includes both legs.
  await write(publicClient, owner.client, pme, pmeArt.abi, "setPerps", [perps]);
  await write(publicClient, owner.client, pme, pmeArt.abi, "setFutures", [
    futures,
  ]);

  // Vault -> point at the single margin engine + authorize each venue.
  await write(
    publicClient,
    owner.client,
    vault,
    vaultArt.abi,
    "setMarginEngine",
    [pme],
  );
  await write(
    publicClient,
    owner.client,
    vault,
    vaultArt.abi,
    "setAuthorizedCaller",
    [perps, true],
  );
  await write(
    publicClient,
    owner.client,
    vault,
    vaultArt.abi,
    "setAuthorizedCaller",
    [futures, true],
  );

  // Perps -> PME + fee config.
  await write(
    publicClient,
    owner.client,
    perps,
    perpsArt.abi,
    "setPortfolioMargin",
    [pme],
  );
  await write(publicClient, owner.client, perps, perpsArt.abi, "setMatchFee", [
    Number(PERPS_TAKER_FEE_BPS),
    Number(PERPS_MAKER_FEE_BPS),
  ]);
  await write(
    publicClient,
    owner.client,
    perps,
    perpsArt.abi,
    "setLiquidationFee",
    [PERPS_LIQUIDATION_FEE],
  );

  // Futures -> PME + fees + validator URL.
  await write(
    publicClient,
    owner.client,
    futures,
    futuresArt.abi,
    "setMarginEngine",
    [pme],
  );
  await write(
    publicClient,
    owner.client,
    futures,
    futuresArt.abi,
    "setTakerFee",
    [FUTURES_TAKER_FEE],
  );
  await write(
    publicClient,
    owner.client,
    futures,
    futuresArt.abi,
    "setLiquidationFee",
    [FUTURES_LIQUIDATION_FEE],
  );

  // ── Fund & approve test wallets ───────────────────────────────────────
  for (const w of [alice, bob, liquidator, validator, dave]) {
    await write(publicClient, owner.client, usdc, usdcArt.abi, "transfer", [
      w.account.address,
      INITIAL_USER_BALANCE,
    ]);
  }
  for (const w of [owner, alice, bob, liquidator, validator, dave]) {
    await write(publicClient, w.client, usdc, usdcArt.abi, "approve", [
      vault,
      APPROVE_MAX,
    ]);
  }

  // ── Seed insurance fund (owner-funded) ────────────────────────────────
  await write(
    publicClient,
    owner.client,
    vault,
    vaultArt.abi,
    "depositInsuranceFund",
    [INSURANCE_FUND],
  );

  return {
    publicClient,
    testClient,
    transport,
    rpcUrl,
    accounts: { owner, alice, bob, liquidator, validator, dave },
    addresses: {
      usdc,
      hashpriceOracle,
      btcUsdcFeed,
      vault,
      pme,
      perps,
      futures,
      multicall3,
    },
    abis: {
      usdc: usdcArt.abi,
      hashpriceOracle: aggArt.abi,
      btcUsdcFeed: aggArt.abi,
      vault: vaultArt.abi,
      pme: pmeArt.abi,
      perps: perpsArt.abi,
      futures: futuresArt.abi,
    },
    config: {
      tokenDecimals: TOKEN_DECIMALS,
      oracleDecimals: ORACLE_DECIMALS,
      initialHashprice: INITIAL_HASHPRICE,
      initialMarketPrice: INITIAL_MARKET_PRICE,
      initialBtcUsdc: INITIAL_BTC_USDC,
      minimumPriceIncrement: MIN_PRICE_INCREMENT,
      quantityDecimals: QUANTITY_DECIMALS,
      perpsLiquidationFee: PERPS_LIQUIDATION_FEE,
      perpsTakerFeeBps: PERPS_TAKER_FEE_BPS,
      perpsMakerFeeBps: PERPS_MAKER_FEE_BPS,
      futuresTakerFee: FUTURES_TAKER_FEE,
      futuresLiquidationFee: FUTURES_LIQUIDATION_FEE,
      futuresFirstDeliveryDate: firstDeliveryDate,
      insuranceFund: INSURANCE_FUND,
      initialUserBalance: INITIAL_USER_BALANCE,
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

async function deploy(
  pc: PublicClient,
  wc: WalletClient,
  artifact: CompiledArtifact,
  args: readonly unknown[],
): Promise<Address> {
  const hash = await wc.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: args as never,
    account: wc.account!,
    chain: hardhat,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("deployContract receipt missing contractAddress");
  }
  return receipt.contractAddress;
}

async function deployProxy(
  pc: PublicClient,
  wc: WalletClient,
  implementation: Address,
  implAbi: Abi,
  initFn: string,
  initArgs: readonly unknown[],
): Promise<Address> {
  const initData = encodeFunctionData({
    abi: implAbi,
    functionName: initFn,
    args: initArgs as never,
  });
  return deploy(pc, wc, artifacts.erc1967Proxy(), [implementation, initData]);
}

async function write(
  pc: PublicClient,
  wc: WalletClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const hash = await wc.writeContract({
    address,
    abi,
    functionName,
    args: args as never,
    account: wc.account!,
    chain: hardhat,
  });
  await pc.waitForTransactionReceipt({ hash });
}
