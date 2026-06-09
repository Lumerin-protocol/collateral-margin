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

/** Expected taker points for the fixture's NOTIONAL + W_TAKER. */
const TAKER_PTS = (NOTIONAL * W_TAKER) / 10n ** 18n; // 1000 POINTS
/** Expected maker points for the fixture's NOTIONAL + W_MAKER. */
const MAKER_PTS = (NOTIONAL * W_MAKER) / 10n ** 18n; // 1500 POINTS
const FEE = 1_000_000n; // 1 USDC, comfortably above any threshold

describe("PointsHook", () => {
  describe("authorization", () => {
    it("rejects onFill from a non-venue caller", async () => {
      const { hook, alice, bob } = await networkHelpers.loadFixture(deployHookFixture);
      await viem.assertions.revertWithCustomError(
        hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, FEE, FEE], {
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
      await hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, FEE, FEE], {
        account: venue.account,
      });
      assert.equal(await points.read.balanceOf([alice.account.address]), MAKER_PTS);
      assert.equal(await points.read.balanceOf([bob.account.address]), TAKER_PTS);
    });

    it("skips minting on a self-match", async () => {
      const { hook, points, venue, alice } = await networkHelpers.loadFixture(deployHookFixture);
      await hook.write.onFill([alice.account.address, alice.account.address, NOTIONAL, FEE, FEE], {
        account: venue.account,
      });
      assert.equal(await points.read.balanceOf([alice.account.address]), 0n);
      assert.equal(await points.read.totalSupply(), 0n);
    });

    it("does not reward a maker rebate (non-positive makerFee)", async () => {
      const { hook, points, venue, alice, bob } = await networkHelpers.loadFixture(deployHookFixture);
      // makerFee = -1 (rebate): maker earns nothing, taker still earns.
      await hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, -1n, FEE], {
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
      await hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, FEE, FEE - 1n], {
        account: venue.account,
      });
      assert.equal(await points.read.balanceOf([bob.account.address]), 0n);
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
