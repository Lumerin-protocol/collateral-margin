import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress } from "viem";
import { network } from "hardhat";
import { deployPointsFixture } from "./pointsFixtures.js";

const { viem, networkHelpers } = await network.connect();

const ONE_POINT = 1_000_000n; // 6 decimals

/** Grant MINTER_ROLE to owner and mint `amount` to `to`. */
async function mintTo(
  fixture: Awaited<ReturnType<typeof deployPointsFixture>>,
  to: `0x${string}`,
  amount: bigint,
) {
  const { points, owner } = fixture;
  const minterRole = await points.read.MINTER_ROLE();
  if (!(await points.read.hasRole([minterRole, owner.account.address]))) {
    await points.write.grantRole([minterRole, owner.account.address], { account: owner.account });
  }
  await points.write.mint([to, amount], { account: owner.account });
}

describe("Points", () => {
  describe("metadata", () => {
    it("uses HP symbol and 6 decimals", async () => {
      const { points } = await networkHelpers.loadFixture(deployPointsFixture);
      assert.equal(await points.read.name(), "Hashrate Points");
      assert.equal(await points.read.symbol(), "HP");
      assert.equal(await points.read.decimals(), 6);
    });

    it("grants admin role to the deployer-specified admin", async () => {
      const { points, owner } = await networkHelpers.loadFixture(deployPointsFixture);
      const adminRole = await points.read.DEFAULT_ADMIN_ROLE();
      assert.equal(await points.read.hasRole([adminRole, owner.account.address]), true);
    });
  });

  describe("minting", () => {
    it("only MINTER_ROLE can mint", async () => {
      const { points, alice } = await networkHelpers.loadFixture(deployPointsFixture);
      await viem.assertions.revertWithCustomError(
        points.write.mint([alice.account.address, ONE_POINT], { account: alice.account }),
        points,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints, crediting balance and total supply", async () => {
      const fx = await networkHelpers.loadFixture(deployPointsFixture);
      await mintTo(fx, fx.alice.account.address, ONE_POINT);
      assert.equal(await fx.points.read.balanceOf([fx.alice.account.address]), ONE_POINT);
      assert.equal(await fx.points.read.totalSupply(), ONE_POINT);
    });
  });

  describe("non-transferable", () => {
    it("blocks transfer", async () => {
      const fx = await networkHelpers.loadFixture(deployPointsFixture);
      await mintTo(fx, fx.alice.account.address, ONE_POINT);
      await viem.assertions.revertWithCustomError(
        fx.points.write.transfer([fx.bob.account.address, ONE_POINT], { account: fx.alice.account }),
        fx.points,
        "TransfersDisabled",
      );
    });

    it("blocks transferFrom even for the admin", async () => {
      const fx = await networkHelpers.loadFixture(deployPointsFixture);
      await mintTo(fx, fx.alice.account.address, ONE_POINT);
      await viem.assertions.revertWithCustomError(
        fx.points.write.transferFrom([fx.alice.account.address, fx.bob.account.address, ONE_POINT], {
          account: fx.owner.account,
        }),
        fx.points,
        "TransfersDisabled",
      );
    });

    it("blocks approve and reports zero allowance", async () => {
      const { points, alice, bob } = await networkHelpers.loadFixture(deployPointsFixture);
      await viem.assertions.revertWithCustomError(
        points.write.approve([bob.account.address, ONE_POINT], { account: alice.account }),
        points,
        "TransfersDisabled",
      );
      assert.equal(await points.read.allowance([alice.account.address, bob.account.address]), 0n);
    });
  });

  describe("burning", () => {
    it("only BURNER_ROLE can burn", async () => {
      const fx = await networkHelpers.loadFixture(deployPointsFixture);
      await mintTo(fx, fx.alice.account.address, ONE_POINT);
      await viem.assertions.revertWithCustomError(
        fx.points.write.burn([fx.alice.account.address, ONE_POINT], { account: fx.alice.account }),
        fx.points,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns from an account and reduces supply", async () => {
      const fx = await networkHelpers.loadFixture(deployPointsFixture);
      const { points, owner, alice } = fx;
      await mintTo(fx, alice.account.address, ONE_POINT);
      const burnerRole = await points.read.BURNER_ROLE();
      await points.write.grantRole([burnerRole, owner.account.address], { account: owner.account });

      await points.write.burn([alice.account.address, ONE_POINT], { account: owner.account });
      assert.equal(await points.read.balanceOf([alice.account.address]), 0n);
      assert.equal(await points.read.totalSupply(), 0n);
    });
  });

  describe("finalize", () => {
    it("only admin can finalize", async () => {
      const { points, alice } = await networkHelpers.loadFixture(deployPointsFixture);
      await viem.assertions.revertWithCustomError(
        points.write.finalize({ account: alice.account }),
        points,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("freezes minting after finalize", async () => {
      const fx = await networkHelpers.loadFixture(deployPointsFixture);
      const { points, owner, alice } = fx;
      const minterRole = await points.read.MINTER_ROLE();
      await points.write.grantRole([minterRole, owner.account.address], { account: owner.account });

      await viem.assertions.emit(points.write.finalize({ account: owner.account }), points, "Finalized");
      assert.equal(await points.read.finalized(), true);

      await viem.assertions.revertWithCustomError(
        points.write.mint([alice.account.address, ONE_POINT], { account: owner.account }),
        points,
        "MintingFinalized",
      );
    });

    it("reverts on double finalize", async () => {
      const { points, owner } = await networkHelpers.loadFixture(deployPointsFixture);
      await points.write.finalize({ account: owner.account });
      await viem.assertions.revertWithCustomError(
        points.write.finalize({ account: owner.account }),
        points,
        "MintingFinalized",
      );
    });
  });

  describe("constructor", () => {
    it("rejects a zero admin", async () => {
      const { points } = await networkHelpers.loadFixture(deployPointsFixture);
      await viem.assertions.revertWithCustomError(
        viem.deployContract("Points", [zeroAddress]),
        points,
        "ZeroAddress",
      );
    });
  });
});
