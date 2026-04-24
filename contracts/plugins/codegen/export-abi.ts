/**
 * 1. Emits `abi/<Contract>.ts` with `export const <Contract>Abi = … as const` and
 *    `abi/<Contract>.json` with the raw ABI array from Hardhat artifacts.
 * 2. Collects unique Solidity `error` ABI items (+ `Error` / `Panic` builtins) into
 *    `abi/ContractErrors.json` and `abi/ContractErrors.ts`.
 *
 * Replaces hardhat-abi-exporter for Hardhat v3.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";
import { toFunctionSelector } from "viem";
import { formatAbiItem } from "viem/utils";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const ARTIFACTS_DIR = resolve(REPO_ROOT, "artifacts");
const OUT_DIR = resolve(REPO_ROOT, "abi");
const OUT_ERRORS_TS = join(OUT_DIR, "ContractErrors.ts");
const OUT_ERRORS_JSON = join(OUT_DIR, "ContractErrors.json");

function main(contracts?: string[]): void {
  // Clear abi directory
  rmSync(OUT_DIR, { recursive: true, force: true });

  const bucket = new Map<string, Accum>();

  function add(err: AbiError, file: string): void {
    const abi = toJsonAbiError(err);
    const signature = formatAbiItem(abi);
    const cur = bucket.get(signature);
    if (!cur) {
      bucket.set(signature, {
        selector: errorSelector(abi),
        signature,
        abi,
        files: [file],
      });
      return;
    }
    if (!cur.files.includes(file)) {
      cur.files.push(file);
    }
  }

  for (const builtin of BUILTIN) {
    add(builtin, "(builtin)");
  }

  mkdirSync(OUT_DIR, { recursive: true });

  for (const rel of listContractArtifactJson(contracts)) {
    const src = resolve(ARTIFACTS_DIR, rel);
    const name = basename(rel, ".json");
    if (!name) {
      console.warn(`  skipped ${rel} (no name)`);
      continue;
    }
    try {
      const raw = readFileSync(src, "utf-8");
      const artifact = JSON.parse(raw) as { abi?: unknown };
      if (!Array.isArray(artifact.abi)) {
        console.warn(`  skipped ${name} (no contract ABI)`);
        continue;
      }

      const abi = artifact.abi as Abi;
      const outName = `${name}.ts`;
      const dest = resolve(OUT_DIR, outName);
      writeFileSync(
        dest,
        `export const ${name}Abi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`,
      );
      writeFileSync(resolve(OUT_DIR, `${name}.json`), JSON.stringify(artifact.abi, null, 2) + "\n");
      console.log(`  exported ${name}`);

      for (const item of abi) {
        if (item.type !== "error") {
          continue;
        }
        add(item as AbiError, outName);
      }
    } catch {
      console.warn(`  skipped ${name} (read/parse failed)`);
    }
  }

  const rows = [...bucket.values()].sort((a, b) => a.selector.localeCompare(b.selector));
  const outAbi = rows.map((r) => r.abi);

  writeFileSync(
    OUT_ERRORS_TS,
    `export const contractErrors = ${JSON.stringify(outAbi, null, 2)} as const;\n`,
    "utf-8",
  );
  writeFileSync(OUT_ERRORS_JSON, JSON.stringify(outAbi, null, 2) + "\n", "utf-8");

  console.log(`contract errors: ${rows.length} unique → ${relative(REPO_ROOT, OUT_ERRORS_TS)}`);
  console.log("");
  for (const r of rows) {
    console.log(`${r.signature} - ${r.selector}`);
  }
}

/** All .json under artifacts except build-info, optionally filtered by contract name patterns. */
function listContractArtifactJson(contracts?: string[]): string[] {
  const relativePaths = readdirSync(ARTIFACTS_DIR, { recursive: true }) as string[];
  return relativePaths.filter((rel) => {
    if (!rel.endsWith(".json") || rel.split(/[/\\]/).includes("build-info")) return false;
    if (!contracts) return true;
    const name = basename(rel, ".json");
    return contracts.some((pattern) =>
      pattern.includes("*")
        ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(name)
        : name === pattern,
    );
  });
}

type AbiError = {
  inputs: { internalType: string; name: string; type: string }[];
  name: string;
  type: "error";
};

const BUILTIN: AbiError[] = [
  {
    inputs: [{ internalType: "string", name: "message", type: "string" }],
    name: "Error",
    type: "error",
  },
  {
    inputs: [{ internalType: "uint256", name: "code", type: "uint256" }],
    name: "Panic",
    type: "error",
  },
];

function errorSelector(item: AbiError): `0x${string}` {
  return toFunctionSelector({
    type: "function",
    name: item.name,
    inputs: item.inputs,
    outputs: [],
    stateMutability: "nonpayable",
  });
}

function toJsonAbiError(item: AbiError): AbiError {
  return JSON.parse(JSON.stringify(item)) as AbiError;
}

type Accum = {
  selector: `0x${string}`;
  signature: string;
  abi: AbiError;
  files: string[];
};

export { main };
