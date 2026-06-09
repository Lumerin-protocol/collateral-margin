#!/usr/bin/env node
/**
 * Postinstall patch for matchstick-ts.
 *
 * Upstream (lsheva/matchstick-ts) doesn't yet handle Solidity tuple/struct
 * event params end-to-end:
 *   - `event-capture.js#serializeParams` did `JSON.stringify(value)` on object
 *     fields, which throws when the struct contains a `bigint` (every uint256).
 *   - `assembly/index.ts#jsonValueToEthereumValue` only handled scalar JSON
 *     kinds, falling back to `Value.fromString(value.toString())` for arrays.
 *     The AS-generated event class then called `.toTuple()` on the wrapper
 *     and aborted with "Ethereum value is not a tuple".
 *
 * The points contracts only emit scalar event params today, but we keep the
 * patch for parity with the futures indexer so struct events added later index
 * correctly. Until upstream lands the fix, this script rewrites both sides of
 * the matchstick-ts wire format to encode tuples as JSON arrays.
 *
 * Runs after `pnpm install`; idempotent.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PNPM_STORE = join(ROOT, "node_modules", ".pnpm");

if (!existsSync(PNPM_STORE)) {
  process.exit(0);
}

const matchstickDirs = readdirSync(PNPM_STORE).filter((d) =>
  d.startsWith("matchstick-ts@"),
);

let patched = 0;
for (const dir of matchstickDirs) {
  const base = join(PNPM_STORE, dir, "node_modules", "matchstick-ts");

  // --- JS-side: dist/event-capture.js (already-built artifact) ---
  const jsPath = join(base, "dist", "event-capture.js");
  if (existsSync(jsPath)) {
    let src = readFileSync(jsPath, "utf8");
    if (!src.includes("encodeTupleOrArray")) {
      src = src.replace(
        /        else if \(typeof value === "object" && value !== null\) \{\s*\n\s*result\.push\(\[key, JSON\.stringify\(value\)\]\);\s*\n\s*\}/,
        `        else if (typeof value === "object" && value !== null) {
            result.push([key, encodeTupleOrArray(value)]);
        }`,
      );
      src = src.replace(
        /\/\*\* Internal — shared by \{@link EventCapture\} and the log-sync ingester\. \*\/\nexport function serializeParams\(args\) \{/,
        `function encodeTupleOrArray(v) {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(encodeTupleOrArray);
    if (v !== null && typeof v === "object") return Object.values(v).map(encodeTupleOrArray);
    return v;
}
/** Internal — shared by {@link EventCapture} and the log-sync ingester. */
export function serializeParams(args) {`,
      );
      writeFileSync(jsPath, src);
      patched++;
    }
  }

  // --- AS-side: assembly/index.ts (recompiled by matchstick on every run) ---
  const asPath = join(base, "assembly", "index.ts");
  if (existsSync(asPath)) {
    let src = readFileSync(asPath, "utf8");
    if (!src.includes("JSONValueKind.ARRAY")) {
      src = src.replace(
        /  if \(value\.kind == JSONValueKind\.BOOL\) \{\s*\n\s*return ethereum\.Value\.fromBoolean\(value\.toBool\(\)\);\s*\n\s*\}\s*\n\s*\/\/ Arrays\/objects fall back to string representation\.\s*\n\s*return ethereum\.Value\.fromString\(value\.toString\(\)\);/,
        `  if (value.kind == JSONValueKind.BOOL) {
    return ethereum.Value.fromBoolean(value.toBool());
  }
  if (value.kind == JSONValueKind.ARRAY) {
    // Treated as a Solidity tuple (struct). The TS-side serializer encodes
    // both tuples and dynamic arrays as JSON arrays — the AS-generated event
    // class then calls .toTuple() on the wrapper to get the struct back.
    const arr = value.toArray();
    const tuple = new ethereum.Tuple();
    for (let i = 0; i < arr.length; i++) {
      tuple.push(jsonValueToEthereumValue(arr[i]));
    }
    return ethereum.Value.fromTuple(tuple);
  }
  return ethereum.Value.fromString(value.toString());`,
      );
      writeFileSync(asPath, src);
      patched++;
    }
  }
}

if (patched > 0) {
  console.log(`patched matchstick-ts: ${patched} file(s) (tuple/bigint event params)`);
}
