/**
 * Human-readable formatting helpers for /health (ops-facing).
 * Machine-readable raw base units stay on /health/raw.
 */

import { formatUsd } from "./config/units.ts";

/** `1500000000n` → `"1500 USDC"`. */
export function formatUsdcAmount(amount: bigint): string {
  return `${formatUsd(amount)} USDC`;
}

/** Wei → `"0.483 ETH"` (trim trailing zeros). */
export function formatEthAmount(wei: bigint): string {
  return `${formatUsd(wei, 18)} ETH`;
}

/** Price in token decimals (usually 6) → `"32.7976"`. */
export function formatPrice(price: bigint, decimals: number = 6): string {
  return formatUsd(price, decimals);
}

/** Seconds → `"44m 35s"`, `"1h 2m"`, `"3s"`. */
export function formatDurationSec(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return "0s";
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/** Epoch ms → ISO-8601, or `"never"` when unset. */
export function formatTimestampMs(ms: number): string {
  if (!ms || ms <= 0) return "never";
  return new Date(ms).toISOString();
}

/** Relative age from `nowMs`. */
export function formatAgeMs(thenMs: number, nowMs: number = Date.now()): string {
  if (!thenMs || thenMs <= 0) return "never";
  const ageSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  return `${formatDurationSec(ageSec)} ago`;
}
