/**
 * Local entrypoint. Runs one collect() pass against the configured subgraph and
 * RPC, then prints the metrics to the console. Nothing is published to
 * CloudWatch and no AWS client is exercised.
 *
 *   pnpm dev      # config/dev.env + root .env
 *   pnpm prd      # config/prd.env + root .env
 */
import { collect } from "./index.ts";
import { log } from "./lib.ts";

try {
  const { points, summary } = await collect();
  log(`ok ${summary}`);

  const rows = points.map((point) => {
    const dims = (point.Dimensions ?? [])
      .map((dimension) => `${dimension.Name}=${dimension.Value}`)
      .join(",");
    return [
      `${point.MetricName}${dims ? `{${dims}}` : ""}`,
      String(point.Value),
    ] as const;
  });

  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, value] of rows) {
    log(`${name.padEnd(width)}  ${value}`);
  }

} catch (error) {
  log(`check failed: ${error}`);
  process.exit(1);
}
