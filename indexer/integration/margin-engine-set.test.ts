import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployMarginEngine, deployVaultFixture, lower, num, watch, ZERO } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleMarginEngineSet", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("stores the engine address and a later clear", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner } = accounts;
    const margin = await deployMarginEngine(conn, owner, vault.address);
    await watch(conn.matchstick, vault);

    await vault.write.setMarginEngine([margin.address], { account: owner.account, chain: null });

    const set = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const during = set.entity("Vault", "0");
    assert.ok(during);
    assert.equal(lower(during.marginEngine), margin.address.toLowerCase());
    assert.equal(during.halted, false);

    await vault.write.setMarginEngine([ZERO], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(lower(state.marginEngine), ZERO);
    assert.equal(num(state.insuranceDebt), "0");
    assert.equal(state.halted, false);
  });
});
