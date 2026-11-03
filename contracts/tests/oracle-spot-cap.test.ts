import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployPortfolioMarginEngineFixture } from "./fixtures.js";

const { viem, networkHelpers } = await network.connect();

/** The fixture's feed and the engine's cached oracle decimals. */
const FEED_DECIMALS = 6;
const WAD_TO_FEED = 10n ** BigInt(18 - FEED_DECIMALS);

describe("PortfolioMarginEngine spot price cap", () => {
  it("reverts margin reads when the feed is above MAX_SPOT_PRICE, and accepts it at the cap", async () => {
    const { pme, oracleMock, user } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
    const cap = (await pme.read.MAX_SPOT_PRICE()) / WAD_TO_FEED;

    await oracleMock.write.setPrice([cap, FEED_DECIMALS]);
    await pme.read.computePortfolioMargins([user]);

    await oracleMock.write.setPrice([cap + 1n, FEED_DECIMALS]);
    await viem.assertions.revertWithCustomError(pme.read.computePortfolioMargins([user]), pme, "InvalidOracle");
  });

  it("setOracle rejects a feed whose answer is above MAX_SPOT_PRICE", async () => {
    const { pme } = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
    const cap = (await pme.read.MAX_SPOT_PRICE()) / WAD_TO_FEED;
    const feed = await viem.deployContract("PriceOracleMock", [cap + 1n, FEED_DECIMALS]);

    await viem.assertions.revertWithCustomError(pme.write.setOracle([feed.address]), pme, "InvalidOracle");
  });
});
