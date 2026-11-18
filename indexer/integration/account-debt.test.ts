import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, FUND, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();
const BACKSTOP = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * CF-665: from vault 1.4.0 a loss an account cannot pay the insurance fund is its debt, and the
 * fund's next payout to that account cancels it without moving tokens. The on-chain
 * `traderBadDebtTotal` goes down by the cancelled amount, so the indexed totals must follow it.
 */
describe("account debt to the insurance fund", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("nets a cancelled trader debt out of the vault's bad-debt totals", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { alice, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.deposit([50n], { account: alice.account, chain: null });
    // Alice loses 60 with 50 in the vault: 10 becomes her debt.
    await vault.write.settleTransfer([alice.account.address, FUND, 60n], {
      account: engine.account,
      chain: null,
    });
    // Her next gain of 25 cancels the 10 and pays her 15 from the fund.
    await vault.write.settleTransfer([FUND, alice.account.address, 25n], {
      account: engine.account,
      chain: null,
    });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.traderBadDebtTotal), num(await vault.read.traderBadDebtTotal()));
    assert.equal(num(state.uncoveredLoss), num(await vault.read.uncoveredLoss()));
    assert.equal(num(state.insuranceFundBalance), num(await vault.read.insuranceFundBalance()));

    // The venue total records what was written off at that venue; it is not netted.
    const engineAddr = engine.account.address.toLowerCase();
    const venue = snap.saved("VaultVenue").find((row) => lower(row.id) === engineAddr);
    assert.ok(venue);
    assert.equal(num(venue.traderBadDebtTotal), "10");
  });

  it("nets a cancelled backstop debt out of the backstop share", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.settleTransfer([BACKSTOP, FUND, 40n], { account: engine.account, chain: null });
    await vault.write.settleTransfer([FUND, BACKSTOP, 40n], { account: engine.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.traderBadDebtTotal), num(await vault.read.traderBadDebtTotal()));
    assert.equal(num(state.backstopBadDebtTotal), "0");
    assert.equal(num(state.uncoveredLoss), num(await vault.read.uncoveredLoss()));
  });
});
