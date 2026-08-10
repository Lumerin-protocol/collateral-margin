import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";

/**
 * Filesystem-path-based artifact loader.
 *
 * The keeper integration test runs against the *real* compiled bytecode of
 * the perps and futures contracts. Those contracts live in sibling repos
 * with their own Solidity dep trees (OZ, OZ upgradeable, chainlink,
 * solidity-linked-list, `hardhat/console.sol`, `collateral-margin`) and
 * compile cleanly only inside those repos' own Hardhat setups.
 *
 * `pretest:integration` therefore runs each sibling's `pnpm hardhat compile`
 * before the test runs, and this module just reads the resulting Hardhat
 * artifact JSON via filesystem paths. No npm gymnastics.
 *
 * Paths are env-overridable so CI / other devs can point at non-default
 * checkout locations:
 *
 *   PERPS_REPO     – absolute path to the perps repo root
 *   FUTURES_REPO   – absolute path to the futures-marketplace repo root
 *
 * Defaults assume the standard `~/Dev/titan/{perps,futures-marketplace,collateral-margin}`
 * layout that the team uses locally.
 */

export interface CompiledArtifact {
  abi: Abi;
  bytecode: Hex;
}

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");
const DEFAULT_PERPS = resolve(WORKSPACE_ROOT, "perps");
const DEFAULT_FUTURES = resolve(WORKSPACE_ROOT, "futures-marketplace");
const SELF_ROOT = resolve(import.meta.dirname, "../../..");

/**
 * All entries point at the *repo root* (one level above the `contracts/`
 * package directory). The `readArtifact` path join then unconditionally
 * tacks on `contracts/artifacts/...`, so every entry follows the same
 * convention regardless of where the repo is checked out.
 */
const REPO_PATHS = {
  perps: process.env.PERPS_REPO ?? DEFAULT_PERPS,
  futures: process.env.FUTURES_REPO ?? DEFAULT_FUTURES,
  collateral: SELF_ROOT,
} as const;

type Repo = keyof typeof REPO_PATHS;

/**
 * Read a Hardhat artifact JSON and return just the `(abi, bytecode)` pair
 * the deploy module cares about. Throws a clear error if the path is
 * missing — typically means `pretest:integration` didn't run, or the
 * sibling repo hasn't been compiled yet.
 */
function readArtifact(repo: Repo, contractPath: string, contractName: string): CompiledArtifact {
  // Hardhat's artifact layout:
  //   <repo>/contracts/artifacts/<contractPath>.sol/<contractName>.json
  // `contractPath` is the path *under* `contracts/` (e.g. `contracts/Foo`),
  // but for npm-resolved sources it lives under `@openzeppelin/contracts/…`
  // — the dir tree mirrors the import path verbatim.
  const repoRoot = REPO_PATHS[repo];
  const artifactPath = resolve(
    repoRoot,
    "contracts/artifacts",
    `${contractPath}.sol`,
    `${contractName}.json`,
  );
  let raw: string;
  try {
    raw = readFileSync(artifactPath, "utf-8");
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Missing Hardhat artifact at ${artifactPath}.\n` +
        `Run \`pretest:integration\` (or compile the sibling repo manually) before running the tests.\n` +
        `Underlying error: ${cause}`,
    );
  }
  const parsed = JSON.parse(raw) as { abi: Abi; bytecode: Hex };
  if (parsed.bytecode === undefined || parsed.bytecode === "0x") {
    throw new Error(
      `Artifact at ${artifactPath} has no bytecode — is it an interface? (loader expected a deployable contract).`,
    );
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode };
}

/**
 * Concrete artifact handles, declared once so deploy code can typo-check
 * against them rather than passing magic strings around.
 */
export const artifacts = {
  // ── collateral-margin (local) ─────────────────────────────────────────
  vault:        () => readArtifact("collateral", "contracts/CollateralVault",          "CollateralVault"),
  pme:          () => readArtifact("collateral", "contracts/PortfolioMarginEngine",    "PortfolioMarginEngine"),
  usdc:         () => readArtifact("collateral", "contracts/mocks/USDCMock",           "USDCMock"),
  erc1967Proxy: () => readArtifact(
    "collateral",
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy",
    "ERC1967Proxy",
  ),
  /**
   * Aggregator-shape oracle that emits `AnswerUpdated` on setPrice. Added
   * to this repo's mocks because the perps `PriceOracleMock` is event-less
   * (it satisfies the venue's `latestRoundData` read path but not the
   * predictor's BTC/USDC event subscription).
   */
  aggregatorEventMock: () => readArtifact(
    "collateral",
    "contracts/mocks/AggregatorEventMock",
    "AggregatorEventMock",
  ),

  // ── perps (sibling repo) ──────────────────────────────────────────────
  perps:           () => readArtifact("perps", "contracts/HashPowerPerpsDEX",        "HashPowerPerpsDEX"),
  priceOracleMock: () => readArtifact("perps", "contracts/mocks/PriceOracleMock",    "PriceOracleMock"),
  /**
   * Multicall3 (shipped by perps for the indexer/keeper). We deploy this on
   * the test node so viem's `multicall` action — which `pme/health.ts` uses
   * for batched reads — has a contract to dispatch through. viem refuses to
   * multicall against a chain whose `contracts.multicall3.address` is unset.
   */
  multicall3:      () => readArtifact("perps", "contracts/Multicall3",               "Multicall3"),

  // ── futures (sibling repo) ────────────────────────────────────────────
  futures: () =>
    readArtifact(
      "futures",
      "contracts/HashPowerFutures",
      "HashPowerFutures",
    ),
} as const;

/** Resolved repo paths — exported for diagnostic logs. */
export const repoRoots = REPO_PATHS;
