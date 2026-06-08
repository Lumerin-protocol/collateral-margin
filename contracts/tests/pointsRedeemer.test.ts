import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { network } from "hardhat";
import { deployRedeemerFixture } from "./pointsFixtures.js";

const { viem, networkHelpers } = await network.connect();

const ALICE_PTS = 1_000_000_000n; // 1000 POINTS
const BOB_PTS = 3_000_000_000n; // 3000 POINTS
const POOL = 4_000_000_000n; // 4000 GOV

/** Finalize POINTS, fund the redeemer, mint balances, and open redemption. */
async function setupEnabled(fixture: Awaited<ReturnType<typeof deployRedeemerFixture>>) {
  const { points, gov, redeemer, owner, alice, bob } = fixture;
  await points.write.mint([alice.account.address, ALICE_PTS], { account: owner.account });
  await points.write.mint([bob.account.address, BOB_PTS], { account: owner.account });
  await points.write.finalize({ account: owner.account });
  await gov.write.transfer([redeemer.address, POOL], { account: owner.account });
  await redeemer.write.enableRedemption([POOL], { account: owner.account });
}

describe("PointsRedeemer", () => {
  describe("enableRedemption", () => {
    it("reverts before POINTS is finalized", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      const { points, gov, redeemer, owner, alice } = fx;
      await points.write.mint([alice.account.address, ALICE_PTS], { account: owner.account });
      await gov.write.transfer([redeemer.address, POOL], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        redeemer.write.enableRedemption([POOL], { account: owner.account }),
        redeemer,
        "NotFinalized",
      );
    });

    it("reverts when the pool exceeds the GOV held", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      const { points, redeemer, owner, alice } = fx;
      await points.write.mint([alice.account.address, ALICE_PTS], { account: owner.account });
      await points.write.finalize({ account: owner.account });
      await viem.assertions.revertWithCustomError(
        redeemer.write.enableRedemption([POOL], { account: owner.account }),
        redeemer,
        "InsufficientGov",
      );
    });

    it("snapshots pool and total points", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      await setupEnabled(fx);
      assert.equal(await fx.redeemer.read.enabled(), true);
      assert.equal(await fx.redeemer.read.govPool(), POOL);
      assert.equal(await fx.redeemer.read.totalPointsSnapshot(), ALICE_PTS + BOB_PTS);
    });

    it("reverts on double enable", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      await setupEnabled(fx);
      await viem.assertions.revertWithCustomError(
        fx.redeemer.write.enableRedemption([POOL], { account: fx.owner.account }),
        fx.redeemer,
        "AlreadyEnabled",
      );
    });
  });

  describe("swap", () => {
    it("reverts before redemption is enabled", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      const { points, redeemer, owner, alice } = fx;
      await points.write.mint([alice.account.address, ALICE_PTS], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        redeemer.write.swap({ account: alice.account }),
        redeemer,
        "NotEnabled",
      );
    });

    it("pays pro-rata, splitting 50/50 liquid and escrow, with no approve", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      await setupEnabled(fx);
      const { points, gov, escrow, redeemer, alice } = fx;

      const expectedGov = (POOL * ALICE_PTS) / (ALICE_PTS + BOB_PTS); // 1000 GOV
      const liquid = expectedGov / 2n;
      const escrowAmt = expectedGov - liquid;

      await viem.assertions.emitWithArgs(
        redeemer.write.swap({ account: alice.account }),
        redeemer,
        "Swapped",
        [getAddress(alice.account.address), ALICE_PTS, expectedGov, liquid, escrowAmt],
      );

      assert.equal(await gov.read.balanceOf([alice.account.address]), liquid);
      assert.equal(await escrow.read.lockedOf([alice.account.address]), escrowAmt);
      assert.equal(await points.read.balanceOf([alice.account.address]), 0n);
    });

    it("keeps the denominator fixed as balances burn down", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      await setupEnabled(fx);
      const { gov, redeemer, alice, bob } = fx;

      await redeemer.write.swap({ account: alice.account });
      await redeemer.write.swap({ account: bob.account });

      // Bob (3x Alice's points) gets 3x the GOV, denominator unchanged by Alice's burn.
      const aliceGov = await gov.read.balanceOf([alice.account.address]);
      const bobGov = await gov.read.balanceOf([bob.account.address]);
      assert.equal(bobGov, aliceGov * 3n);
    });

    it("reverts when the caller holds no points", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      await setupEnabled(fx);
      await viem.assertions.revertWithCustomError(
        fx.redeemer.write.swap({ account: fx.carol.account }),
        fx.redeemer,
        "NoPoints",
      );
    });
  });

  describe("previewSwap", () => {
    it("returns 0 before enable and the pro-rata amount after", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      assert.equal(await fx.redeemer.read.previewSwap([fx.alice.account.address]), 0n);
      await setupEnabled(fx);
      const expected = (POOL * ALICE_PTS) / (ALICE_PTS + BOB_PTS);
      assert.equal(await fx.redeemer.read.previewSwap([fx.alice.account.address]), expected);
    });
  });

  describe("recoverGov", () => {
    it("lets the owner sweep leftover GOV", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      await setupEnabled(fx);
      const { gov, redeemer, owner, alice, carol } = fx;
      await redeemer.write.swap({ account: alice.account });

      const remaining = await gov.read.balanceOf([redeemer.address]);
      await redeemer.write.recoverGov([carol.account.address, remaining], { account: owner.account });
      assert.equal(await gov.read.balanceOf([carol.account.address]), remaining);
    });

    it("blocks non-owner recovery", async () => {
      const fx = await networkHelpers.loadFixture(deployRedeemerFixture);
      await setupEnabled(fx);
      await viem.assertions.revertWithCustomError(
        fx.redeemer.write.recoverGov([fx.alice.account.address, 1n], { account: fx.alice.account }),
        fx.redeemer,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
