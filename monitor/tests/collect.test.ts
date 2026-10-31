/**
 * Drives collect() through a fake fetch that answers both the GraphQL
 * queries and the JSON-RPC calls viem makes, so the metric math runs
 * end-to-end without a network.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  parseAbi,
  toFunctionSelector,
  toHex,
} from "viem";

process.env.CW_NAMESPACE = "Test";
process.env.VAULT_SUBGRAPH_URL = "https://vault.test/gql";
process.env.POINTS_SUBGRAPH_URL = "https://points.test/gql";
process.env.ETH_RPC_URL = "https://rpc.test/v2/key";
process.env.VAULT_ADDRESS = "0x0000000000000000000000000000000000000001";
process.env.FUTURES_ADDRESS = "0x0000000000000000000000000000000000000002";
process.env.PERPS_ADDRESS = "0x0000000000000000000000000000000000000003";
process.env.MM_ADDRESS = "0x0000000000000000000000000000000000000004";
process.env.MM_FUTURES_MARKETS = "3";
process.env.MM_HEALTH_URL = "https://mm.test/health/raw";
process.env.BITCOIN_RPC_URL = "https://btc.test/v2/key";

const venueAbi = parseAbi([
  "struct RiskView { int256 netPositionDelta; int256 unrealizedPnl; int256 pendingFunding; uint256 buyOrderDelta; uint256 sellOrderDelta; uint256 buyOrderFillLoss; uint256 sellOrderFillLoss; }",
  "struct Position { int256 netQuantity; int256 netEntryValue; }",
  "function getRiskView(address user) view returns (RiskView)",
  "function getActiveExpirationDates(address user) view returns (uint256[])",
  "function getUserPosition(address user, uint256 expirationAt) view returns (Position)",
  "function getUserPosition(address user) view returns (Position)",
  "function getOrderBookPrices(uint256 maxLevels) view returns (uint256[] bids, uint256[] asks)",
  "function getOrderBookPrices(uint256 expirationAt, uint256 maxLevels) view returns (uint256[] bids, uint256[] asks)",
  "function getMarketPrice() view returns (uint256)",
  "function getExpirationDates() view returns (uint256[])",
  "function liquidationFeeBps() view returns (uint16)",
  "function liquidatorShareBps() view returns (uint16)",
]);
const mmAbi = parseAbi([
  "function balanceOf(address user) view returns (uint256)",
  "function computePortfolioIM(address user) view returns (uint256)",
  "function getEthBalance(address addr) view returns (uint256)",
]);
const MARGIN_ENGINE = "0x0000000000000000000000000000000000000009";
let failMarketMaker = false;
let failHealth = false;

const healthResponse = () => ({
  status: "running",
  uptimeSeconds: 3_600,
  risk: { throttled: false, pauseNew: true },
  markets: [
    { id: "perps", breaker: "active", ownOrders: 20 },
    { id: "futures:100", breaker: "quarantined", ownOrders: 0 },
    { id: "futures:200", breaker: "degraded", ownOrders: 7 },
    { id: "futures:300", breaker: "active", ownOrders: 12 },
  ],
  stats: { lastTickAt: Date.now() - 30_000 },
});

const getEthBalanceSelector = toFunctionSelector(
  "function getEthBalance(address addr)",
);
const BLOCK = 1_000;
const USDC = 6;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const u = (n: number) => String(BigInt(n) * 10n ** BigInt(USDC));
const multicallSizes: number[] = [];

const vaultResponse = {
  _meta: {
    block: { number: String(BLOCK), timestamp: null },
    hasIndexingErrors: false,
  },
  vault: {
    insuranceFundBalance: u(500),
    insuranceDebt: u(100),
    insuranceDebtCap: u(1000),
    timingDebt: u(20),
    uncoveredLoss: u(80),
    insuranceCapital: u(400),
    traderBadDebtTotal: u(30),
    backstopBalance: u(50),
    backstopBadDebtTotal: u(10),
    backstopUnwindBandBps: "200",
    backstopUnwindFeeBps: "25",
    totalSupply: u(10_000),
    halted: false,
    marginEngine: "0x0000000000000000000000000000000000000009",
    decimals: String(USDC),
    collateralToken: "0x000000000000000000000000000000000000000a",
  },
  vaultVenues: [
    {
      id: process.env.FUTURES_ADDRESS,
      traderBadDebtTotal: u(30),
      backstopBadDebtTotal: u(10),
    },
  ],
  futuresUser: { balance: u(7) },
  perpsUser: null,
};

const riskView = (unrealizedPnl: bigint, pendingFunding: bigint) => ({
  netPositionDelta: 0n,
  unrealizedPnl,
  pendingFunding,
  buyOrderDelta: 0n,
  sellOrderDelta: 0n,
  buyOrderFillLoss: 0n,
  sellOrderFillLoss: 0n,
});

/**
 * Price feeds, answered per block: the subgraph block now, block 0 as the
 * past (the 1 h and 24 h look-backs both clamp to it at this test height).
 */
const HASHPRICE_FEED = "0x00000000000000000000000000000000000000f1";
const BTC_FEED = "0x00000000000000000000000000000000000000f2";
const feedAbi = parseAbi([
  "function priceOracle() view returns (address)",
  "function btcUsdOracle() view returns (address)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function mmSpotShock() view returns (uint256)",
]);
const FEEDS: Record<string, { now: bigint; past: bigint; ageSeconds: number }> = {
  [HASHPRICE_FEED]: { now: 3_300_000_000n, past: 3_000_000_000n, ageSeconds: 120 },
  [BTC_FEED]: { now: 8_000_000_000_000n, past: 7_600_000_000_000n, ageSeconds: 60 },
};

function feedCall(to: string, data: `0x${string}`, block: string): `0x${string}` {
  const { functionName } = decodeFunctionData({ abi: feedAbi, data });
  if (functionName === "btcUsdOracle")
    return encodeFunctionResult({ abi: feedAbi, functionName, result: BTC_FEED });
  if (functionName === "decimals")
    return encodeFunctionResult({ abi: feedAbi, functionName, result: 8 });
  assert.equal(functionName, "latestRoundData");
  const feed = FEEDS[to];
  const answer = block === toHex(BLOCK) ? feed.now : feed.past;
  const updatedAt = BigInt(Math.floor(Date.now() / 1000) - feed.ageSeconds);
  return encodeFunctionResult({
    abi: feedAbi,
    functionName,
    result: [1n, answer, updatedAt, updatedAt, 1n],
  });
}

function ethCall(to: string, data: `0x${string}`): `0x${string}` {
  const address = to.toLowerCase();
  if (address === process.env.VAULT_ADDRESS) {
    // Only the market maker's own vault balance is read from the vault.
    const { args } = decodeFunctionData({ abi: mmAbi, data });
    assert.equal(args?.[0], process.env.MM_ADDRESS);
    return encodeFunctionResult({
      abi: mmAbi,
      functionName: "balanceOf",
      result: BigInt(u(1_800)),
    });
  }
  if (address === MARGIN_ENGINE && data.startsWith(toFunctionSelector("function mmSpotShock()")))
    return encodeFunctionResult({ abi: feedAbi, functionName: "mmSpotShock", result: 10n ** 17n });
  if (address === process.env.FUTURES_ADDRESS && data.startsWith(toFunctionSelector("function priceOracle()")))
    return encodeFunctionResult({ abi: feedAbi, functionName: "priceOracle", result: HASHPRICE_FEED });
  if (address === MARGIN_ENGINE)
    return encodeFunctionResult({
      abi: mmAbi,
      functionName: "computePortfolioIM",
      result: BigInt(u(900)),
    });
  if (address === MULTICALL3 && data.startsWith(getEthBalanceSelector))
    return encodeFunctionResult({
      abi: mmAbi,
      functionName: "getEthBalance",
      result: 175_000_000_000_000_000n,
    });
  if (address === MULTICALL3) {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    assert.equal(decoded.functionName, "aggregate3");
    const calls = decoded.args[0];
    multicallSizes.push(calls.length);
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: calls.map(({ target, callData }) => ({
        success: true,
        returnData: ethCall(target, callData),
      })),
    });
  }
  if (address === vaultResponse.vault.collateralToken) {
    // supply 10_000 - debt 100 - balance 9_899 → gap of 1 USDC
    return encodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      result: BigInt(u(9_899)),
    });
  }
  const { functionName, args } = decodeFunctionData({ abi: venueAbi, data });
  const isFutures = address === process.env.FUTURES_ADDRESS;
  const isMm = args?.[0] === process.env.MM_ADDRESS;
  switch (functionName) {
    case "getOrderBookPrices": {
      if (failMarketMaker) throw new Error("book read reverted");
      // perps two-sided; futures 100 two-sided, 200 bids only, 300 two-sided.
      const expiry = isFutures ? args?.[0] : undefined;
      const bids = [39_500_000n, 39_490_000n];
      const asks = expiry === 200n ? [] : [39_510_000n];
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: [bids, asks],
      });
    }
    case "getMarketPrice":
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: 40_000_000n,
      });
    case "getExpirationDates":
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: [100n, 200n, 300n, 400n],
      });
    case "getRiskView":
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: isFutures
          ? riskView(-15_000_000n, 0n)
          : riskView(4_000_000n, 1_000_000n),
      });
    case "liquidationFeeBps":
      // futures keeps 200 × 80% = 160 bps, perps 300 × 80% = 240 bps.
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: isFutures ? 200 : 300,
      });
    case "liquidatorShareBps":
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: 2_000,
      });
    case "getActiveExpirationDates":
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: [100n, 200n],
      });
    case "getUserPosition":
      if (isMm) {
        // MM: perps +56 units; futures 100 → -9, 200 → flat, 300 → +25.
        const byExpiry: Record<string, bigint> = { "100": -9n, "300": 25n };
        return encodeFunctionResult({
          abi: venueAbi,
          functionName,
          result: {
            netQuantity: isFutures
              ? (byExpiry[String(args?.[1])] ?? 0n)
              : 56_000_000n,
            netEntryValue: 0n,
          },
        });
      }
      // futures: expiry 100 → +2, expiry 200 → flat; perps → -7e6
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: isFutures
          ? { netQuantity: args?.[1] === 100n ? 2n : 0n, netEntryValue: 0n }
          : { netQuantity: -7_000_000n, netEntryValue: 0n },
      });
    default:
      throw new Error(`unexpected call ${functionName}`);
  }
}

function rpc(request: { id: number; method: string; params: unknown[] }) {
  const { id, method, params } = request;
  let result: unknown;
  switch (method) {
    case "eth_blockNumber":
      result = toHex(BLOCK + 3);
      break;
    case "eth_getBlockByNumber":
      result = {
        number: toHex(BLOCK),
        timestamp: toHex(Math.floor(Date.now() / 1000) - 42),
        transactions: [],
      };
      break;
    case "eth_call": {
      const [call, block] = params as [
        { to: string; data: `0x${string}` },
        string,
      ];
      // Price history is read at past blocks; every other read is pinned.
      if (call.to.toLowerCase() in FEEDS) {
        result = feedCall(call.to.toLowerCase(), call.data, block);
        break;
      }
      assert.equal(
        block,
        toHex(BLOCK),
        "every eth_call must be pinned to the subgraph block",
      );
      result = ethCall(call.to, call.data);
      break;
    }
    default:
      throw new Error(`unexpected rpc ${method}`);
  }
  return { jsonrpc: "2.0", id, result };
}

function graphql(url: string) {
  if (url.startsWith("https://vault.test")) return { data: vaultResponse };
  if (url.startsWith("https://points.test"))
    return {
      data: {
        _meta: {
          block: { number: String(BLOCK - 7) },
          hasIndexingErrors: true,
        },
      },
    };
  throw new Error(`unexpected url ${url}`);
}

/** Bitcoin tip 4,000 blocks before the 1,050,000 halving, 9.5-minute blocks over the last 2,016. */
const BTC_TIP = 1_046_000;
const BTC_TIP_TIME = 1_900_000_000;
const BTC_BLOCK_SECONDS = 570;

function bitcoinRpc(request: { id: number; method: string; params: unknown[] }) {
  const { id, method, params } = request;
  let result: unknown;
  if (method === "getblockcount") result = BTC_TIP;
  else if (method === "getblockhash") result = `hash-${params[0]}`;
  else if (method === "getblockheader") {
    const height = Number(String(params[0]).slice("hash-".length));
    result = { height, time: BTC_TIP_TIME - (BTC_TIP - height) * BTC_BLOCK_SECONDS };
  } else throw new Error(`unexpected bitcoin rpc ${method}`);
  return { jsonrpc: "2.0", id, result, error: null };
}

const userAgents = new Set<string>();

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = String(input);
  if (url.startsWith("https://mm.test"))
    return failHealth
      ? new Response("busy", { status: 503 })
      : Response.json(healthResponse());
  if (url.startsWith("https://btc.test"))
    return Response.json(bitcoinRpc(JSON.parse(String(init?.body))));
  userAgents.add(new Headers(init?.headers).get("user-agent") ?? "");
  const body = JSON.parse(String(init?.body));
  const payload = url.startsWith("https://rpc.test")
    ? Array.isArray(body)
      ? body.map(rpc)
      : rpc(body)
    : graphql(url);
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

describe("collect", () => {
  let points: {
    MetricName?: string;
    Value?: number;
    Dimensions?: { Name?: string; Value?: string }[];
  }[];
  let summary: string;

  const value = (name: string, dimension?: string) => {
    const hit = points.find(
      (p) =>
        p.MetricName === name &&
        (dimension === undefined
          ? !p.Dimensions
          : p.Dimensions?.[0]?.Value === dimension),
    );
    assert.ok(hit, `missing metric ${name} ${dimension ?? ""}`);
    return hit.Value;
  };

  before(async () => {
    ({ points, summary } = await (await import("../src/index.ts")).collect());
  });

  it("sends the User-Agent Goldsky requires", () => {
    assert.ok(userAgents.has("col-mar-vault-mon"));
  });

  it("batches contract reads into two multicalls per check", () => {
    // backstop 11 + 2 legs; market maker 8 + 2 reads for each of 3 expiries
    assert.deepEqual(
      [...multicallSizes].sort((a, b) => a - b),
      [2, 6, 8, 11],
    );
  });

  it("converts vault balances to USDC units", () => {
    assert.equal(value("InsuranceDebt"), 100);
    assert.equal(value("InsuranceDebtUtilizationPct"), 10);
    assert.equal(value("FuturesFeeBalance"), 7);
    assert.equal(value("PerpsFeeBalance"), 0);
    assert.equal(value("Halted"), 0);
    assert.equal(value("MarginEngineUnset"), 0);
    assert.equal(value("CheckSuccess"), 1);
  });

  it("computes the backing gap at the subgraph block", () => {
    assert.equal(value("BackingGap"), 1);
    assert.match(summary, /gap_raw=1000000 /);
  });

  it("uses the chain timestamp when the subgraph leaves it null", () => {
    const age = value("SubgraphDataAgeSeconds") ?? 0;
    assert.ok(age >= 42 && age < 50, `age ${age}`);
    assert.equal(value("SubgraphBlocksBehind", "vault"), 3);
  });

  it("reports points-subgraph drift against the chain head", () => {
    assert.equal(value("SubgraphBlocksBehind", "points"), 10);
    assert.equal(value("SubgraphIndexingErrors", "points"), 1);
  });

  it("derives backstop equity from balance, unrealized PnL and funding", () => {
    assert.equal(value("BackstopUnrealizedPnl"), -11); // -15 futures + 4 perps
    assert.equal(value("BackstopPendingFunding"), 1);
    assert.equal(value("BackstopEquity"), 40); // 50 - 11 + 1
    assert.equal(value("BackstopOpenLegs"), 2); // one futures expiry, one perps
    assert.equal(value("BackstopFuturesNetQuantity"), 2);
    assert.equal(value("BackstopFuturesNetQuantity", "100"), 2);
    assert.equal(value("BackstopPerpsNetQuantity"), -7_000_000);
  });

  it("reports backstop exposure at the mark in USDC", () => {
    assert.equal(value("BackstopNotional", process.env.FUTURES_ADDRESS), 80); // 2 × $40
    assert.equal(value("BackstopNotional", process.env.PERPS_ADDRESS), 280); // 7 × $40
    assert.equal(value("BackstopNotional"), 360);
  });

  it("X3-R3A-2: flags an unwind band plus fee above the kept liquidation fee", () => {
    assert.equal(
      value("BackstopUnwindBudgetBps", process.env.FUTURES_ADDRESS),
      160,
    );
    assert.equal(
      value("BackstopUnwindBudgetBps", process.env.PERPS_ADDRESS),
      240,
    );
    // band 200 + fee 25 against the tighter 160 bps budget
    assert.equal(value("BackstopUnwindOverBudgetBps"), 65);
  });

  it("counts down to the next Bitcoin halving from the node's tip", () => {
    assert.equal(value("BtcBlocksUntilHalving"), 4_000);
    const days = value("BtcDaysUntilHalving") ?? 0;
    assert.ok(Math.abs(days - (4_000 * BTC_BLOCK_SECONDS) / 86_400) < 1e-9, `days ${days}`);
  });

  it("reports hashprice and BTC prices, their moves, feed ages and the MM shock", () => {
    assert.equal(value("HashpriceUsd"), 33);
    assert.equal(value("BtcUsd"), 80_000);
    assert.ok(Math.abs((value("HashpriceChange24hPct") ?? 0) - 10) < 1e-9);
    assert.ok(Math.abs((value("HashpriceChange1hPct") ?? 0) - 10) < 1e-9);
    assert.ok(Math.abs((value("BtcChange24hPct") ?? 0) - 400 / 76) < 1e-9);
    assert.equal(value("MmSpotShockPct"), 10);
    assert.ok(Math.abs((value("HashpriceFeedAgeSeconds") ?? 0) - 120) <= 5);
    assert.ok(Math.abs((value("BtcUsdFeedAgeSeconds") ?? 0) - 60) <= 5);
  });

  it("tags per-venue bad debt with the venue address", () => {
    assert.equal(value("TraderBadDebtTotal", process.env.FUTURES_ADDRESS), 30);
    assert.equal(
      value("BackstopBadDebtTotal", process.env.FUTURES_ADDRESS),
      10,
    );
  });

  it("counts book levels per market and flags the emptiest side", () => {
    assert.equal(value("BookBidLevels", "perps"), 2);
    assert.equal(value("BookAskLevels", "perps"), 1);
    assert.equal(value("BookAskLevels", "futures-200"), 0);
    assert.equal(value("BookMinSideLevels"), 0);
    // only the nearest MM_FUTURES_MARKETS expiries are watched
    assert.ok(!points.some((p) => p.Dimensions?.[0]?.Value === "futures-400"));
    const spread = value("BookSpreadBps", "perps") ?? 0;
    assert.ok(Math.abs(spread - 2.53) < 0.01, `spread ${spread}`);
  });

  it("measures how far each book's mid sits from the mark", () => {
    // mid 39.505 against a $40 mark
    const drift = value("BookMidDriftBps", "perps") ?? 0;
    assert.ok(Math.abs(drift - 123.75) < 0.01, `drift ${drift}`);
    assert.ok(Math.abs((value("BookMaxMidDriftBps") ?? 0) - 123.75) < 0.01);
    // a one-sided book has no mid
    assert.ok(
      !points.some(
        (p) =>
          p.MetricName === "BookMidDriftBps" &&
          p.Dimensions?.[0]?.Value === "futures-200",
      ),
    );
  });

  it("reports the market maker's own state from /health", () => {
    assert.equal(value("MmHealthCheckSuccess"), 1);
    assert.equal(value("MmRunning"), 1);
    const tickAge = value("MmTickAgeSeconds") ?? 0;
    assert.ok(tickAge >= 30 && tickAge < 40, `tick age ${tickAge}`);
    assert.equal(value("MmThrottled"), 0);
    assert.equal(value("MmPausedNew"), 1);
    assert.equal(value("MmQuarantinedMarkets"), 1);
    assert.equal(value("MmMarketCount"), 4);
    assert.equal(value("MmMinOwnOrders"), 0);
    assert.equal(value("MmOwnOrders", "perps"), 20);
    assert.equal(value("MmOwnOrders", "futures-100"), 0);
    assert.match(summary, /mm_status=running quarantined=1 min_own_orders=0/);
  });

  it("reports market-maker position notional in USDC", () => {
    assert.equal(value("MmPositionNotional", "perps"), 2_240); // 56 × $40
    assert.equal(value("MmPositionNotional", "futures-100"), 360); // 9 × $40
    assert.equal(value("MmPerpsPositionNotional"), 2_240);
    assert.equal(value("MmFuturesMaxPositionNotional"), 1_000); // 25 × $40
  });

  it("reports market-maker funds", () => {
    assert.equal(value("MmVaultBalance"), 1_800);
    assert.equal(value("MmPortfolioIM"), 900);
    assert.equal(value("MmUtilizationPct"), 50);
    assert.equal(value("MmEthBalance"), 0.175);
    assert.equal(value("MarketCheckSuccess"), 1);
  });

  it("keeps the vault check alive when the market-maker reads fail", async () => {
    failMarketMaker = true;
    try {
      const { collect } = await import("../src/index.ts");
      const result = await collect();
      const names = result.points.map((p) => p.MetricName);
      assert.ok(names.includes("InsuranceDebt"));
      assert.ok(!names.includes("BookMinSideLevels"));
      const check = result.points.find(
        (p) => p.MetricName === "MarketCheckSuccess",
      );
      assert.equal(check?.Value, 0);
      assert.match(result.summary, /mm=failed/);
    } finally {
      failMarketMaker = false;
    }
  });

  it("keeps the other checks alive when /health is unreachable", async () => {
    failHealth = true;
    try {
      const { collect } = await import("../src/index.ts");
      const result = await collect();
      const names = result.points.map((p) => p.MetricName);
      assert.ok(names.includes("InsuranceDebt"));
      assert.ok(names.includes("BookMinSideLevels"));
      assert.ok(!names.includes("MmRunning"));
      const check = result.points.find(
        (p) => p.MetricName === "MmHealthCheckSuccess",
      );
      assert.equal(check?.Value, 0);
      assert.match(result.summary, /mm_health=failed/);
    } finally {
      failHealth = false;
    }
  });
});
