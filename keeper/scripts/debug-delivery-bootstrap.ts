/**
 * One-off diagnostic: replicate `DeliveryCoordinator.bootstrapFromUsers`
 * against the live RPC for a hard-coded user list.
 *
 * Run with:
 *   pnpm node --env-file=../.env scripts/debug-delivery-bootstrap.ts
 */
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia, base, hardhat } from "viem/chains";
import { FuturesAbi } from "futures-marketplace-abi/Futures.ts";

const FUTURES = process.env.FUTURES_ADDRESS as Address;
const NETWORK = process.env.NETWORK ?? "base-sepolia";
const ALCHEMY = process.env.ALCHEMY_API_KEY;
if (FUTURES === undefined || ALCHEMY === undefined) {
  throw new Error("FUTURES_ADDRESS and ALCHEMY_API_KEY must be set in env");
}

const RPC_URL = `https://${NETWORK}.g.alchemy.com/v2/${ALCHEMY}`;
const CHAINS = { "base-sepolia": baseSepolia, "base-mainnet": base, hardhat };
const chain = CHAINS[NETWORK as keyof typeof CHAINS];

const USERS: Address[] = ["0x1441Bc52156Cf18c12cde6A92aE6BDE8B7f775D4"];

const client = createPublicClient({ chain, transport: http(RPC_URL) });

console.log("RPC:", RPC_URL.replace(ALCHEMY, "***"));
console.log("FUTURES:", FUTURES);
console.log("USERS:", USERS);

console.log("\n--- Stage 1: getActiveExpirationDates via multicall ---");
const dateLists = await client.multicall({
  contracts: USERS.map((u) => ({
    address: FUTURES,
    abi: FuturesAbi,
    functionName: "getActiveExpirationDates" as const,
    args: [u] as const,
  })),
  allowFailure: false,
});

type Pair = { user: Address; expirationAt: bigint };
const pairs: Pair[] = [];
for (let i = 0; i < USERS.length; i++) {
  const user = USERS[i]!;
  const dates = dateLists[i] as readonly bigint[];
  console.log(`  ${user} → ${dates.length} expiries`);
  for (const expirationAt of dates) {
    console.log(`    ${expirationAt}`);
    pairs.push({ user, expirationAt });
  }
}

if (pairs.length === 0) {
  console.log("\nNo positions found — bootstrap would return early.");
  process.exit(0);
}

console.log(`\n--- Stage 2: getUserPosition for ${pairs.length} aggregates ---`);
const positions = await client.multicall({
  contracts: pairs.map((p) => ({
    address: FUTURES,
    abi: FuturesAbi,
    functionName: "getUserPosition" as const,
    args: [p.user, p.expirationAt] as const,
  })),
  allowFailure: false,
});

const now = BigInt(Math.floor(Date.now() / 1000));
const block = await client.getBlock();
console.log("wall-clock now:", now, "  block.timestamp:", block.timestamp);

let live = 0;
let pastDue = 0;
for (let i = 0; i < pairs.length; i++) {
  const pair = pairs[i]!;
  const pos = positions[i] as { netQuantity: bigint; netEntryValue: bigint };
  if (pos.netQuantity === 0n) continue;
  live++;
  const due = block.timestamp >= pair.expirationAt;
  if (due) pastDue++;
  console.log(
    `  ${pair.user} @ ${pair.expirationAt}: qty=${pos.netQuantity} entryValue=${pos.netEntryValue}` +
      (due ? " PAST_DUE" : ""),
  );
}
console.log(`\nlive aggregates: ${live}, past-due: ${pastDue}`);
