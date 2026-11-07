import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { DEFAULT_MARKET_PRICE, deployPortfolioMarginEngineFixture, LOT_QTY } from "./fixtures.js";

const { networkHelpers } = await network.connect();

const WAD = 10n ** 18n;
const QTY_SCALE = 1_000_000n;
/** A mark at half the index, as a perps glide nears a halving. */
const HALF_MARK = DEFAULT_MARKET_PRICE / 2n;

async function fixture() {
  const ctx = await networkHelpers.loadFixture(deployPortfolioMarginEngineFixture);
  const imShock = await ctx.pme.read.imSpotShock();
  /** IM spot stress of an exposure (token decimals). */
  const stress = (exposure: bigint) => ((exposure < 0n ? -exposure : exposure) * imShock) / WAD;
  return { ...ctx, stress };
}

describe("N24: the engine stresses each market's exposure at its own mark", () => {
  it("values a position at its market's mark, not the index", async () => {
    const { pme, perpsMock, user, stress } = await fixture();
    await perpsMock.write.setMarkPrice([HALF_MARK]);
    await perpsMock.write.setUserPosition([user, LOT_QTY, HALF_MARK]);

    assert.equal(await pme.read.computePortfolioIM([user]), stress((LOT_QTY * HALF_MARK) / QTY_SCALE));
  });

  it("does not net a long marked at half the index against a short at the index", async () => {
    const { pme, perpsMock, futuresMock, user, stress } = await fixture();
    await perpsMock.write.setMarkPrice([HALF_MARK]);
    await perpsMock.write.setUserPosition([user, LOT_QTY, HALF_MARK]);
    // FuturesMock has no exposure view: the engine values its delta at the index.
    await futuresMock.write.setNetPositionDelta([user, -LOT_QTY]);

    const exposure = (LOT_QTY * HALF_MARK) / QTY_SCALE - (LOT_QTY * DEFAULT_MARKET_PRICE) / QTY_SCALE;
    assert.equal(await pme.read.computePortfolioIM([user]), stress(exposure));
  });

  it("values resting orders at their market's mark", async () => {
    const { pme, perpsMock, user, stress } = await fixture();
    await perpsMock.write.setMarkPrice([HALF_MARK]);
    await perpsMock.write.setOrderDeltas([user, LOT_QTY, 0n]);

    assert.equal(await pme.read.computePortfolioIM([user]), stress((LOT_QTY * HALF_MARK) / QTY_SCALE));
  });

  it("values a market without the exposure view at the index, as before", async () => {
    const { pme, perpsMock, user, stress } = await fixture();
    await perpsMock.write.setUserPosition([user, LOT_QTY, DEFAULT_MARKET_PRICE]);

    assert.equal(await pme.read.computePortfolioIM([user]), stress((LOT_QTY * DEFAULT_MARKET_PRICE) / QTY_SCALE));
  });
});
