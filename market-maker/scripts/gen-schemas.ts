// Emits JSON Schema for each per-app config under schemas/.
//
// The YAML language server (Red Hat YAML extension shipped with VS Code,
// Cursor, and most JetBrains IDEs) reads the `# yaml-language-server:
// $schema=…` comment at the top of each YAML and offers autocompletion,
// hover docs, and validation against the schema.
//
// Run: pnpm gen:schemas
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { perpsRootSchema } from "../src/apps/perps/config.ts";
import { futuresRootSchema } from "../src/apps/futures/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "schemas");
mkdirSync(outDir, { recursive: true });

/**
 * Pattern for ${VAR} or ${VAR:-default} env-interpolation tokens.
 * Editor-time the YAML still has the literal placeholder; the runtime
 * validator only sees the expanded value, so for editor consumption we
 * relax leaf types that wouldn't otherwise accept a `${...}` string.
 */
const ENV_VAR_PATTERN = "^\\$\\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\\}$";
const ENV_VAR_ALT = {
  type: "string",
  pattern: ENV_VAR_PATTERN,
  description: "Environment variable interpolation (resolved at startup)",
} as const;

type AnyObj = Record<string, unknown>;

/**
 * Walks a JSON-Schema tree and rewrites leaf types so editors accept
 * `${VAR}` placeholders alongside the original constraint:
 *   - string with pattern  -> anyOf [original, env-var string]
 *   - boolean/number       -> anyOf [original, env-var string]
 *   - enum/const           -> left alone (these are intentional literals)
 */
function relaxForEnvInterpolation(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(relaxForEnvInterpolation);

  const src = node as AnyObj;
  const out: AnyObj = { ...src };

  for (const k of ["properties", "patternProperties", "definitions", "$defs"] as const) {
    const v = out[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const next: AnyObj = {};
      for (const [pk, pv] of Object.entries(v as AnyObj)) next[pk] = relaxForEnvInterpolation(pv);
      out[k] = next;
    }
  }
  if (out.items !== undefined) out.items = relaxForEnvInterpolation(out.items);
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = relaxForEnvInterpolation(out.additionalProperties);
  }
  for (const k of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(relaxForEnvInterpolation);
  }

  if (out.const !== undefined || out.enum !== undefined) return out;

  const t = out.type;
  const needsRelax =
    (t === "string" && typeof out.pattern === "string") ||
    t === "boolean" ||
    t === "number" ||
    t === "integer";
  if (!needsRelax) return out;

  const original: AnyObj = { ...out };
  for (const k of ["title", "description", "default"]) delete original[k];
  return {
    anyOf: [original, ENV_VAR_ALT],
    ...(out.description !== undefined ? { description: out.description } : {}),
    ...(out.default !== undefined ? { default: out.default } : {}),
  };
}

const targets = [
  { name: "perps", schema: perpsRootSchema, title: "Titan Market Maker - Perps config" },
  { name: "futures", schema: futuresRootSchema, title: "Titan Market Maker - Futures config" },
] as const;

for (const t of targets) {
  const relaxed = relaxForEnvInterpolation(t.schema) as AnyObj;
  const json = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: t.title,
    ...relaxed,
  };
  const path = resolve(outDir, `${t.name}.json`);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  // biome-ignore lint/suspicious/noConsole: this is a CLI script
  console.log(`wrote ${path}`);
}
