/**
 * One-off diagnostic: replicate `DeliveryCoordinator.bootstrapFromUsers`
 * against the live RPC for a hard-coded user list, printing exactly what
 * `multicall` returns at each stage. Lets us tell whether discovery is
 * silently no-oping (returns []) vs throwing (caught somewhere) vs
 * returning data we then fail to index.
 *
 * Run with:
 *   pnpm node --env-file=../.env scripts/debug-delivery-bootstrap.ts
 */
import { createPublicClient, http, type Address, type Hex } from "viem";
import { baseSepolia, base, hardhat } from "viem/chains";
import { FuturesAbi } from "futures-marketplace/Futures.ts";

const FUTURES = process.env.FUTURES_ADDRESS as Address;
const NETWORK = process.env.NETWORK ?? "base-sepolia";
const ALCHEMY = process.env.ALCHEMY_API_KEY;
if (FUTURES === undefined || ALCHEMY === undefined) {
  throw new Error("FUTURES_ADDRESS and ALCHEMY_API_KEY must be set in env");
}

const RPC_URL = `https://${NETWORK}.g.alchemy.com/v2/${ALCHEMY}`;
const CHAINS = { "base-sepolia": baseSepolia, "base-mainnet": base, hardhat };
const chain = CHAINS[NETWORK as keyof typeof CHAINS];

// Hard-coded list mirroring the production tracker.list() output.
// Edit if you want to test different users.
const USERS: Address[] = [
  "0x1441Bc52156Cf18c12cde6A92aE6BDE8B7f775D4",
];

const client = createPublicClient({ chain, transport: http(RPC_URL) });

console.log("RPC:", RPC_URL.replace(ALCHEMY, "***"));
console.log("FUTURES:", FUTURES);
console.log("USERS:", USERS);
console.log("multicall3 configured:", chain.contracts?.multicall3?.address);

console.log("\n--- Stage 1: getPositionIds via multicall ---");
const idLists = await client.multicall({
  contracts: USERS.map((u) => ({
    address: FUTURES,
    abi: FuturesAbi,
    functionName: "getPositionIds" as const,
    args: [u] as const,
  })),
  allowFailure: false,
});
console.log("results:");
for (let i = 0; i < USERS.length; i++) {
  const ids = idLists[i] as readonly Hex[];
  console.log(`  ${USERS[i]} → ${ids.length} positions`);
  for (const id of ids) console.log(`    ${id}`);
}

const allIds: Hex[] = [];
for (const ids of idLists as readonly (readonly Hex[])[]) allIds.push(...ids);
if (allIds.length === 0) {
  console.log("\nNo positions found — bootstrap would return early.");
  process.exit(0);
}

console.log(`\n--- Stage 2: getPositionById for ${allIds.length} ids ---`);
const positions = await client.multicall({
  contracts: allIds.map((id) => ({
    address: FUTURES,
    abi: FuturesAbi,
    functionName: "getPositionById" as const,
    args: [id] as const,
  })),
  allowFailure: false,
});

const now = BigInt(Math.floor(Date.now() / 1000));
const block = await client.getBlock();
console.log("wall-clock now:", now, "  block.timestamp:", block.timestamp);

const deliveryDurationDays = (await client.readContract({
  address: FUTURES,
  abi: FuturesAbi,
  functionName: "deliveryDurationDays",
})) as number;
const window = BigInt(deliveryDurationDays) * 86_400n;
console.log("deliveryDurationDays:", deliveryDurationDays, "→ window:", window, "s");

let live = 0;
let pastDue = 0;
let expired = 0;
for (let i = 0; i < allIds.length; i++) {
  const id = allIds[i] as Hex;
  const pos = positions[i] as {
    seller: Address;
    buyer: Address;
    deliveryAt: bigint;
  };
  const closed = pos.seller === "0x0000000000000000000000000000000000000000";
  if (closed) {
    console.log(`  ${id}  CLOSED (seller==0)`);
    continue;
  }
  live++;
  const due = block.timestamp >= pos.deliveryAt;
  const dead = block.timestamp > pos.deliveryAt + window;
  if (dead) expired++;
  else if (due) pastDue++;
  console.log(
    `  ${id}  seller=${pos.seller}  buyer=${pos.buyer}  deliveryAt=${pos.deliveryAt}  ${
      dead ? "EXPIRED-WINDOW" : due ? "PAST-DUE" : "FUTURE"
    }`,
  );
}
console.log(`\nsummary: ${live} live, ${pastDue} past-due (settleable), ${expired} expired-window`);
