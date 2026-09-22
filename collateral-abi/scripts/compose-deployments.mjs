// Rebuild deployments.json for the branch that is about to publish.
//
//   dev  owns environments.testnet  (config/dev.env) and copies mainnet
//        forward from the npm `latest` tag.
//   main owns environments.mainnet (config/prd.env) and copies testnet
//        forward from the npm `dev` tag (falling back to `latest`).
//
// Unmapped contract keys already in this environment (for example
// HashrateOracleLegacy) are kept. An address that only changed checksum
// casing keeps the spelling already in the file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(readFileSync(path.join(root, "deployment-sources.json"), "utf8"));
const current = JSON.parse(readFileSync(path.join(root, "deployments.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name;

function parseEnv(file) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

function sameAddress(left, right) {
  return /^0x[0-9a-fA-F]{40}$/.test(left) && left.toLowerCase() === right.toLowerCase();
}

function overlay(prior, updates) {
  const next = { ...(prior ?? {}) };
  for (const [name, value] of Object.entries(updates)) {
    if (!value) continue;
    const existing = next[name];
    next[name] = existing && sameAddress(existing, value) ? existing : value;
  }
  return next;
}

function ownedSnapshot(envName) {
  const spec = sources.envs[envName];
  const env = parseEnv(path.resolve(root, spec.file));
  if (env.CHAIN_ID && Number(env.CHAIN_ID) !== spec.chainId) {
    throw new Error(`${spec.file} CHAIN_ID ${env.CHAIN_ID} does not match ${spec.chainId} for ${envName}`);
  }
  const prior = current.environments?.[envName] ?? {};
  const contracts = overlay(
    prior.contracts,
    Object.fromEntries(
      Object.entries(sources.contracts).map(([name, key]) => [name, env[key]]),
    ),
  );
  const subgraphs = overlay(
    prior.subgraphs,
    Object.fromEntries(
      Object.entries(sources.subgraphs ?? {}).map(([name, key]) => [name, env[key]]),
    ),
  );
  const snapshot = {
    chainId: spec.chainId,
    network: spec.network,
    contracts,
    subgraphs,
  };
  if (prior.startBlock != null) snapshot.startBlock = prior.startBlock;
  return snapshot;
}

function distTags() {
  try {
    return JSON.parse(execFileSync("npm", ["view", pkg, "dist-tags", "--json"], { encoding: "utf8" }));
  } catch {
    return {};
  }
}

function publishedManifest(version) {
  if (!version) return null;
  const dir = mkdtempSync(path.join(tmpdir(), "abi-published-"));
  try {
    const packed = execFileSync(
      "npm",
      ["pack", `${pkg}@${version}`, "--silent", "--pack-destination", dir],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .pop();
    execFileSync("tar", ["-xzf", path.join(dir, packed), "-C", dir]);
    return JSON.parse(readFileSync(path.join(dir, "package", "deployments.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const channel = process.env.CHANNEL === "main" ? "main" : "dev";
const owned = channel === "main" ? "mainnet" : "testnet";
const other = owned === "mainnet" ? "testnet" : "mainnet";
const tags = distTags();
const otherVersion = other === "mainnet" ? tags.latest : tags.dev || tags.latest;
let otherSnapshot = current.environments?.[other] ?? { chainId: sources.envs[other].chainId, network: sources.envs[other].network, contracts: {}, subgraphs: {} };
if (otherVersion) {
  const published = publishedManifest(otherVersion);
  if (published?.environments?.[other]) otherSnapshot = published.environments[other];
}

const environments = {
  testnet: owned === "testnet" ? ownedSnapshot("testnet") : otherSnapshot,
  mainnet: owned === "mainnet" ? ownedSnapshot("mainnet") : otherSnapshot,
};
// Keep startBlock beside the other identity fields when the owned snapshot has one.
for (const name of ["testnet", "mainnet"]) {
  const env = environments[name];
  if (env.startBlock == null) continue;
  const { chainId, network, startBlock, contracts, subgraphs } = env;
  environments[name] = { chainId, network, startBlock, contracts, subgraphs };
}

const next = { package: current.package ?? pkg, environments };
writeFileSync(path.join(root, "deployments.json"), `${JSON.stringify(next, null, 2)}\n`);
console.log(`Composed ${owned} from config and copied ${other} from ${otherVersion ? `${pkg}@${otherVersion}` : "the committed manifest"}`);
