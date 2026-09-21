/**
 * Builds a Tenderly "new simulation" URL that pre-fills the failed call so a
 * dev can replay/debug it with one click. We attach this to write-call errors
 * at the venue layer (see `FuturesVenueAdapter.multicall`) so the serialized
 * error in logs includes a `tenderlyUrl` field.
 *
 * Supported query params on `dashboard.tenderly.co/simulator/new`:
 *   network            — chain ID
 *   contractAddress    — `to`
 *   from               — `from`
 *   rawFunctionInput   — full calldata
 *   value              — wei (optional, omitted when zero)
 *   gas                — gas limit (optional)
 */
export interface TenderlySimulationInput {
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  gas?: bigint;
}

const TENDERLY_BASE = "https://dashboard.tenderly.co/simulator/new";

export function buildTenderlySimulationUrl(input: TenderlySimulationInput): string {
  const params = new URLSearchParams({
    network: String(input.chainId),
    contractAddress: input.to,
    from: input.from,
    rawFunctionInput: input.data,
  });
  if (input.value !== undefined && input.value !== 0n) {
    params.set("value", input.value.toString());
  }
  if (input.gas !== undefined) {
    params.set("gas", input.gas.toString());
  }
  return `${TENDERLY_BASE}?${params.toString()}`;
}

/**
 * Attaches `tenderlyUrl` to an error (mutating it) so the standard error
 * serializer surfaces it in logs and `/health`. Returns the same error for
 * convenient `throw attachTenderlyUrl(err, ...)` usage.
 */
export function attachTenderlyUrl(err: unknown, input: TenderlySimulationInput): unknown {
  if (err !== null && typeof err === "object") {
    (err as Record<string, unknown>).tenderlyUrl = buildTenderlySimulationUrl(input);
  }
  return err;
}
