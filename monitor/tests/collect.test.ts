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
  toHex,
} from "viem";

process.env.CW_NAMESPACE = "Test";
process.env.VAULT_SUBGRAPH_URL = "https://vault.test/gql";
process.env.POINTS_SUBGRAPH_URL = "https://points.test/gql";
process.env.ETH_RPC_URL = "https://rpc.test/v2/key";
process.env.VAULT_ADDRESS = "0x0000000000000000000000000000000000000001";
process.env.FUTURES_ADDRESS = "0x0000000000000000000000000000000000000002";
process.env.PERPS_ADDRESS = "0x0000000000000000000000000000000000000003";

const venueAbi = parseAbi([
  "struct RiskView { int256 netPositionDelta; int256 unrealizedPnl; int256 pendingFunding; uint256 buyOrderDelta; uint256 sellOrderDelta; uint256 buyOrderFillLoss; uint256 sellOrderFillLoss; }",
  "struct Position { int256 netQuantity; int256 netEntryValue; }",
  "function getRiskView(address user) view returns (RiskView)",
  "function getActiveExpirationDates(address user) view returns (uint256[])",
  "function getUserPosition(address user, uint256 expirationAt) view returns (Position)",
  "function getUserPosition(address user) view returns (Position)",
]);

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

function ethCall(to: string, data: `0x${string}`): `0x${string}` {
  const address = to.toLowerCase();
  if (address === process.env.VAULT_ADDRESS)
    throw new Error("no calls to the vault expected");
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
  switch (functionName) {
    case "getRiskView":
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: isFutures
          ? riskView(-15_000_000n, 0n)
          : riskView(4_000_000n, 1_000_000n),
      });
    case "getActiveExpirationDates":
      return encodeFunctionResult({
        abi: venueAbi,
        functionName,
        result: [100n, 200n],
      });
    case "getUserPosition":
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

const userAgents = new Set<string>();

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = String(input);
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

  it("batches contract reads into two multicalls", () => {
    assert.deepEqual(multicallSizes, [5, 2]);
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

  it("tags per-venue bad debt with the venue address", () => {
    assert.equal(value("TraderBadDebtTotal", process.env.FUTURES_ADDRESS), 30);
    assert.equal(
      value("BackstopBadDebtTotal", process.env.FUTURES_ADDRESS),
      10,
    );
  });
});
