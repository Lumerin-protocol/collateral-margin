import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadFuturesConfig } from "../../../src/apps/futures/config.ts";

/**
 * Smoke test for the bundled futures configs. Catches drift between the
 * schema and the per-env YAMLs shipped under configs/{dev,stg,prd}/futures.yml.
 */
describe("futures app config smoke", () => {
  const envs = ["local", "dev", "stg", "prd"] as const;

  for (const e of envs) {
    it(`loads configs/futures.${e}.yml with stub env`, () => {
      const path = resolve(import.meta.dirname, `../../../configs/futures.${e}.yml`);
      const env: NodeJS.ProcessEnv = {
        PRIVATE_KEY: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        ALCHEMY_API_KEY: "stub-alchemy-key",
        FUTURES_ADDRESS: "0x1234567890123456789012345678901234567890",
        HASHPRICE_ORACLE_SUBGRAPH_URL: "https://stub.example/subgraph",
      };
      const cfg = loadFuturesConfig({ path, env });
      assert.equal(cfg.venue.kind, "futures");
      assert.equal(cfg.pricing.strategy, "reservation-price");
      assert.equal(cfg.sizing.strategy, "geometric-taper");
      assert.ok(cfg.sizing.taperRatio > 0 && cfg.sizing.taperRatio < 1);
    });
  }
});
