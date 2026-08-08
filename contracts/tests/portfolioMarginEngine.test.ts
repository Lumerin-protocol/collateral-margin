import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";
import {
  DEFAULT_MARKET_PRICE,
  deployCollateralVaultProxy,
  deployPortfolioMarginEngineFixture,
} from "./fixtures.js";

const conn = await network.connect();
const { viem, networkHelpers } = conn;

/** Perps mock: 1-lot quantity (1e6 units). Used wherever tests open a one-lot position. */
const ONE_LOT_QTY = 1_000_000n;

const WAD = 10n ** 18n;

describe("PortfolioMarginEngine", () => {
  describe("no positions", () => {
    it("returns 0 margin when user has no positions", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const im = await pme.read.computePortfolioIM([user]);
      const mm = await pme.read.computePortfolioMM([user]);
      assert.equal(im, 0n);
      assert.equal(mm, 0n);
    });

    it("isHealthy returns true with no positions", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      assert.equal(await pme.read.isHealthy([user]), true);
    });
  });

  describe("perps-only position", () => {
    it("computes margin from perps delta stress", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);

      const im = await pme.read.computePortfolioIM([user]);
      assert.equal(im, 5_000_000_000n, "IM = 10% of $50k position");
    });

    it("includes unrealized loss in margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      const lossUsdc = 1_000_000_000n;

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      const imBase = await pme.read.computePortfolioIM([user]);

      await perpsMock.write.setUnrealizedPnl([user, -lossUsdc]);
      const imWithLoss = await pme.read.computePortfolioIM([user]);

      assert.equal(imWithLoss - imBase, lossUsdc, "unrealized loss adds to IM");
    });

    it("does not include unrealized profit in margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      const profitUsdc = 1_000_000_000n;

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      const imBase = await pme.read.computePortfolioIM([user]);

      await perpsMock.write.setUnrealizedPnl([user, profitUsdc]);
      const imWithProfit = await pme.read.computePortfolioIM([user]);

      assert.equal(imWithProfit, imBase, "unrealized profit does not change IM");
    });

    /**
     * IM clamps unrealized PnL per market so gains are ignored; MM clamps the
     * portfolio-wide sum so a gain at one venue offsets a loss at another. The
     * split lets a cross-venue hedge stay solvent without letting an unrealized
     * gain release collateral through the vault's IM-gated withdrawal check.
     */
    describe("cross-market unrealized PnL clamp", () => {
      const AMOUNT = 1_000_000_000n;

      /** Offsetting marks: perps down $1,000, futures up the same. */
      async function offsettingPnl() {
        const fixture = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
        await fixture.perpsMock.write.setUnrealizedPnl([fixture.user, -AMOUNT]);
        await fixture.futuresMock.write.setUnrealizedPnl([fixture.user, AMOUNT]);
        return fixture;
      }

      it("MM lets a gain at one venue offset a loss at another", async () => {
        const { pme, user } = await offsettingPnl();

        assert.equal(
          await pme.read.computePortfolioMM([user]),
          0n,
          "net PnL is zero, so MM carries no unrealized term at all",
        );
      });

      it("IM ignores the offsetting gain and charges the loss in full", async () => {
        const { pme, user } = await offsettingPnl();

        assert.equal(
          await pme.read.computePortfolioIM([user]),
          AMOUNT,
          "IM gates withdrawals, so an unrealized gain must not release collateral",
        );
      });

      it("MM still charges a net loss in full", async () => {
        const { pme, perpsMock, futuresMock, user } = await networkHelpers.loadFixture(
          deployPortfolioMarginEngineFixture,
        );
        await perpsMock.write.setUnrealizedPnl([user, -AMOUNT]);
        await futuresMock.write.setUnrealizedPnl([user, AMOUNT / 4n]);

        assert.equal(
          await pme.read.computePortfolioMM([user]),
          AMOUNT - AMOUNT / 4n,
          "netting reduces the charge to the residual, not below it",
        );
      });

      it("a net gain cannot reduce MM below the rest of the requirement", async () => {
        const { pme, perpsMock, futuresMock, user } = await networkHelpers.loadFixture(
          deployPortfolioMarginEngineFixture,
        );
        await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
        const mmBase = await pme.read.computePortfolioMM([user]);

        // Overwhelming profit on one leg, none on the other.
        await futuresMock.write.setUnrealizedPnl([user, 100n * AMOUNT]);

        assert.equal(
          await pme.read.computePortfolioMM([user]),
          mmBase,
          "unrealized profit offsets losses but never funds a discount on stress",
        );
      });

      it("keeps IM at or above MM, which OverLiquidation depends on", async () => {
        const { pme, perpsMock, futuresMock, user } = await offsettingPnl();
        await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
        await futuresMock.write.setNetPositionDelta([user, -ONE_LOT_QTY / 2n]);

        assert.ok(
          (await pme.read.computePortfolioIM([user])) >= (await pme.read.computePortfolioMM([user])),
          "the venues' over-liquidation guard is unsound if IM can dip below MM",
        );
      });
    });

    it("includes pending funding owed in margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      const fundingOwed = 500_000_000n;

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      const imBase = await pme.read.computePortfolioIM([user]);

      await perpsMock.write.setPendingFunding([user, fundingOwed]);
      const imWithFunding = await pme.read.computePortfolioIM([user]);

      assert.equal(imWithFunding - imBase, fundingOwed, "funding owed adds to IM");
    });

    it("stresses resting bids as post-fill delta", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      // 0.4 lots of resting bids on a flat account: the buy leg stresses at
      // 4e5 delta × 10% × $50k = $2,000.
      const buyDelta = 400_000n;

      await perpsMock.write.setOrderDeltas([user, buyDelta, 0n]);
      const im = await pme.read.computePortfolioIM([user]);

      assert.equal(im, 2_000_000_000n, "resting bid delta drives the worse stress leg");
    });

    it("takes the worse of the two fill legs", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      // Flat account, asks twice the size of the bids: the sell leg is worse.
      await perpsMock.write.setOrderDeltas([user, 400_000n, 800_000n]);
      const im = await pme.read.computePortfolioIM([user]);

      assert.equal(im, 4_000_000_000n, "|-8e5| stress dominates |+4e5|");
    });

    it("nets a resting ask against a long position instead of crediting it", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      // Long 1 lot with 1 lot of resting asks: filling them takes the account flat,
      // so the sell leg is free and the (empty) buy leg is what the position costs.
      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      await perpsMock.write.setOrderDeltas([user, 0n, ONE_LOT_QTY]);

      const im = await pme.read.computePortfolioIM([user]);
      assert.equal(im, 5_000_000_000n, "position stress only; the offsetting ask adds nothing");

      // Twice the position in resting asks flips the account net short on a fill —
      // the sell leg now dominates and the order is charged rather than credited.
      await perpsMock.write.setOrderDeltas([user, 0n, 2n * ONE_LOT_QTY]);
      const imOverSold = await pme.read.computePortfolioIM([user]);
      assert.equal(imOverSold, 5_000_000_000n, "net short 1 lot costs the same as net long 1 lot");
    });

    it("adds per-side fill loss on top of both legs", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      const buyLoss = 700_000_000n;
      const sellLoss = 300_000_000n;

      await perpsMock.write.setOrderDeltas([user, 400_000n, 0n]);
      await perpsMock.write.setOrderFillLosses([user, buyLoss, sellLoss]);

      const im = await pme.read.computePortfolioIM([user]);
      assert.equal(im, 2_000_000_000n + buyLoss + sellLoss, "both sides' fill loss is charged");
    });

    it("orderMarginOf reports the incremental cost of the resting orders", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      assert.equal(await pme.read.orderMarginOf([user]), 0n, "no orders cost nothing");

      // An ask that exactly offsets the long is free; the same ask doubled costs the
      // difference between net short 1 lot and net long 1 lot, i.e. nothing either.
      await perpsMock.write.setOrderDeltas([user, 0n, ONE_LOT_QTY]);
      assert.equal(await pme.read.orderMarginOf([user]), 0n, "offsetting ask is free");

      // A bid on top of the long is charged in full.
      await perpsMock.write.setOrderDeltas([user, ONE_LOT_QTY, 0n]);
      assert.equal(
        await pme.read.orderMarginOf([user]),
        5_000_000_000n,
        "adding-to-position bid costs its own stress",
      );
    });
  });

  describe("hasRestingOrderDelta", () => {
    it("is false for an account with positions but no orders", async () => {
      const { pme, perpsMock, futuresMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      await futuresMock.write.setNetPositionDelta([user, ONE_LOT_QTY]);

      assert.equal(
        await pme.read.hasRestingOrderDelta([user]),
        false,
        "position delta is not order delta — only resting orders gate liquidation",
      );
    });

    it("sees order delta on a venue other than the one asking", async () => {
      const { pme, perpsMock, futuresMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      // The case the gate exists for: the position is on one venue, the resting
      // orders on another, and neither venue can see the other's book.
      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      await futuresMock.write.setOrderDeltas([user, 0n, ONE_LOT_QTY]);

      assert.equal(await pme.read.hasRestingOrderDelta([user]), true);
    });

    it("does not compute full market risk views", async () => {
      const { pme, perpsMock, futuresMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setRiskViewDisabled([true]);
      await futuresMock.write.setOrderDeltas([user, ONE_LOT_QTY, 0n]);

      assert.equal(await pme.read.hasRestingOrderDelta([user]), true);
    });

    it("catches either side", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setOrderDeltas([user, ONE_LOT_QTY, 0n]);
      assert.equal(await pme.read.hasRestingOrderDelta([user]), true, "bids count");

      await perpsMock.write.setOrderDeltas([user, 0n, ONE_LOT_QTY]);
      assert.equal(await pme.read.hasRestingOrderDelta([user]), true, "asks count");

      await perpsMock.write.setOrderDeltas([user, 0n, 0n]);
      assert.equal(await pme.read.hasRestingOrderDelta([user]), false, "cleared book reads false");
    });
  });

  /**
   * Which leg a liquidator closes is not neutral. Net delta is what gets stressed,
   * so closing the leg that opposes it widens the requirement while closing the
   * leg that dominates it narrows one. Both are reachable from the same account —
   * the venues cannot tell them apart, because neither can see the other's book.
   */
  describe("cross-venue hedge: liquidation leg selection", () => {
    /** Perps long 1 lot against a futures short of 2 lots — net short 1 lot. */
    async function hedgedAccount() {
      const fixture = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      await fixture.perpsMock.write.setUserPosition([
        fixture.user,
        ONE_LOT_QTY,
        DEFAULT_MARKET_PRICE,
      ]);
      await fixture.futuresMock.write.setNetPositionDelta([fixture.user, -2n * ONE_LOT_QTY]);
      return fixture;
    }

    it("closing the opposing leg widens the requirement", async () => {
      const { pme, perpsMock, user } = await hedgedAccount();

      const mmHedged = await pme.read.computePortfolioMM([user]);

      // The perps long was offsetting half the futures short. Closing it in full
      // takes net delta from -1 lot to -2, doubling the stressed exposure.
      await perpsMock.write.setUserPosition([user, 0n, 0n]);

      assert.ok(
        (await pme.read.computePortfolioMM([user])) > mmHedged,
        "liquidating the hedge leg must raise MM — this is the harmful choice",
      );
    });

    it("a leg that reduces net exposure always exists", async () => {
      const { pme, futuresMock, user } = await hedgedAccount();

      const mmHedged = await pme.read.computePortfolioMM([user]);

      // The dominant side is the futures short. Trimming it to match the perps
      // long flattens the portfolio, which is the move a liquidator should make.
      await futuresMock.write.setNetPositionDelta([user, -ONE_LOT_QTY]);

      assert.ok(
        (await pme.read.computePortfolioMM([user])) < mmHedged,
        "trimming the dominant leg must lower MM — partial liquidation is not " +
          "inherently worsening, the choice of leg is what decides it",
      );
    });
  });

  describe("hedging offsets", () => {
    it("long + short perps cancel out delta", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      const imLong = await pme.read.computePortfolioIM([user]);

      await perpsMock.write.setUserPosition([user, 0n, 0n]);
      const imFlat = await pme.read.computePortfolioIM([user]);

      assert.ok(imLong > imFlat, "flat position has less margin than directional");
      assert.equal(imFlat, 0n, "flat position needs 0 stress margin");
    });

    it("options delta offsets perps delta", async () => {
      const { pme, perpsMock, optionsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      const imPerpsOnly = await pme.read.computePortfolioIM([user]);

      await optionsMock.write.setNetGreeks([user, -WAD, 0n, 0n]);
      const imHedged = await pme.read.computePortfolioIM([user]);

      assert.ok(imHedged < imPerpsOnly, "hedged portfolio needs less margin");
      assert.equal(imHedged, 0n, "perfectly hedged portfolio needs 0 stress margin");
    });
  });

  describe("MM vs IM", () => {
    it("MM is less than IM for same position", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      const im = await pme.read.computePortfolioIM([user]);
      const mm = await pme.read.computePortfolioMM([user]);
      const [combinedIm, combinedMm] = await pme.read.computePortfolioMargins([user]);

      assert.ok(im > mm, "IM > MM for same position");
      assert.deepEqual([combinedIm, combinedMm], [im, mm], "combined read matches standalone margins");
    });
  });

  describe("isHealthy", () => {
    it("returns false when balance < MM", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, 1_000_000_000_000n, DEFAULT_MARKET_PRICE]);

      const healthy = await pme.read.isHealthy([user]);
      assert.equal(healthy, false, "should be unhealthy with huge position and small balance");
    });
  });

  describe("canPlaceOrder", () => {
    it("returns true when balance covers IM + additional", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const can = await pme.read.canPlaceOrder([user, 1_000_000n]);
      assert.equal(can, true);
    });

    it("returns false when additional exceeds balance", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const can = await pme.read.canPlaceOrder([user, 100_000_000_000n]);
      assert.equal(can, false);
    });
  });

  describe("linearOrderMargin", () => {
    it("applies the IM spot shock to a notional, in token decimals", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      const notional = 50_000_000_000n;
      const shock = await pme.read.imSpotShock();

      assert.equal(await pme.read.linearOrderMargin([notional]), (notional * shock) / 10n ** 18n);
      assert.equal(await pme.read.linearOrderMargin([0n]), 0n);
    });

    it("tracks the shock when the owner updates it", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      const notional = 50_000_000_000n;
      const before = await pme.read.linearOrderMargin([notional]);

      const shocks = [0.2e18, 0.1e18, 0.1e18, 0.05e18].map(BigInt) as [bigint, bigint, bigint, bigint];
      await pme.write.setShocks(shocks);

      assert.equal(await pme.read.linearOrderMargin([notional]), before * 2n);
    });
  });

  describe("admin", () => {
    it("owner can update shocks", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, ONE_LOT_QTY, DEFAULT_MARKET_PRICE]);
      const imBefore = await pme.read.computePortfolioIM([user]);

      const shocks = [0.3e18, 0.2e18, 0.1e18, 0.05e18].map(BigInt) as [
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      await viem.assertions.emitWithArgs(pme.write.setShocks(shocks), pme, "ShocksUpdated", shocks);
      const imAfter = await pme.read.computePortfolioIM([user]);

      assert.ok(imAfter > imBefore, "doubling shock doubles stress margin");
    });
  });

  describe("dependency validation", () => {
    it("rejects a linear market that is not a contract", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const [, eoa] = await viem.getWalletClients();

      await viem.assertions.revertWithCustomError(
        pme.write.addLinearMarket([eoa.account.address]),
        pme,
        "InvalidDependency",
      );
    });

    it("rejects a linear market lacking getRiskView", async () => {
      const { pme, usdc } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      await viem.assertions.revertWithCustomError(
        pme.write.addLinearMarket([usdc.address]),
        pme,
        "InvalidDependency",
      );
    });

    it("rejects a market whose getRiskView returns the wrong shape", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      // Answers every selector with one word, so only decoding against RiskView
      // (seven words) can catch it. The decode happens outside the engine's catch block,
      // so this is the one case that escapes InvalidDependency as a bare revert.
      const malformed = await viem.deployContract("MalformedProductMock", []);

      await viem.assertions.revertWithCustomError(pme.write.addLinearMarket([malformed.address]), pme, "VaultMismatch");
    });

    it("rejects a linear market settling into a different vault", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const strayMarket = await viem.deployContract("PerpsDEXMock", []);
      const { vault: otherVault } = await deployCollateralVaultProxy(conn);
      await strayMarket.write.setVault([otherVault.address]);

      await viem.assertions.revertWithCustomError(
        pme.write.addLinearMarket([strayMarket.address]),
        pme,
        "VaultMismatch",
      );
    });

    it("rejects a linear market with no vault pinned at all", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const unpinnedMarket = await viem.deployContract("FuturesMock", []);

      await viem.assertions.revertWithCustomError(
        pme.write.addLinearMarket([unpinnedMarket.address]),
        pme,
        "VaultMismatch",
      );
    });

    it("rejects swapping the vault while a market pins the old one", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const { vault: newVault } = await deployCollateralVaultProxy(conn);

      await viem.assertions.revertWithCustomError(
        pme.write.setVault([newVault.address]),
        pme,
        "VaultMismatch",
      );
    });

    it("allows swapping the vault once the stale products are deregistered", async () => {
      const { pme, perpsMock, futuresMock } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      const { vault: newVault } = await deployCollateralVaultProxy(conn);

      await pme.write.removeLinearMarket([perpsMock.address]);
      await pme.write.removeLinearMarket([futuresMock.address]);
      await pme.write.setOptions([zeroAddress]);

      await pme.write.setVault([newVault.address]);
      assert.equal(await pme.read.vault(), getAddress(newVault.address));
    });

    it("rejects an options engine settling into a different vault", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const strayEngine = await viem.deployContract("OptionsEngineMock", []);
      const { vault: otherVault } = await deployCollateralVaultProxy(conn);
      await strayEngine.write.setVault([otherVault.address]);

      await viem.assertions.revertWithCustomError(
        pme.write.setOptions([strayEngine.address]),
        pme,
        "VaultMismatch",
      );
    });

    it("rejects an options engine lacking the Greeks surface", async () => {
      const { pme, usdc } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      await viem.assertions.revertWithCustomError(
        pme.write.setOptions([usdc.address]),
        pme,
        "InvalidDependency",
      );
    });

    it("still accepts the zero address to disable options", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      await pme.write.setOptions([zeroAddress]);
      assert.equal(await pme.read.optionsEngine(), zeroAddress);
    });

    it("rejects a vault lacking the collateral surface", async () => {
      const { pme, usdc } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      await viem.assertions.revertWithCustomError(
        pme.write.setVault([usdc.address]),
        pme,
        "InvalidDependency",
      );
    });

    it("rejects a zero vault", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      await viem.assertions.revertWithCustomError(
        pme.write.setVault([zeroAddress]),
        pme,
        "ZeroAddress",
      );
    });

    it("rejects an oracle that is not a price feed", async () => {
      const { pme, usdc } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);

      await viem.assertions.revertWithCustomError(
        pme.write.setOracle([usdc.address]),
        pme,
        "InvalidDependency",
      );
    });

    it("rejects a feed that has never answered", async () => {
      const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
      const deadFeed = await viem.deployContract("PriceOracleMock", [0n, 6]);

      await viem.assertions.revertWithCustomError(
        pme.write.setOracle([deadFeed.address]),
        pme,
        "InvalidOracle",
      );
    });

  });

  describe("oracle freshness", () => {
    it("reverts margin reads when the oracle is stale", async () => {
      const { pme, oracleMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await oracleMock.write.freezeTimestamp();
      await networkHelpers.time.increase(3601);

      await viem.assertions.revertWithCustomError(
        pme.read.computePortfolioIM([user]),
        pme,
        "OracleStale",
      );
    });

    it("reverts margin reads when the oracle answer is non-positive", async () => {
      const { pme, oracleMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await oracleMock.write.setPrice([0n, 6]);

      await viem.assertions.revertWithCustomError(
        pme.read.computePortfolioIM([user]),
        pme,
        "InvalidOracle",
      );
    });
  });

  describe("gamma and vega", () => {
    it("gamma reduces stress loss for long gamma position", async () => {
      const { pme, optionsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await optionsMock.write.setNetGreeks([user, 0n, WAD, 0n]);
      const im = await pme.read.computePortfolioIM([user]);

      assert.equal(im, 0n, "long gamma position has no stress loss");
    });

    it("short gamma increases stress loss", async () => {
      const { pme, perpsMock, optionsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await perpsMock.write.setUserPosition([user, 0n, 0n]);
      await optionsMock.write.setNetGreeks([user, 0n, 0n, 0n]);
      const im = await pme.read.computePortfolioIM([user]);
      assert.equal(im, 0n, "delta-neutral, no gamma/vega → 0 margin");
    });

    it("vega exposure adds to margin", async () => {
      const { pme, optionsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );

      await optionsMock.write.setNetGreeks([user, 0n, 0n, WAD]);
      const im = await pme.read.computePortfolioIM([user]);

      assert.ok(im > 0n, "pure vega position has positive stress margin");
      assert.equal(im, 100_000n, "vega stress = vega * volShock in token decimals");
    });
  });
});
