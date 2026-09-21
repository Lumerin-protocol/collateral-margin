import { formatEther, formatGwei, type TransactionReceipt } from "viem";
import type { EthUsdFeed } from "../oracle/ethUsdFeed.ts";

/**
 * Flat shape spread into every "tx confirmed" log line so operators can
 * answer "how much did that cost?" without doing wei-math or hopping into
 * a block explorer.
 *
 *   - `gasUsed`        : number (gas units consumed)
 *   - `gasPriceGwei`   : string ("1.234" — EIP-1559 effective price)
 *   - `gasCostEth`     : string ("0.00045" — native cost on Base / mainnet)
 *   - `gasCostUsd`     : number ($0.0023) — present only when an ETH/USD
 *                         feed is wired AND has a price; absent otherwise
 *                         so log search / metric extraction can distinguish
 *                         "feed off" from "feed read zero".
 *
 * All fields are strings or primitives (no `bigint`) because pino's
 * default JSON serializer chokes on bigints — every other tx log in this
 * codebase already speaks the string convention.
 */
export interface GasCostFields {
  gasUsed: number;
  gasPriceGwei: string;
  gasCostEth: string;
  gasCostUsd?: number;
}

/**
 * Compute gas/price log fields from a confirmed tx receipt. `ethUsdFeed`
 * is optional — when omitted, the USD field is dropped silently.
 *
 * Defensive against partial receipts: viem's `TransactionReceipt` types
 * `gasUsed` / `effectiveGasPrice` as non-optional, but RPC providers
 * occasionally return `null` here on freshly-mined txs. We treat
 * missing values as `0n` so we never crash a tx confirmation path on a
 * cosmetic field.
 */
export function formatGasCost(
  receipt: Pick<TransactionReceipt, "gasUsed" | "effectiveGasPrice">,
  ethUsdFeed?: EthUsdFeed,
): GasCostFields {
  const gasUsed = receipt.gasUsed ?? 0n;
  const gasPrice = receipt.effectiveGasPrice ?? 0n;
  const gasCostWei = gasUsed * gasPrice;

  const fields: GasCostFields = {
    gasUsed: Number(gasUsed),
    gasPriceGwei: formatGwei(gasPrice),
    gasCostEth: formatEther(gasCostWei),
  };

  if (ethUsdFeed !== undefined) {
    const usd = ethUsdFeed.weiToUsd(gasCostWei);
    if (usd !== undefined) fields.gasCostUsd = roundUsd(usd);
  }

  return fields;
}

/**
 * Round USD to 6 decimal places so micro-cent precision survives in
 * `pino`'s default JSON output without printing pages of trailing
 * floating-point garbage. Six places resolves down to $0.000001 —
 * enough headroom for sub-cent L2 gas costs.
 */
function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
