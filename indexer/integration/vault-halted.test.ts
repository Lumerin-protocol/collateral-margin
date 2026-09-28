import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployMarginEngine, deployVaultFixture, FUND, num, watch, ZERO } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleVaultHalted", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("latches an owner halt", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.halt([], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(state.halted, true);
    assert.ok(BigInt(num(state.haltedSince)) > 0n);

    const halt = snap.saved("VaultHaltEvent");
    assert.equal(halt.length, 1);
    assert.equal(halt[0]?.kind, "HALT");
    assert.equal(halt[0]?.reason, "OWNER");
    assert.equal(num(halt[0]?.debt), "0");
    assert.equal(num(halt[0]?.effectiveCap), "0");
  });

  it("latches CAP when a borrow crosses the effective cap", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.settleTransfer([FUND, bob.account.address, 20n], {
      account: engine.account,
      chain: null,
    });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(state.halted, true);
    assert.equal(num(state.insuranceDebt), "20");

    const halt = snap.saved("VaultHaltEvent");
    assert.equal(halt.length, 1);
    assert.equal(halt[0]?.kind, "HALT");
    assert.equal(halt[0]?.reason, "CAP");
    assert.equal(num(halt[0]?.debt), "20");
    assert.equal(num(halt[0]?.effectiveCap), "0");
  });

  it("latches NO_MARGIN_ENGINE when the engine is cleared while debt is open", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, bob, engine } = accounts;
    const margin = await deployMarginEngine(conn, owner, vault.address);
    await vault.write.setInsuranceDebtCap([1_000n], { account: owner.account, chain: null });
    await vault.write.setMarginEngine([margin.address], { account: owner.account, chain: null });
    await watch(conn.matchstick, vault);

    await vault.write.settleTransfer([FUND, bob.account.address, 10n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.setMarginEngine([ZERO], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(state.halted, true);
    assert.equal(num(state.insuranceDebt), "10");

    const halts = snap.saved("VaultHaltEvent");
    assert.equal(halts.length, 1);
    assert.equal(halts[0]?.kind, "HALT");
    assert.equal(halts[0]?.reason, "NO_MARGIN_ENGINE");
    assert.equal(num(halts[0]?.debt), "10");
    assert.equal(num(halts[0]?.effectiveCap), "0");
  });
});
