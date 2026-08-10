/**
 * Audit indexer netQuantityAfter against on-chain getActiveExpirationDates count.
 * Finds the first block where indexer and chain diverge.
 *
 * Run:
 *   pnpm node --env-file=../.env --experimental-strip-types scripts/audit-indexer-sync.ts
 */
import { createPublicClient, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { HashPowerFuturesAbi } from "../src/abi/HashPowerFutures.ts";

const ENDPOINT =
  "https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/hpow-futures/dev-latest/gn";
const USER = "0x1441Bc52156Cf18c12cde6A92aE6BDE8B7f775D4".toLowerCase();
const FUT = (process.env.FUTURES_ADDRESS ??
  "0x56d8d4a03a0f34b93B86E0b7941aFF29178D0479") as Address;
const RPC =
  process.env.ETH_NODE_ADDRESS ??
  `https://base-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

if (!RPC)
  throw new Error("Need RPC URL via ETH_NODE_ADDRESS or ALCHEMY_API_KEY");

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

interface TradeFill {
  user: { id: string };
  counterparty: { id: string };
  fillQuantity: number;
  netQuantityAfter: number;
}

interface Trade {
  id: string;
  tradeQuantity: number;
  netQuantityAfter: number;
  expirationAt: string;
  transactionHash: string;
  blockNumber: string;
  fills: TradeFill[];
}

async function fetchTrades(): Promise<Trade[]> {
  const query = `
    query($user: String!) {
      trades(
        where: { fills_: { user: $user } }
        orderBy: blockNumber
        orderDirection: asc
      ) {
        id
        tradeQuantity
        netQuantityAfter
        expirationAt
        transactionHash
        blockNumber
        fills(where: { user: $user }) {
          user { id }
          counterparty { id }
          fillQuantity
          netQuantityAfter
        }
      }
    }
  `;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { user: USER } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.trades as Trade[];
}

async function getChainPositionCount(blockNumber: number): Promise<number> {
  const ids = await client.readContract({
    address: FUT,
    abi: HashPowerFuturesAbi,
    functionName: "getActiveExpirationDates",
    args: [USER as Address],
    blockNumber: BigInt(blockNumber),
  });
  return (ids as readonly bigint[]).length;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Fetching trades from indexer...");
  const trades = await fetchTrades();
  console.log(`Found ${trades.length} trades\n`);

  console.log(
    "%-12s %-10s %-10s %-10s %-10s %s",
    "block",
    "indexer",
    "chainLen",
    "match",
    "tx",
    "status",
  );
  console.log(
    "%-12s %-10s %-10s %-10s %-10s %s",
    "-----",
    "-------",
    "--------",
    "-----",
    "--",
    "------",
  );

  let firstMismatch:
    | { block: number; indexer: number; chain: number; tx: string }
    | undefined;

  for (const t of trades) {
    const block = parseInt(t.blockNumber, 10);
    const indexerAbs = Math.abs(t.netQuantityAfter);

    // Rate-limit ourselves
    await sleep(150);

    let chainLen: number;
    try {
      chainLen = await getChainPositionCount(block);
    } catch (err) {
      console.log(
        "%-12s %-10s %-10s %-10s %-10s %s",
        block,
        indexerAbs,
        "ERR",
        "-",
        t.transactionHash.slice(0, 10),
        "rpc-error",
      );
      continue;
    }

    const match = indexerAbs === chainLen ? "✓" : "✗ MISMATCH";
    const status = indexerAbs === chainLen ? "ok" : "MISMATCH";

    console.log(
      "%-12d %-10d %-10d %-10s %-10s %s",
      block,
      indexerAbs,
      chainLen,
      indexerAbs === chainLen ? "yes" : "NO",
      t.transactionHash.slice(0, 10) + "...",
      status,
    );

    if (indexerAbs !== chainLen && !firstMismatch) {
      firstMismatch = {
        block,
        indexer: indexerAbs,
        chain: chainLen,
        tx: t.transactionHash,
      };
    }
  }

  console.log("\n");
  if (firstMismatch) {
    console.log("First divergence at block %d:", firstMismatch.block);
    console.log("  tx: %s", firstMismatch.tx);
    console.log("  indexer netQuantityAfter (abs): %d", firstMismatch.indexer);
    console.log("  chain getActiveExpirationDates().length:   %d", firstMismatch.chain);
  } else {
    console.log("No divergence detected — indexer and chain are in sync.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
