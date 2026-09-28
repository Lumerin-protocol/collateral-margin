import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, FUND, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleBadDebt", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("records a shortfall paid to a trader as FEE", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice, bob, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([50n], { account: alice.account, chain: null });
    await vault.write.settleTransfer([alice.account.address, bob.account.address, 80n], {
      account: engine.account,
      chain: null,
    });

    const aliceAddr = alice.account.address.toLowerCase();
    const bobAddr = bob.account.address.toLowerCase();
    const engineAddr = engine.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.traderBadDebtTotal), "0");
    assert.equal(num(state.uncoveredLoss), "0");

    const badDebt = snap.saved("BadDebtEvent");
    assert.equal(badDebt.length, 1);
    assert.equal(badDebt[0]?.kind, "FEE");
    assert.equal(num(badDebt[0]?.amount), "30");
    assert.equal(lower(badDebt[0]?.payer), aliceAddr);
    assert.equal(lower(badDebt[0]?.receiver), bobAddr);
    assert.equal(lower(badDebt[0]?.venue), engineAddr);

    const venue = snap.saved("VaultVenue").find((row) => lower(row.id) === engineAddr);
    assert.ok(venue);
    assert.equal(num(venue.feeBadDebtTotal), "30");
    assert.equal(num(venue.traderBadDebtTotal), "0");
  });

  it("records a shortfall paid to the insurance fund as RESERVE_LOSS", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([50n], { account: alice.account, chain: null });
    await vault.write.settleTransfer([alice.account.address, FUND, 60n], {
      account: engine.account,
      chain: null,
    });

    const aliceAddr = alice.account.address.toLowerCase();
    const engineAddr = engine.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.traderBadDebtTotal), "10");
    assert.equal(num(state.uncoveredLoss), "10");
    assert.equal(num(state.insuranceDebt), "0");

    const badDebt = snap.saved("BadDebtEvent");
    assert.equal(badDebt.length, 1);
    assert.equal(badDebt[0]?.kind, "RESERVE_LOSS");
    assert.equal(num(badDebt[0]?.amount), "10");
    assert.equal(lower(badDebt[0]?.payer), aliceAddr);
    assert.equal(lower(badDebt[0]?.receiver), FUND);
    assert.equal(lower(badDebt[0]?.venue), engineAddr);

    const venue = snap.saved("VaultVenue").find((row) => lower(row.id) === engineAddr);
    assert.ok(venue);
    assert.equal(num(venue.traderBadDebtTotal), "10");
    assert.equal(num(venue.feeBadDebtTotal), "0");
  });
});
