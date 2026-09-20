import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { ConfigHooks } from "hardhat/types/hooks";
import "./type-extensions.ts";

/**
 * The npm package holding this plugin, which is also the Hardhat project root.
 * Resolved from this file so that every path is independent of the cwd.
 */
function findProjectRoot(): string {
  let dir = import.meta.dirname;
  while (!existsSync(resolve(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("env-loader: no package.json above the plugin");
    dir = parent;
  }
  return dir;
}

/** Every `<name>.env` file in `configDir`, by name. */
function availableEnvs(configDir: string): string[] {
  try {
    return readdirSync(configDir)
      .filter((file) => file.endsWith(".env"))
      .map((file) => file.slice(0, -".env".length))
      .sort();
  } catch {
    return [];
  }
}

/** Reads the env name from a `--env <name>` or `--env=<name>` argument. */
function readEnvFlag(argv: string[], configDir: string): string | undefined {
  const index = argv.findIndex(
    (arg) => arg === "--env" || arg.startsWith("--env="),
  );
  if (index === -1) return undefined;
  const arg = argv[index];
  const name = arg.startsWith("--env=")
    ? arg.slice("--env=".length)
    : argv[index + 1];
  const known = availableEnvs(configDir);
  if (name === undefined || !known.includes(name))
    throw new Error(
      `--env must name a file in ${configDir}, one of ${known.join(", ") || "(none found)"}, got ${name ?? "nothing"}`,
    );
  return name;
}

/**
 * Loads the env files for the environment named by `--env`, and selects that
 * environment's network so scripts cannot be pointed at the wrong chain by
 * accident.
 *
 * `loadEnvFile` never overwrites a variable that is already set, so files are
 * read most-specific first: `overrideEnvFiles` (machine/secret), then the
 * named env file. The real process environment always wins.
 */
export function loadEnv(
  configDir: string,
  overrideEnvFiles: string[],
  projectRoot: string,
  argv = process.argv,
): void {
  for (const file of overrideEnvFiles) {
    tryLoadEnvFile(resolve(projectRoot, file));
  }
  const name = readEnvFlag(argv, configDir);
  if (name !== undefined) tryLoadEnvFile(resolve(configDir, `${name}.env`));
  if (name === undefined) return;

  const network = process.env.NETWORK;
  if (!network) throw new Error(`${name}.env must set NETWORK`);
  // An explicit `--network` still wins: Hardhat prefers CLI args over env vars.
  process.env.HARDHAT_NETWORK ??= network;
}

export default async (): Promise<Partial<ConfigHooks>> => ({
  // This is the earliest hook Hardhat runs, and crucially it runs before
  // global options are resolved, so `HARDHAT_NETWORK` is still read from here.
  async extendUserConfig(config, next) {
    // The config file is loaded untypechecked, so this is worth stating plainly.
    const { configDir, overrideEnvFiles } = config.envLoader ?? {};
    if (typeof configDir !== "string")
      throw new Error("envLoader.configDir is required and must be a string");
    if (
      !Array.isArray(overrideEnvFiles) ||
      !overrideEnvFiles.every((p) => typeof p === "string")
    )
      throw new Error(
        "envLoader.overrideEnvFiles is required and must be an array of strings",
      );

    const projectRoot = findProjectRoot();
    loadEnv(resolve(projectRoot, configDir), overrideEnvFiles, projectRoot);
    return next(config);
  },
});

export function tryLoadEnvFile(path: string): void {
  try {
    loadEnvFile(path);
    console.info(`Loaded env file ${path}`);
  } catch (err: unknown) {
    console.info(`Env file ${path} not loaded: ${(err as Error).message}`);
  }
}
