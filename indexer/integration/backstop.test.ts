import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, FUND, lower, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();
const BACKSTOP = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("protocol backstop ledger", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("splits backstop bad debt out of the trader total and tracks params", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, alice, engine } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.setBackstopParams([150, 25], { account: owner.account, chain: null });
    // Unfunded backstop loses 40 to the fund: the whole amount is a shortfall.
    await vault.write.settleTransfer([BACKSTOP, FUND, 40n], { account: engine.account, chain: null });
    // A trader shortfall of 10 lands in the same trader total but not the backstop split.
    await vault.write.deposit([50n], { account: alice.account, chain: null });
    await vault.write.settleTransfer([alice.account.address, FUND, 60n], {
      account: engine.account,
      chain: null,
    });

    const engineAddr = engine.account.address.toLowerCase();
    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(lower(state.backstopAddress), BACKSTOP);
    assert.equal(num(state.backstopUnwindBandBps), "150");
    assert.equal(num(state.backstopUnwindFeeBps), "25");
    assert.equal(num(state.traderBadDebtTotal), "50");
    assert.equal(num(state.backstopBadDebtTotal), "40");
    assert.equal(num(state.uncoveredLoss), "50");
    assert.equal(num(state.backstopBalance), "0");

    const badDebt = snap.saved("BadDebtEvent");
    assert.equal(badDebt.length, 2);
    const fromBackstop = badDebt.find((row) => lower(row.payer) === BACKSTOP);
    const fromTrader = badDebt.find((row) => lower(row.payer) === alice.account.address.toLowerCase());
    assert.ok(fromBackstop);
    assert.ok(fromTrader);
    assert.equal(fromBackstop.isBackstop, true);
    assert.equal(fromBackstop.kind, "RESERVE_LOSS");
    assert.equal(num(fromBackstop.amount), "40");
    assert.equal(fromTrader.isBackstop, false);

    const venue = snap.saved("VaultVenue").find((row) => lower(row.id) === engineAddr);
    assert.ok(venue);
    assert.equal(num(venue.traderBadDebtTotal), "50");
    assert.equal(num(venue.backstopBadDebtTotal), "40");

    const params = snap.saved("BackstopParamsChange");
    assert.equal(params.length, 1);
    assert.equal(num(params[0]?.unwindBandBps), "150");
    assert.equal(num(params[0]?.unwindFeeBps), "25");
  });

  it("tracks the backstop balance and keeps its sweeps out of the user withdrawal total", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner, alice, engine } = accounts;
    await watch(conn.matchstick, vault);

    // A trader pays the backstop (e.g. the backstop's inherited position won).
    await vault.write.deposit([100n], { account: alice.account, chain: null });
    await vault.write.settleTransfer([alice.account.address, BACKSTOP, 70n], {
      account: engine.account,
      chain: null,
    });
    await vault.write.withdrawBackstop([owner.account.address, 30n], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0"), read("VaultUser", BACKSTOP)]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.backstopBalance), "40");
    assert.equal(num(state.backstopWithdrawn), "30");
    assert.equal(num(state.totalWithdrawn), "0");
    assert.equal(num(state.withdrawalCount), "0");
    assert.equal(num(state.insuranceFundBalance), "0");
    assert.equal(num(state.traderBadDebtTotal), "0");

    const ledger = snap.entity("VaultUser", BACKSTOP);
    assert.ok(ledger);
    assert.equal(num(ledger.balance), "40");

    const withdrawals = snap.saved("VaultWithdrawal");
    assert.equal(withdrawals.length, 1);
    assert.equal(withdrawals[0]?.isBackstop, true);
    assert.equal(withdrawals[0]?.isInsuranceFund, false);
    assert.equal(lower(withdrawals[0]?.user), BACKSTOP);
    assert.equal(lower(withdrawals[0]?.recipient), owner.account.address.toLowerCase());
    assert.equal(num(withdrawals[0]?.amount), "30");
  });
});
