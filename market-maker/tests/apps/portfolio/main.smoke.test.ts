import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadPortfolioConfig } from "../../../src/apps/portfolio/config.ts";

/**
 * Smoke test for the bundled portfolio configs. Catches drift between the
 * schema and the per-env YAMLs shipped under configs/portfolio.<env>.yml.
 */
describe("portfolio app config smoke", () => {
  const envs = ["local", "dev", "prd"] as const;

  for (const e of envs) {
    it(`loads configs/portfolio.${e}.yml with stub env`, () => {
      const path = resolve(import.meta.dirname, `../../../configs/portfolio.${e}.yml`);
      const env: NodeJS.ProcessEnv = {
        PRIVATE_KEY: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        ALCHEMY_API_KEY: "stub-alchemy-key",
        PERPS_ADDRESS: "0x1234567890123456789012345678901234567890",
        FUTURES_ADDRESS: "0x2345678901234567890123456789012345678901",
        HASHPRICE_ORACLE_SUBGRAPH_URL: "https://stub.example/subgraph",
      };
      const cfg = loadPortfolioConfig({ path, env });

      const perps = cfg.venues.find((v) => v.kind === "perps");
      const futures = cfg.venues.find((v) => v.kind === "futures");
      assert.ok(perps, "expected a perps venue");
      assert.ok(futures, "expected a futures venue");
      assert.equal(perps.pricing.strategy, "effective-spread");
      assert.equal(futures.pricing.strategy, "reservation-price");

      for (const venue of cfg.venues) {
        assert.equal(venue.sizing.strategy, "geometric-taper");
        assert.ok(venue.sizing.taperRatio > 0 && venue.sizing.taperRatio < 1);
      }
      assert.ok(cfg.timing.levelSpacingTicks >= 1);
    });
  }
});
