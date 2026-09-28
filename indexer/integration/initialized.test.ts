import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, FUND, lower, num, watch, ZERO } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleInitialized", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("loads decimals, the collateral token, and the insurance fund from the contract", async () => {
    const { vault, usdc } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    await watch(conn.matchstick, vault);

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(lower(state.contractAddress), vault.address.toLowerCase());
    assert.equal(lower(state.collateralToken), usdc.address.toLowerCase());
    assert.equal(lower(state.marginEngine), ZERO);
    assert.equal(lower(state.insuranceFundAddress), FUND);
    assert.equal(num(state.decimals), "6");
    assert.ok(BigInt(num(state.initializedAt)) > 0n);
    assert.equal(num(state.totalSupply), "0");
    assert.equal(num(state.insuranceDebt), "0");
    assert.equal(state.halted, false);
  });
});
