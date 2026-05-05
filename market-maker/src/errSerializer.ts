import pino from "pino";
import type { ErrorInfo } from "./errors.ts";

function stripAbiRecursive<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripAbiRecursive(item)) as T;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key === "abi") continue;
    out[key] = stripAbiRecursive(obj[key]);
  }
  return out as T;
}

/**
 * Serializes an error for logs and API: errWithCause (includes cause) then
 * strips `abi` recursively at every depth. Pino redact cannot match arbitrary
 * depth (each `*` is one level only), so we strip in the serializer instead.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err === null || typeof err !== "object" || !(err instanceof Error)) {
    return { raw: err };
  }
  const serialized = pino.stdSerializers.errWithCause(err) as Record<string, unknown>;
  return stripAbiRecursive(serialized) as Record<string, unknown>;
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  return serializeError(err) as unknown as ErrorInfo;
}
