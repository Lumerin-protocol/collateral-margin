import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";
import { deployVaultFixture } from "./fixtures.js";

const conn = await network.getOrCreate();
const { networkHelpers } = conn;
const { loadFixture } = networkHelpers;

/** USDC amount in token decimals. */
const usdc = (whole: bigint) => whole * 1_000_000n;

const FUND_SEED = usdc(100_000n);
/** A realized leg loss the account cannot cover, then the offsetting leg's gain. */
const LEG_PNL = usdc(8_000n);
const INSURANCE_DEBT_CAP = usdc(1_000n);

async function setupFixture(conn: NetworkConnection) {
  const { networkHelpers, viem } = conn;
  const ctx = await networkHelpers.loadFixture(deployVaultFixture);
  const margin = await viem.deployContract("MarginEngineMock", []);
  await margin.write.setVault([ctx.vault.address]);
  await ctx.vault.write.setMarginEngine([margin.address], {
    account: ctx.owner.account,
  });
  await ctx.vault.write.setAuthorizedCaller(
    [ctx.engine.account.address, true],
    { account: ctx.owner.account },
  );
  await ctx.vault.write.setInsuranceDebtCap([INSURANCE_DEBT_CAP], {
    account: ctx.owner.account,
  });
  const fund = await ctx.vault.read.INSURANCE_FUND_ADDR();
  return { ...ctx, fund };
}

/**
 * CF-665 / CF-666 / CF-669: venues realize an account's legs one at a time through
 * `settleTransfer`. A loss the account cannot cover is written off to the insurance fund,
 * and the same account's offsetting gain is then paid in full, so the fund pays out the
 * hedge's gain without ever collecting its loss.
 */
describe("CF-665 — an account's realized gain repays its own uncovered loss first", () => {
  it("nets the gain against the written-off loss and leaves the fund whole", async () => {
    const { vault, owner, alice, engine, fund } =
      await loadFixture(setupFixture);
    await vault.write.depositInsuranceFund([FUND_SEED], {
      account: owner.account,
    });

    await vault.write.settleTransfer([alice.account.address, fund, LEG_PNL], {
      account: engine.account,
    });
    const { result: moved } = await vault.simulate.settleTransfer(
      [fund, alice.account.address, LEG_PNL],
      { account: engine.account.address },
    );
    await vault.write.settleTransfer([fund, alice.account.address, LEG_PNL], {
      account: engine.account,
    });

    assert.equal(
      moved,
      LEG_PNL,
      "the gain is fully satisfied, so venues see a complete payment",
    );
    assert.equal(
      await vault.read.balanceOf([alice.account.address]),
      0n,
      "zero-capital hedge withdraws nothing",
    );
    assert.equal(
      await vault.read.insuranceFundBalance(),
      FUND_SEED,
      "fund is not drained",
    );
    assert.equal(
      await vault.read.traderBadDebtTotal(),
      0n,
      "recovered loss is no longer bad debt",
    );
    assert.equal(await vault.read.uncoveredLoss(), 0n);
    assert.equal(await vault.read.insuranceDebt(), 0n);
  });

  it("pays only the part of a gain that exceeds the account's debt", async () => {
    const { vault, owner, alice, engine, fund } =
      await loadFixture(setupFixture);
    await vault.write.depositInsuranceFund([FUND_SEED], {
      account: owner.account,
    });
    const excess = usdc(2_000n);

    await vault.write.settleTransfer([alice.account.address, fund, LEG_PNL], {
      account: engine.account,
    });
    await vault.write.settleTransfer(
      [fund, alice.account.address, LEG_PNL + excess],
      {
        account: engine.account,
      },
    );

    assert.equal(await vault.read.balanceOf([alice.account.address]), excess);
    assert.equal(await vault.read.insuranceFundBalance(), FUND_SEED - excess);
    assert.equal(await vault.read.traderBadDebtTotal(), 0n);
  });

  it("does not borrow or latch the halt for a gain that only repays the account's debt", async () => {
    const { vault, alice, engine, fund } = await loadFixture(setupFixture);
    assert.ok(
      LEG_PNL > INSURANCE_DEBT_CAP,
      "the gain alone would cross the cap if borrowed",
    );

    await vault.write.settleTransfer([alice.account.address, fund, LEG_PNL], {
      account: engine.account,
    });
    await vault.write.settleTransfer([fund, alice.account.address, LEG_PNL], {
      account: engine.account,
    });

    assert.equal(await vault.read.insuranceDebt(), 0n, "nothing is minted");
    assert.equal(await vault.read.halted(), false);
    assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
    assert.equal(await vault.read.traderBadDebtTotal(), 0n);
  });

  it("does not let one account's loss reduce another account's gain", async () => {
    const { vault, owner, alice, bob, engine, fund } =
      await loadFixture(setupFixture);
    await vault.write.depositInsuranceFund([FUND_SEED], {
      account: owner.account,
    });

    await vault.write.settleTransfer([alice.account.address, fund, LEG_PNL], {
      account: engine.account,
    });
    await vault.write.settleTransfer([fund, bob.account.address, LEG_PNL], {
      account: engine.account,
    });

    assert.equal(await vault.read.balanceOf([bob.account.address]), LEG_PNL);
    assert.equal(await vault.read.traderBadDebtTotal(), LEG_PNL);
  });

  it("keeps a fee shortfall as lost revenue that a later gain does not repay", async () => {
    const { vault, owner, alice, bob, engine, fund } =
      await loadFixture(setupFixture);
    await vault.write.depositInsuranceFund([FUND_SEED], {
      account: owner.account,
    });

    await vault.write.settleTransfer(
      [alice.account.address, bob.account.address, LEG_PNL],
      {
        account: engine.account,
      },
    );
    await vault.write.settleTransfer([fund, alice.account.address, LEG_PNL], {
      account: engine.account,
    });

    assert.equal(await vault.read.balanceOf([alice.account.address]), LEG_PNL);
    assert.equal(await vault.read.traderBadDebtTotal(), 0n);
  });
});
