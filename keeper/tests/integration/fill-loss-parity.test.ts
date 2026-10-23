import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestClient, http, publicActions, walletActions, type TestClient } from "viem";
import { hardhat } from "viem/chains";
import { imRequired, mmRequired } from "@hashpower/portfolio-margin";
import { readAccountSnapshot, readMMParams } from "../../src/predict/snapshot.ts";
import { startHardhatNode, type HardhatNode } from "./nodeProcess.ts";
import { loadFixture } from "./loadFixture.ts";
import { buildKeeper } from "./buildKeeper.ts";
import { readAccountMargins } from "./helpers.ts";
import { decoyBooksFixtureBuilder } from "./scenarios.ts";

/**
 * CF-007: the keeper predicts liquidation prices from one snapshot, re-evaluated
 * at any mark. On decoy books, where netting reads every side as loss-free, that
 * replica must still give the engine's own IM and MM, at the mark it was read
 * at and after the mark moves.
 */

let node: HardhatNode;
let testClient: TestClient;
let decoyBooksFixture: ReturnType<typeof decoyBooksFixtureBuilder>;

before(
  async () => {
    node = await startHardhatNode();
    testClient = createTestClient({ chain: hardhat, mode: "hardhat", transport: http(node.rpcUrl) })
      .extend(publicActions)
      .extend(walletActions);
    decoyBooksFixture = decoyBooksFixtureBuilder(node.rpcUrl);
  },
  { timeout: 60_000 },
);

after(async () => {
  await node?.stop();
});

describe("CF-007 fill-loss parity (live RPC)", () => {
  it(
    "replicates the engine's IM and MM on decoy books at any mark",
    { timeout: 60_000 },
    async () => {
      const ctx = await loadFixture(decoyBooksFixture, testClient);
      const keeper = buildKeeper(ctx);
      const user = ctx.accounts.alice.account.address;

      const params = await readMMParams(keeper.chain, keeper.config);
      const snapshot = await readAccountSnapshot(keeper.chain, keeper.config, user);

      for (const mark of [ctx.mark, (ctx.mark * 9n) / 10n, (ctx.mark * 11n) / 10n]) {
        await ctx.setMark(mark);
        const engine = await readAccountMargins(ctx, user);
        assert.equal(imRequired(snapshot, params, mark), engine.imRequired, `IM at mark ${mark}`);
        assert.equal(mmRequired(snapshot, params, mark), engine.mmRequired, `MM at mark ${mark}`);
      }
    },
  );
});
