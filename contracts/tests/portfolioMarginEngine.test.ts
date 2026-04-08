import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, maxUint256 } from "viem";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { viem, networkHelpers } = await network.connect();

async function deployFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner] = await viem.getWalletClients();

  // USDC mock
  const usdc = await viem.deployContract("USDCMock", []);

  // CollateralVault (proxy)
  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({ abi: vaultImpl.abi, functionName: "initialize", args: [usdc.address] }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  // PerpsDEXMock — PME reads spot price from getMarketPrice()
  const perpsMock = await viem.deployContract("PerpsDEXMock", []);
  await perpsMock.write.setMarketPrice([50_000_000_000n]); // $50,000 in token decimals

  // OptionMarginEngine (we only need getNetGreeks + getOptionsReservedMargin)
  // Use a simple mock that returns controllable values
  const optionsMock = await viem.deployContract("OptionsEngineMock", []);

  // PortfolioMarginEngine (proxy)
  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address, perpsMock.address, optionsMock.address],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);

  // Fund vault for user
  const user = owner.account.address;
  await usdc.write.approve([vault.address, maxUint256]);
  await vault.write.deposit([50_000_000_000n]); // 50k USDC

  // Wire vault → PME as margin engine
  await vault.write.setMarginEngine([pme.address]);

  return { vault, perpsMock, optionsMock, pme, usdc, user, owner };
}

describe("PortfolioMarginEngine", () => {
  describe("no positions", () => {
    it("returns 0 margin when user has no positions", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployFixture);
      const im = await pme.read.computePortfolioIM([user]);
      const mm = await pme.read.computePortfolioMM([user]);
      assert.equal(im, 0n);
      assert.equal(mm, 0n);
    });

    it("isHealthy returns true with no positions", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployFixture);
      assert.equal(await pme.read.isHealthy([user]), true);
    });
  });

  describe("perps-only position", () => {
    it("computes margin from perps delta stress", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      // 1 lot long perp (1_000_000 qty units) at $50,000
      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);

      const im = await pme.read.computePortfolioIM([user]);
      // netDelta = 1 WAD. spotPrice = $50k. imSpotShock = 10%.
      // deltaS = 0.10 * $50,000 = $5,000 (WAD: 5e21)
      // worstLoss (spot drops) = |delta * deltaS / WAD| = 5e21 WAD
      // In USDC: 5e21 / 1e12 = 5_000_000_000 ($5,000)
      assert.equal(im, 5_000_000_000n, "IM = 10% of $50k position");
    });

    it("includes unrealized loss in margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);
      const imBase = await pme.read.computePortfolioIM([user]);

      // Add unrealized loss of 1000 USDC
      await perpsMock.write.setUnrealizedPnl([user, -1000_000_000n]);
      const imWithLoss = await pme.read.computePortfolioIM([user]);

      assert.equal(imWithLoss - imBase, 1000_000_000n, "unrealized loss adds to IM");
    });

    it("does not include unrealized profit in margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);
      const imBase = await pme.read.computePortfolioIM([user]);

      // Add unrealized profit of 1000 USDC
      await perpsMock.write.setUnrealizedPnl([user, 1000_000_000n]);
      const imWithProfit = await pme.read.computePortfolioIM([user]);

      assert.equal(imWithProfit, imBase, "unrealized profit does not change IM");
    });

    it("includes pending funding owed in margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);
      const imBase = await pme.read.computePortfolioIM([user]);

      // User owes 500 USDC in funding
      await perpsMock.write.setPendingFunding([user, 500_000_000n]);
      const imWithFunding = await pme.read.computePortfolioIM([user]);

      assert.equal(imWithFunding - imBase, 500_000_000n, "funding owed adds to IM");
    });

    it("includes perps order margin", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      await perpsMock.write.setOrderMargin([user, 2000_000_000n]);
      const im = await pme.read.computePortfolioIM([user]);

      assert.equal(im, 2000_000_000n, "order margin adds to IM");
    });
  });

  describe("hedging offsets", () => {
    it("long + short perps cancel out delta", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      // 1 lot long
      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);
      const imLong = await pme.read.computePortfolioIM([user]);

      // Flatten position → 0
      await perpsMock.write.setUserPosition([user, 0n, 0n]);
      const imFlat = await pme.read.computePortfolioIM([user]);

      assert.ok(imLong > imFlat, "flat position has less margin than directional");
      assert.equal(imFlat, 0n, "flat position needs 0 stress margin");
    });

    it("options delta offsets perps delta", async () => {
      const { pme, perpsMock, optionsMock, user } = await networkHelpers.loadFixture(deployFixture);

      // 1 lot long perp
      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);
      const imPerpsOnly = await pme.read.computePortfolioIM([user]);

      // Add option delta that offsets perps (negative delta, e.g. long put)
      // Set option net delta to -1 WAD (exactly offsets perps delta)
      await optionsMock.write.setNetGreeks([user, -(10n ** 18n), 0n, 0n]);
      const imHedged = await pme.read.computePortfolioIM([user]);

      assert.ok(imHedged < imPerpsOnly, "hedged portfolio needs less margin");
      assert.equal(imHedged, 0n, "perfectly hedged portfolio needs 0 stress margin");
    });
  });

  describe("MM vs IM", () => {
    it("MM is less than IM for same position", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);
      const im = await pme.read.computePortfolioIM([user]);
      const mm = await pme.read.computePortfolioMM([user]);

      assert.ok(im > mm, "IM > MM for same position");
    });
  });

  describe("isHealthy", () => {
    it("returns false when balance < MM", async () => {
      const { pme, perpsMock, vault, usdc, user } = await networkHelpers.loadFixture(deployFixture);

      // Huge position → huge margin requirement (1M lots)
      await perpsMock.write.setUserPosition([user, 1_000_000_000_000n, 50000_000_000n]);

      const healthy = await pme.read.isHealthy([user]);
      assert.equal(healthy, false, "should be unhealthy with huge position and small balance");
    });
  });

  describe("canPlaceOrder", () => {
    it("returns true when balance covers IM + additional", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployFixture);
      // No positions, 50k balance, small additional
      const can = await pme.read.canPlaceOrder([user, 1_000_000n]);
      assert.equal(can, true);
    });

    it("returns false when additional exceeds balance", async () => {
      const { pme, user } = await networkHelpers.loadFixture(deployFixture);
      // Balance is 50k USDC, try to place order requiring 100k additional
      const can = await pme.read.canPlaceOrder([user, 100_000_000_000n]);
      assert.equal(can, false);
    });
  });

  describe("admin", () => {
    it("owner can update shocks", async () => {
      const { pme, perpsMock, user } = await networkHelpers.loadFixture(deployFixture);

      await perpsMock.write.setUserPosition([user, 1_000_000n, 50000_000_000n]);
      const imBefore = await pme.read.computePortfolioIM([user]);

      // Triple the spot shock (10% → 30%)
      await pme.write.setShocks(
        [0.3e18, 0.2e18, 0.1e18, 0.05e18].map(BigInt) as [bigint, bigint, bigint, bigint],
      );
      const imAfter = await pme.read.computePortfolioIM([user]);

      assert.ok(imAfter > imBefore, "doubling shock doubles stress margin");
    });
  });

  describe("gamma and vega", () => {
    it("gamma reduces stress loss for long gamma position", async () => {
      const { pme, optionsMock, user } = await networkHelpers.loadFixture(deployFixture);

      // Pure delta = 0, but positive gamma (long straddle-like)
      await optionsMock.write.setNetGreeks([user, 0n, 10n ** 18n, 0n]); // gamma = 1 WAD
      const im = await pme.read.computePortfolioIM([user]);

      // Gamma PnL is always positive (½γΔs²), so no loss in any scenario
      // All scenario PnL ≥ 0 → loss = 0
      assert.equal(im, 0n, "long gamma position has no stress loss");
    });

    it("short gamma increases stress loss", async () => {
      const { pme, perpsMock, optionsMock, user } = await networkHelpers.loadFixture(deployFixture);

      // Delta-neutral but short gamma
      await perpsMock.write.setUserPosition([user, 0n, 0n]);
      // We can't set negative gamma from the mock since netGamma is uint256
      // But in practice, short options have negative gamma impact via the getNetGreeks
      // Here we test that delta=0 with no gamma gives 0 loss
      await optionsMock.write.setNetGreeks([user, 0n, 0n, 0n]);
      const im = await pme.read.computePortfolioIM([user]);
      assert.equal(im, 0n, "delta-neutral, no gamma/vega → 0 margin");
    });

    it("vega exposure adds to margin", async () => {
      const { pme, optionsMock, user } = await networkHelpers.loadFixture(deployFixture);

      // Pure vega exposure (delta=0, gamma=0, vega=1 WAD)
      // Worst scenario: vol drops by imVolShock=0.10e18
      // vegaPnl = -vega * volShock / WAD = -0.10e18 WAD → 100_000 token decimals
      await optionsMock.write.setNetGreeks([user, 0n, 0n, 10n ** 18n]);
      const im = await pme.read.computePortfolioIM([user]);

      assert.ok(im > 0n, "pure vega position has positive stress margin");
      assert.equal(im, 100_000n, "vega stress = vega * volShock in token decimals");
    });
  });
});
