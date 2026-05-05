// Decimal-string parsers for human-friendly config values.
//
// All parsing happens via integer string manipulation, never floating
// point, so values like "0.000001" survive without precision loss. The
// schemas accept `string | number`; numbers are stringified first via
// the canonical decimal form and then parsed exactly.

import { ConfigError } from "../errors.ts";

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const SECONDS_RE = /^\d+(\.\d+)?$/;

function toDecimalString(input: unknown, field: string): string {
  if (typeof input === "string") return input.trim();
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new ConfigError(`${field}: non-finite number`);
    }
    // toString avoids exponent notation for typical magnitudes; for very
    // small/large floats users should pass a string anyway.
    const str = input.toString();
    if (str.includes("e") || str.includes("E")) {
      throw new ConfigError(
        `${field}: numeric literal "${str}" uses exponent notation; pass as a string instead`,
      );
    }
    return str;
  }
  throw new ConfigError(`${field}: expected string or number, got ${typeof input}`);
}

/**
 * Parse a USD-denominated decimal value into a bigint with the given
 * `decimals` (6 for USDC). "50" → 50_000_000n, "0.5" → 500_000n, "50.123456"
 * → 50_123_456n. More than `decimals` fractional digits is rejected so the
 * caller can't silently round away precision.
 */
export function parseUsd(input: unknown, decimals: number, field: string): bigint {
  const str = toDecimalString(input, field);
  if (!DECIMAL_RE.test(str)) {
    throw new ConfigError(`${field}: invalid decimal "${str}"`);
  }
  const negative = str.startsWith("-");
  const body = negative ? str.slice(1) : str;
  const [intPart, fracPart = ""] = body.split(".");
  if (fracPart.length > decimals) {
    throw new ConfigError(
      `${field}: too many fractional digits (max ${decimals}) in "${str}"`,
    );
  }
  const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const result = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(padded);
  return negative ? -result : result;
}

/**
 * Convert a non-negative seconds value (string or number, decimals allowed)
 * into integer milliseconds. "3" → 3000, "0.5" → 500, "0.001" → 1. More than
 * 3 fractional digits (sub-millisecond) is rejected.
 */
export function secondsToMs(input: unknown, field: string): number {
  const str = toDecimalString(input, field);
  if (!SECONDS_RE.test(str)) {
    throw new ConfigError(`${field}: invalid non-negative seconds "${str}"`);
  }
  const [intPart, fracPart = ""] = str.split(".");
  if (fracPart.length > 3) {
    throw new ConfigError(`${field}: sub-millisecond precision not supported in "${str}"`);
  }
  const padded = (fracPart + "000").slice(0, 3);
  return Number(intPart) * 1000 + Number(padded);
}
