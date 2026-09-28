import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, FUND, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleVaultResumed", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("clears an owner halt", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.halt([], { account: owner.account, chain: null });
    await vault.write.resume([], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(state.halted, false);
    assert.equal(num(state.haltedSince), "0");

    const events = snap.saved("VaultHaltEvent");
    assert.equal(events.length, 2);
    assert.equal(events[1]?.kind, "RESUME");
    assert.equal(num(events[1]?.debt), "0");
    assert.equal(num(events[1]?.effectiveCap), "0");
  });

  it("clears a cap halt once the debt is repaid", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.settleTransfer([FUND, bob.account.address, 10n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.depositInsuranceFund([10n], { account: owner.account, chain: null });
    await vault.write.resume([], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(state.halted, false);
    assert.equal(num(state.insuranceDebt), "0");
    assert.equal(num(state.haltedSince), "0");

    const events = snap.saved("VaultHaltEvent");
    assert.equal(events[events.length - 1]?.kind, "RESUME");
    assert.equal(num(events[events.length - 1]?.debt), "0");
  });
});
