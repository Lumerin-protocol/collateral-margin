import type { ErrorInfo } from "./errors.ts";

/**
 * viem errors nest 4-5 cause levels deep, and every level re-stringifies the
 * full multicall calldata into its `message`, `stack`, and `metaMessages`.
 * Naively serializing with `pino.stdSerializers.errWithCause` produces tens
 * of KB of duplicated hex per failed call.
 *
 * This serializer instead walks the cause chain once and emits a flat,
 * minimal payload: `name`, `message` (preferring viem's `shortMessage`), the
 * decoded custom error (`errorName`, e.g. `"FailedCall"`), a trimmed `data`
 * hex selector/blob, and a single frames-only `stack` from the top error.
 * The cause chain is harvested for `errorName`/`data` but not emitted —
 * viem's cause levels are just re-wrappings of the same revert.
 */

const MAX_DATA_LEN = 200;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function* walkCauses(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (isObj(cur) && !seen.has(cur)) {
    seen.add(cur);
    yield cur;
    cur = (cur as Record<string, unknown>).cause;
  }
}

function pickString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

function shortMessageOf(lvl: Record<string, unknown>): string | undefined {
  const sm = pickString(lvl, "shortMessage");
  if (sm) return sm;
  const m = pickString(lvl, "message");
  return m === undefined ? undefined : firstLine(m);
}

function stackFrames(stack: unknown): string {
  if (typeof stack !== "string") return "";
  return stack
    .split("\n")
    .filter((l) => /^\s*at /.test(l))
    .join("\n");
}

function trimHex(s: string): string {
  return s.length <= MAX_DATA_LEN ? s : `${s.slice(0, MAX_DATA_LEN)}…<+${s.length - MAX_DATA_LEN} chars>`;
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err === null || typeof err !== "object" || !(err instanceof Error)) {
    return { raw: err };
  }

  const chain = [...walkCauses(err)];
  const top = chain[0] ?? {};

  let errorName: string | undefined;
  let data: string | undefined;
  for (const lvl of chain) {
    if (errorName === undefined && isObj(lvl.data)) {
      errorName = pickString(lvl.data as Record<string, unknown>, "errorName");
    }
    if (data === undefined && typeof lvl.data === "string") {
      data = trimHex(lvl.data);
    }
    if (errorName !== undefined && data !== undefined) break;
  }

  let stack = "";
  for (const lvl of chain) {
    stack = stackFrames(lvl.stack);
    if (stack) break;
  }

  const name = pickString(top, "name") ?? err.name ?? "Error";
  const message = shortMessageOf(top) ?? "(no message)";

  const out: Record<string, unknown> = { name, message };
  if (errorName) out.errorName = errorName;
  if (data !== undefined) out.data = data;
  if (stack) out.stack = stack;
  for (const k of ["contractAddress", "functionName", "sender", "tenderlyUrl"] as const) {
    const v = pickString(top, k);
    if (v) out[k] = v;
  }
  return out;
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  return serializeError(err) as unknown as ErrorInfo;
}
