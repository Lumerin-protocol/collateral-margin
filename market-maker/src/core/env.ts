import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load `.env` files at startup, in priority order:
 *
 *   1. market-maker/.env       (closest to the app, wins)
 *   2. collateral-margin/.env  (shared between contracts/indexer/mm)
 *
 * Existing `process.env` values always take precedence over file contents
 * (Node's documented behaviour for `process.loadEnvFile`), so CI/docker
 * runtime env still wins.
 *
 * Missing files are silently skipped — `.env` is a dev convenience only.
 *
 * The market-maker root is two directories above `src/`. The
 * collateral-margin root is three directories above `src/`. We resolve
 * from `import.meta.dirname` of the caller (passed in) so the paths
 * work regardless of cwd.
 */
export function loadDotenvFiles(callerDir: string): void {
  // src/apps/<app> → src/apps → src → market-maker → collateral-margin
  const marketMakerRoot = resolve(callerDir, "..", "..", "..");
  const repoRoot = resolve(marketMakerRoot, "..");

  for (const path of [
    resolve(marketMakerRoot, ".env"),
    resolve(repoRoot, ".env"),
  ]) {
    if (existsSync(path)) {
      try {
        process.loadEnvFile(path);
      } catch {
        // ignore parse errors — runtime config validation will catch
        // truly missing values.
      }
    }
  }
}
