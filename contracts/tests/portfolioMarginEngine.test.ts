import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { DEFAULT_MARKET_PRICE, deployPortfolioMarginEngineFixture } from "./fixtures.js";

const { viem, networkHelpers } = await network.connect();

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

    it("includes perps order margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(
        deployPortfolioMarginEngineFixture,
      );
      const orderMargin = 2_000_000_000n;

      await perpsMock.write.setOrderMargin([user, orderMargin]);
      const im = await pme.read.computePortfolioIM([user]);

      assert.equal(im, orderMargin, "order margin adds to IM");
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

      assert.ok(im > mm, "IM > MM for same position");
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
