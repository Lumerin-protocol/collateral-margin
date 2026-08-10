import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";

/**
 * Spawn a Hardhat node from `collateral-margin/contracts/`, the only package
 * in this repo that already has Hardhat 3 + viem wired up. The keeper-specific
 * config disables the contract-size limit for sibling implementation artifacts
 * without changing any production network configuration.
 *
 * We deliberately do NOT spin up Hardhat in `keeper/` itself: the sibling
 * perps and futures repos each have a deep Solidity dep tree (OZ, OZ
 * upgradeable, chainlink, solidity-linked-list, `hardhat/console.sol`) that
 * resolves correctly only inside those repos' own `node_modules/`. Forcing
 * keeper to compile their `.sol` files would mean replicating their entire
 * compile-time dep graph here. Instead, `pretest:integration` runs the
 * sibling repos' own `pnpm hardhat compile` invocations and we just read the
 * resulting artifact JSON via filesystem paths.
 */
export interface HardhatNode {
  process: ChildProcess;
  rpcUrl: string;
  stop(): Promise<void>;
}

const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

export interface StartHardhatNodeOptions {
  /**
   * Absolute path to the directory whose Hardhat installation should run
   * the integration config. Defaults to the workspace's
   * `collateral-margin/contracts/` (`../../contracts` relative to this file).
   */
  hardhatProjectDir?: string;
  rpcUrl?: string;
  readyTimeoutMs?: number;
  /**
   * Forward node stdout/stderr to the parent process. Disabled by default
   * because Hardhat's banner is noisy and would interleave with `node --test`
   * output. Tests can opt in for debugging.
   */
  verbose?: boolean;
}

/**
 * Spawn a fresh hardhat node and resolve once it responds to `eth_chainId`.
 * The returned `stop()` kills the entire process group so child Hardhat
 * tasks don't outlive the test run.
 */
export async function startHardhatNode(
  options: StartHardhatNodeOptions = {},
): Promise<HardhatNode> {
  const cwd = options.hardhatProjectDir ?? resolve(import.meta.dirname, "../../../contracts");
  const config = resolve(import.meta.dirname, "hardhat.config.ts");
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;

  const proc = spawn(
    "pnpm",
    ["exec", "hardhat", "--config", config, "--network", "hardhat", "node"],
    {
      cwd,
      // `detached: true` puts the child in its own process group so we can
      // kill the whole tree on shutdown — Hardhat spawns helpers (the EDR
      // worker, the JSON-RPC server) that would otherwise outlive SIGTERM.
      detached: true,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: [
        "ignore",
        options.verbose ? "inherit" : "ignore",
        options.verbose ? "inherit" : "pipe",
      ],
    },
  );

  // Even when stderr is piped silently we still want to surface crashes:
  // attach a one-shot handler that captures the first ~256 chars so the
  // ready-timeout error can include them.
  let earlyStderr = "";
  if (!options.verbose) {
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      if (earlyStderr.length < 256) earlyStderr += chunk;
    });
  }

  // If hardhat dies before we see `eth_chainId` respond, surface that error
  // rather than letting the caller wait the full ready timeout.
  let exited = false;
  let exitCode: number | null = null;
  proc.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const pc = createPublicClient({ transport: http(rpcUrl, { timeout: 2_000, retryCount: 0 }) });

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `hardhat node exited with code ${exitCode} before becoming ready` +
          (earlyStderr ? `\nstderr: ${earlyStderr.trim()}` : ""),
      );
    }
    try {
      await pc.getChainId();
      return {
        process: proc,
        rpcUrl,
        stop: () => stopProcess(proc),
      };
    } catch {
      // Not ready yet — back off.
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await stopProcess(proc);
  throw new Error(
    `hardhat node did not respond to eth_chainId within ${readyTimeoutMs}ms` +
      (earlyStderr ? `\nstderr: ${earlyStderr.trim()}` : ""),
  );
}

function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once("close", () => resolve());
    try {
      // Negative PID == process group. `detached: true` made us the leader.
      process.kill(-proc.pid!, "SIGTERM");
    } catch (err) {
      // Already dead, race with `once("close")`.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      resolve();
    }
    // Hard kill after 5s if SIGTERM didn't take.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 5_000).unref();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
