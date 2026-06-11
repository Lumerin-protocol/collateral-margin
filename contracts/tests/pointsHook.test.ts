import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  KEEPER_POINTS,
  NOTIONAL,
  W_MAKER,
  W_TAKER,
  deployHookFixture,
} from "./pointsFixtures.js";

const { viem, networkHelpers } = await network.connect();

const WAD = 10n ** 18n;
/** Expected taker points for the fixture's NOTIONAL + W_TAKER. */
const TAKER_PTS = (NOTIONAL * W_TAKER) / WAD; // 1000 POINTS
/** Expected maker points for the fixture's NOTIONAL + W_MAKER (1x multiplier). */
const MAKER_PTS = (NOTIONAL * W_MAKER) / WAD; // 1500 POINTS
const FEE = 1_000_000n; // 1 USDC, comfortably above any threshold

// Price-improvement config used by the multiplier tests: 3x at zero spread, tapering
// to 1x at a 1% spread from the reference price.
const MAX_MULT = 3n * WAD;
const MAX_SPREAD = WAD / 100n; // 1%
const REF_PRICE = 1000n;

describe("PointsHook", () => {
  describe("authorization", () => {
    it("rejects onFill from a non-venue caller", async () => {
      const { hook, alice, bob } = await networkHelpers.loadFixture(deployHookFixture);
      await viem.assertions.revertWithCustomError(
        hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, 0n, 0n], {
          account: alice.account,
        }),
        hook,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("rejects onLiquidation from a non-venue caller", async () => {
      const { hook, alice, keeper } = await networkHelpers.loadFixture(deployHookFixture);
      await viem.assertions.revertWithCustomError(
        hook.write.onLiquidation([keeper.account.address, FEE], { account: alice.account }),
        hook,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("onFill accrual", () => {
    it("mints weighted points to maker and taker", async () => {
      const { hook, points, venue, alice, bob } = await networkHelpers.loadFixture(deployHookFixture);
      // alice = maker, bob = taker
      await hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, 0n, 0n], {
        account: venue.account,
      });
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS);
      assert.equal(await points.read.balanceOf([bob.account.address]), TAKER_PTS);
    });

    it("skips minting on a self-match", async () => {
      const { hook, points, venue, alice } = await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.onFill([alice.account.address, alice.account.address, NOTIONAL, FEE, FEE, 0n, 0n], {
        account: venue.account,
      });
      assert.equal(await points.read.balanceOf([alice.account.address]), 0n);
      assert.equal(await points.read.totalSupply(), 0n);
    });

    it("does not reward a maker rebate (non-positive makerFee)", async () => {
      const { hook, points, venue, alice, bob } = await networkHelpers.loadFixture(deployHookFixture);
      // makerFee = -1 (rebate): maker earns nothing, taker still earns.
      await hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, -1n, FEE, 0n, 0n], {
        account: venue.account,
      });
      assert.equal(await points.read.balanceOf([alice.account.address]), 0n);
      assert.equal(await points.read.balanceOf([bob.account.address]), TAKER_PTS);
    });

    it("enforces the minimum fee threshold per side", async () => {
      const { hook, points, owner, venue, alice, bob } =
        await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.setMinFee([FEE], { account: owner.account });

      // taker pays below threshold, maker pays at threshold.
      await hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, FEE, FEE - 1n, 0n, 0n], {
        account: venue.account,
      });
      assert.equal(await points.read.balanceOf([bob.account.address]), 0n);
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS);
    });
  });

  describe("maker price-improvement multiplier", () => {
    it("is neutral (1x) by default, even when prices are supplied", async () => {
      const { hook, points, venue, alice, bob } = await networkHelpers.loadFixture(deployHookFixture);
      // Multiplier unconfigured (maxMakerMult == 0): a tight quote still earns the flat rate.
      await hook.write.onFill(
        [alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, REF_PRICE, REF_PRICE],
        { account: venue.account },
      );
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS);
    });

    it("applies the full multiplier when the maker quotes at the reference price", async () => {
      const { hook, points, owner, venue, alice, bob } =
        await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.setPriceImprovement([MAX_MULT, MAX_SPREAD], { account: owner.account });

      // spread == 0 → 3x maker points; taker is unaffected.
      await hook.write.onFill(
        [alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, REF_PRICE, REF_PRICE],
        { account: venue.account },
      );
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS * 3n);
      assert.equal(await points.read.balanceOf([bob.account.address]), TAKER_PTS);
    });

    it("tapers linearly between zero spread and maxSpread", async () => {
      const { hook, points, owner, venue, alice, bob } =
        await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.setPriceImprovement([MAX_MULT, MAX_SPREAD], { account: owner.account });

      // makerPrice 0.5% above ref → halfway through the taper → 2x.
      const makerPrice = REF_PRICE + (REF_PRICE * MAX_SPREAD) / (2n * WAD); // 1005
      await hook.write.onFill(
        [alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, makerPrice, REF_PRICE],
        { account: venue.account },
      );
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS * 2n);
    });

    it("falls back to 1x at or beyond maxSpread", async () => {
      const { hook, points, owner, venue, alice, bob } =
        await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.setPriceImprovement([MAX_MULT, MAX_SPREAD], { account: owner.account });

      // makerPrice 1% from ref == maxSpread → 1x (wide quotes earn only the base rate).
      const makerPrice = REF_PRICE + (REF_PRICE * MAX_SPREAD) / WAD; // 1010
      await hook.write.onFill(
        [alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, makerPrice, REF_PRICE],
        { account: venue.account },
      );
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS);
    });

    it("drops the bonus to 1x when no reference price is available (stale oracle)", async () => {
      const { hook, points, owner, venue, alice, bob } =
        await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.setPriceImprovement([MAX_MULT, MAX_SPREAD], { account: owner.account });

      // refPrice == 0 signals a stale/absent oracle: maker still earns, just no bonus.
      await hook.write.onFill(
        [alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, REF_PRICE, 0n],
        { account: venue.account },
      );
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS);
    });
  });

  describe("onLiquidation", () => {
    it("mints flat keeper points", async () => {
      const { hook, points, venue, keeper } = await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.onLiquidation([keeper.account.address, FEE], { account: venue.account });
      assert.equal(await points.read.balanceOf([keeper.account.address]), KEEPER_POINTS);
    });
  });
});
