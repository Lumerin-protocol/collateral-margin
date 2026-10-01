/** Plumbing with no vault knowledge: GraphQL, CloudWatch, numbers. */
import {
  CloudWatchClient,
  type MetricDatum,
  PutMetricDataCommand,
  type StandardUnit,
} from "@aws-sdk/client-cloudwatch";

export const log = (message: string) => console.log(message);

// ── GraphQL ─────────────────────────────────────────────────────────────────

// Responses are untyped on purpose: the query text is the declaration of the
// shape, and callers convert every field (BigInt, Number, Boolean) on first use.
export async function gql(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: see above
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    // Goldsky's edge rejects the default User-Agent with 403.
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "col-mar-vault-mon",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  // GraphQL reports errors in a 200 body, so they have to be raised by hand.
  const result = await response.json();
  if (result.errors)
    throw new Error(`graphql: ${JSON.stringify(result.errors)}`);
  return result.data;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

export const toUnits = (raw: bigint, decimals: number) =>
  Number(raw) / 10 ** decimals;

export const isUnset = (address: string | undefined) =>
  !address || /^0x0*$/.test(address);

export function utilizationPct(debt: bigint, cap: bigint): number {
  // A zero cap with outstanding debt is already past every threshold.
  if (cap <= 0n) return debt <= 0n ? 0 : 1000;
  return (Number(debt) / Number(cap)) * 100;
}

// ── CloudWatch ──────────────────────────────────────────────────────────────

const cloudwatch = new CloudWatchClient({});

/** PutMetricData accepts at most 20 datums per call. */
const METRIC_BATCH_SIZE = 20;

export const dim = (name: string, value: string | number | bigint) => [
  { Name: name, Value: String(value) },
];

export function metric(
  name: string,
  value: number | bigint,
  unit: StandardUnit = "None",
  dimensions?: MetricDatum["Dimensions"],
): MetricDatum {
  const datum: MetricDatum = {
    MetricName: name,
    Value: Number(value),
    Unit: unit,
  };
  if (dimensions) datum.Dimensions = dimensions;
  return datum;
}

export async function push(
  namespace: string,
  points: MetricDatum[],
): Promise<void> {
  for (let start = 0; start < points.length; start += METRIC_BATCH_SIZE) {
    const batch = points.slice(start, start + METRIC_BATCH_SIZE);
    await cloudwatch.send(
      new PutMetricDataCommand({ Namespace: namespace, MetricData: batch }),
    );
    log(`pushed ${batch.length} metrics`);
  }
}

export async function publishFailure(namespace: string): Promise<void> {
  try {
    await push(namespace, [metric("CheckSuccess", 0, "Count")]);
  } catch (error) {
    log(`failed to publish CheckSuccess=0: ${error}`);
  }
}
