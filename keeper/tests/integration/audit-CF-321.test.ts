import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createTestClient,
  http,
  publicActions,
  walletActions,
  type TestClient,
} from "viem";
import { hardhat } from "viem/chains";
import { imRequired, mmRequired } from "@hashpower/portfolio-margin";
import {
  readAccountSnapshot,
  readMMParams,
} from "../../src/predict/snapshot.ts";
import { startHardhatNode, type HardhatNode } from "./nodeProcess.ts";
import { loadFixture } from "./loadFixture.ts";
import { buildKeeper } from "./buildKeeper.ts";
import { readAccountMargins } from "./helpers.ts";
import { halvingMarksFixtureBuilder } from "./scenarios.ts";

/**
 * CF-321: once perps marks at the glide and futures at each date's mark range, the engine
 * stresses every venue's exposure at its own mark. The keeper predicts liquidations from one
 * snapshot, so its replica must give the engine's IM and MM there too.
 */

let node: HardhatNode;
let testClient: TestClient;
let halvingMarksFixture: ReturnType<typeof halvingMarksFixtureBuilder>;

before(
  async () => {
    node = await startHardhatNode();
    testClient = createTestClient({
      chain: hardhat,
      mode: "hardhat",
      transport: http(node.rpcUrl),
    })
      .extend(publicActions)
      .extend(walletActions);
    halvingMarksFixture = halvingMarksFixtureBuilder(node.rpcUrl);
  },
  { timeout: 60_000 },
);

after(async () => {
  await node?.stop();
});

describe("CF-321 — the keeper's replica values each venue and expiry at its own mark", () => {
  it("replicates the engine's IM and MM with perps on the glide and a post-halving futures date", {
    timeout: 120_000,
  }, async () => {
    const ctx = await loadFixture(halvingMarksFixture, testClient);
    assert.ok(
      ctx.perpsMark * 100n < ctx.index * 80n,
      "perps mark is well down the glide",
    );
    assert.ok(
      ctx.futuresHigh * 100n < ctx.index * 60n,
      "the futures date marks post-halving",
    );

    const keeper = buildKeeper(ctx);
    const user = ctx.accounts.alice.account.address;
    const params = await readMMParams(keeper.chain, keeper.config);
    const snapshot = await readAccountSnapshot(
      keeper.chain,
      keeper.config,
      user,
    );
    const engine = await readAccountMargins(ctx, user);

    assert.equal(
      imRequired(snapshot, params, ctx.index),
      engine.imRequired,
      "IM",
    );
    assert.equal(
      mmRequired(snapshot, params, ctx.index),
      engine.mmRequired,
      "MM",
    );
  });
});
