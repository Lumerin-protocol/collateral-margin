#!/usr/bin/env node
/**
 * `pretest:integration` hook.
 *
 * Runs `pnpm hardhat compile` in each sibling repo whose Solidity sources
 * the keeper integration test needs to deploy:
 *
 *   - collateral-margin/contracts       (this repo, hosts the test fixtures)
 *   - perps/contracts                   (HashPowerPerpsDEX)
 *   - futures-marketplace/contracts     (Futures)
 *
 * Each sibling has its own Solidity dep graph (OZ, OZ-upgradeable,
 * chainlink, solidity-linked-list, `hardhat/console.sol`, the
 * `collateral-margin` workspace dep that futures pulls in). Trying to
 * compile those .sol files from the keeper would mean replicating each
 * sibling's full dep tree here. Instead we shell out to each sibling's
 * existing Hardhat setup — they already know how to resolve their own
 * imports — and the keeper just reads the resulting artifact JSON.
 *
 * Path resolution mirrors `tests/integration/artifacts.ts`:
 *   PERPS_REPO   – defaults to ../../perps
 *   FUTURES_REPO – defaults to ../../futures-marketplace
 *
 * Compilation is skipped when `SKIP_COMPILE_SIBLINGS=1` (used in CI when
 * the artifacts have already been built upstream and committed).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.SKIP_COMPILE_SIBLINGS === "1") {
  console.log("[compile-siblings] SKIP_COMPILE_SIBLINGS=1, skipping");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..", "..", "..");

const targets = [
  { name: "collateral-margin", dir: resolve(here, "..", "..", "contracts") },
  { name: "perps", dir: process.env.PERPS_REPO ?? resolve(workspaceRoot, "perps", "contracts") },
  {
    name: "futures-marketplace",
    dir: process.env.FUTURES_REPO ?? resolve(workspaceRoot, "futures-marketplace", "contracts"),
  },
];

for (const target of targets) {
  if (!existsSync(target.dir)) {
    console.error(
      `[compile-siblings] ${target.name} not found at ${target.dir}.\n` +
        `Override the path via PERPS_REPO / FUTURES_REPO if your checkout layout differs.`,
    );
    process.exit(1);
  }

  console.log(`[compile-siblings] ${target.name}: pnpm hardhat compile (${target.dir})`);
  const result = spawnSync("pnpm", ["hardhat", "compile"], {
    cwd: target.dir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`[compile-siblings] ${target.name} compile failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
