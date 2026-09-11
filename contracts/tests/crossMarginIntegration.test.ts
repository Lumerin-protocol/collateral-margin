import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { network } from "hardhat";
import {
  DEFAULT_MARKET_PRICE,
  INTEGRATION_ALICE_DEPOSIT,
  deployCrossMarginIntegrationFixture,
} from "./fixtures.js";

const { viem, networkHelpers } = await network.connect();

/** Perps mock: 3-lot position quantity (1 lot = 1e6 units). */
const THREE_LOTS_QTY = 3_000_000n;
/** Perps mock: 21-lot position quantity. */
const TWENTY_ONE_LOTS_QTY = 21_000_000n;

/**
 * Full-stack cross-margin integration tests: deposit, margin-gated withdrawals,
 * hedging, and health checks across vault + PME + product mocks.
 */
describe("Cross-Margin Integration", () => {
  describe("deposit and withdraw with no positions", () => {
    it("allows full withdrawal when no positions", async () => {
      const { vault, usdc, alice, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      const fullBalance = INTEGRATION_ALICE_DEPOSIT;
      const balBefore = await usdc.read.balanceOf([aliceAddr]);
      await viem.assertions.emitWithArgs(
        vault.write.withdraw([fullBalance], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(aliceAddr), fullBalance, getAddress(alice.account.address)],
      );
      const balAfter = await usdc.read.balanceOf([aliceAddr]);

      assert.equal(balAfter - balBefore, fullBalance, "full withdrawal succeeds");
    });
  });

  describe("perps-only margin-gated withdrawal", () => {
    it("blocks withdrawal that would breach portfolio IM", async () => {
      const { vault, alice, perpsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      // Alice has 50k USDC. 3 lots at $50k → IM = 3 * 10% * $50k = $15k
      await perpsMock.write.setUserPosition([aliceAddr, THREE_LOTS_QTY, DEFAULT_MARKET_PRICE]);

      // Try to withdraw 40k (would leave 10k, but IM requires 15k)
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([40_000_000_000n], { account: alice.account }),
        vault,
        "MarginBreach",
      );
    });

    it("allows withdrawal that stays above portfolio IM", async () => {
      const { vault, usdc, alice, perpsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      const withdrawAmount = 30_000_000_000n;

      // 3 lots → IM = $15k
      await perpsMock.write.setUserPosition([aliceAddr, THREE_LOTS_QTY, DEFAULT_MARKET_PRICE]);

      const balBefore = await usdc.read.balanceOf([aliceAddr]);
      await viem.assertions.emitWithArgs(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(aliceAddr), withdrawAmount, getAddress(aliceAddr)],
      );
      const balAfter = await usdc.read.balanceOf([aliceAddr]);

      assert.equal(balAfter - balBefore, withdrawAmount, "partial withdrawal succeeds");
    });
  });

  describe("cross-product hedging", () => {
    it.only("hedged portfolio allows larger withdrawal than unhedged", async () => {
      const { vault, alice, perpsMock, optionsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      const withdrawAmount = 40_000_000_000n;
      const balanceAfterWithdraw = 10_000_000_000n;

      console.log("alice balance", await vault.read.balanceOf([aliceAddr]));
      console.log("withdraw amount", withdrawAmount);

      // 3 lots long perp → IM = $15k
      await perpsMock.write.setUserPosition([aliceAddr, THREE_LOTS_QTY, DEFAULT_MARKET_PRICE]);

      console.log("alice balance", await vault.read.balanceOf([aliceAddr]));
      console.log("withdraw amount", withdrawAmount);

      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "MarginBreach",
      );

      // Offset with options delta: perpDelta = 3e18, need optionsDelta = -3e18
      await optionsMock.write.setNetGreeks([aliceAddr, -(3n * 10n ** 18n), 0n, 0n]);

      await viem.assertions.emitWithArgs(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(aliceAddr), withdrawAmount, getAddress(alice.account.address)],
      );

      const remaining = await vault.read.balanceOf([aliceAddr]);
      assert.equal(remaining, balanceAfterWithdraw, "10k remains after hedged withdrawal");
    });
  });

  describe("combined perps + options margin components", () => {
    it("aggregates order margin, reserved margin, unrealized loss, and funding", async () => {
      const { pme, perpsMock, optionsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      // 1 lot of resting bids on a flat account → 1e6 × 10% × $50k = $5,000 of stress.
      await perpsMock.write.setOrderDeltas([aliceAddr, 1_000_000n, 0n]);
      await optionsMock.write.setReservedMargin([aliceAddr, 3_000_000_000n * 10n ** 12n]);
      await perpsMock.write.setUnrealizedPnl([aliceAddr, -2_000_000_000n]);
      await perpsMock.write.setPendingFunding([aliceAddr, 1_000_000_000n]);

      const im = await pme.read.computePortfolioIM([aliceAddr]);
      assert.equal(im, 11_000_000_000n, "all components aggregate correctly");
    });
  });

  describe("health checks through vault", () => {
    it("PME isHealthy reflects vault balance vs MM", async () => {
      const { pme, perpsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      assert.equal(await pme.read.isHealthy([aliceAddr]), true);

      await perpsMock.write.setUserPosition([aliceAddr, TWENTY_ONE_LOTS_QTY, DEFAULT_MARKET_PRICE]);
      assert.equal(await pme.read.isHealthy([aliceAddr]), false, "unhealthy when MM > balance");
    });
  });

  describe("perps margin considers options positions", () => {
    it("options hedge reduces perps liquidation risk", async () => {
      const { pme, perpsMock, optionsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      await perpsMock.write.setUserPosition([aliceAddr, TWENTY_ONE_LOTS_QTY, DEFAULT_MARKET_PRICE]);
      assert.equal(await pme.read.isHealthy([aliceAddr]), false, "unhedged = unhealthy");

      await optionsMock.write.setNetGreeks([aliceAddr, -(21n * 10n ** 18n), 0n, 0n]);
      assert.equal(await pme.read.isHealthy([aliceAddr]), true, "hedged = healthy");
    });

    it("options reserved margin restricts perps withdrawal", async () => {
      const { vault, alice, optionsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      await optionsMock.write.setReservedMargin([aliceAddr, 40_000_000_000n * 10n ** 12n]);

      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([20_000_000_000n], { account: alice.account }),
        vault,
        "MarginBreach",
      );
    });
  });

  describe("options margin considers perps positions", () => {
    it("perps unrealized loss adds to options margin requirement", async () => {
      const { pme, perpsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      const imBase = await pme.read.computePortfolioIM([aliceAddr]);
      assert.equal(imBase, 0n, "no positions = 0 IM");

      await perpsMock.write.setUnrealizedPnl([aliceAddr, -10_000_000_000n]);
      const imWithLoss = await pme.read.computePortfolioIM([aliceAddr]);
      assert.equal(imWithLoss, 10_000_000_000n, "perps loss adds to portfolio IM");
    });

    it("perps order margin adds to options withdrawal gate", async () => {
      const { vault, alice, perpsMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      const orderMargin = 45_000_000_000n;
      const maxWithdraw = 5_000_000_000n;
      const excessWithdrawAttempt = 10_000_000_000n;

      // 9 lots of resting bids → 9e6 × 10% × $50k = $45,000 of stress on the buy leg.
      await perpsMock.write.setOrderDeltas([aliceAddr, 9_000_000n, 0n]);

      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([excessWithdrawAttempt], { account: alice.account }),
        vault,
        "MarginBreach",
      );

      await viem.assertions.emitWithArgs(
        vault.write.withdraw([maxWithdraw], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(aliceAddr), maxWithdraw, getAddress(alice.account.address)],
      );
      const bal = await vault.read.balanceOf([aliceAddr]);
      assert.equal(bal, orderMargin);
    });
  });

  describe("futures leg in cross-margin engine", () => {
    // Deltas are pinned in the ILinearMarket token-decimal scale (10^6, USDC);
    // the PME lifts them to its internal WAD scale. A delta of 7e6 (7 contracts)
    // at $50k spot with 10% IM stress = $35k loss, i.e. 35_000_000_000 token
    // units (6 decimals).
    const ONE_WEEK_DELTA = 7n * 10n ** 6n;
    const SEVEN_DAY_LONG_IM = 35_000_000_000n; // |7e6| * 10% * $50k → 35k USDC
    const SEVEN_DAY_LONG_MM = 17_500_000_000n; // 5% MM = 17.5k USDC

    it("futures-only IM gates withdrawal", async () => {
      const { vault, alice, futuresMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      // Alice has 50k USDC. One 7-contract long → IM = $35k.
      // Withdrawing 30k would leave 20k < 35k IM, so it must revert.
      await futuresMock.write.setNetPositionDelta([aliceAddr, ONE_WEEK_DELTA]);

      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([30_000_000_000n], { account: alice.account }),
        vault,
        "MarginBreach",
      );
    });

    it("perps long offsets futures short net delta in stress test", async () => {
      const { vault, alice, perpsMock, futuresMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      const withdrawAmount = 40_000_000_000n;

      // Pure futures short → IM = $35k → withdraw 40k must fail.
      await futuresMock.write.setNetPositionDelta([aliceAddr, -ONE_WEEK_DELTA]);
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "MarginBreach",
      );

      // Add a perp long that offsets the futures short delta-for-delta. With
      // net portfolio delta ≈ 0 the stress loss collapses, so 40k withdraw
      // succeeds (only the perp's order/position add-ons remain — both zero).
      // Perp delta = qty * 10^6 / 10^QUANTITY_DECIMALS = qty (both 6 decimals),
      // so qty = 7_000_000 offsets the 7e6 futures delta.
      await perpsMock.write.setUserPosition([aliceAddr, 7_000_000n, DEFAULT_MARKET_PRICE]);

      await viem.assertions.emitWithArgs(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(aliceAddr), withdrawAmount, getAddress(alice.account.address)],
      );
    });

    it("sums same-side order delta across futures and perps before stressing", async () => {
      const { pme, perpsMock, futuresMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      const futuresLoss = -2_500_000_000n;
      // 0.8e6 futures + 0.3e6 perps of resting bid delta → 1.1e6 × 10% × $50k = $5,500.
      await futuresMock.write.setOrderDeltas([aliceAddr, 800_000n, 0n]);
      await futuresMock.write.setUnrealizedPnl([aliceAddr, futuresLoss]);
      await perpsMock.write.setOrderDeltas([aliceAddr, 300_000n, 0n]);

      const im = await pme.read.computePortfolioIM([aliceAddr]);
      assert.equal(im, 5_500_000_000n + 2_500_000_000n, "one stress leg over the summed delta");
    });

    it("charges a perps ask that a futures long makes risk-increasing at the portfolio", async () => {
      const { pme, perpsMock, futuresMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      // Long 1e6 futures, short 1e6 perps: flat at the portfolio, so no stress.
      await futuresMock.write.setNetPositionDelta([aliceAddr, 1_000_000n]);
      await perpsMock.write.setUserPosition([aliceAddr, -1_000_000n, DEFAULT_MARKET_PRICE]);
      assert.equal(await pme.read.computePortfolioIM([aliceAddr]), 0n, "hedged portfolio is flat");

      // A resting perps ask looks risk-reducing to nobody once netted: filling it takes
      // the portfolio to genuinely short 1e6. The old per-venue credit charged 0 here.
      await perpsMock.write.setOrderDeltas([aliceAddr, 0n, 1_000_000n]);
      assert.equal(
        await pme.read.computePortfolioIM([aliceAddr]),
        5_000_000_000n,
        "sell leg stresses the post-fill short",
      );
      assert.equal(await pme.read.orderMarginOf([aliceAddr]), 5_000_000_000n);
    });

    it("PME isHealthy reflects futures-driven MM breach", async () => {
      const { pme, futuresMock, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );

      assert.equal(await pme.read.isHealthy([aliceAddr]), true, "no positions = healthy");

      // 7-contract long → MM = 5% * $50k = $17.5k (well under 50k balance).
      await futuresMock.write.setNetPositionDelta([aliceAddr, ONE_WEEK_DELTA]);
      assert.equal(await pme.read.isHealthy([aliceAddr]), true, "small futures MM still healthy");
      assert.ok(SEVEN_DAY_LONG_MM < INTEGRATION_ALICE_DEPOSIT);
      assert.ok(SEVEN_DAY_LONG_IM < INTEGRATION_ALICE_DEPOSIT);

      // Scale the delta until MM exceeds 50k. 5e7 delta * 5% * $50k = $125k.
      await futuresMock.write.setNetPositionDelta([aliceAddr, 5n * 10n ** 7n]);
      assert.equal(
        await pme.read.isHealthy([aliceAddr]),
        false,
        "large futures delta pushes MM > balance",
      );
    });
  });

  describe("ERC20 receipt token", () => {
    it("vault balanceOf matches deposit", async () => {
      const { vault, aliceAddr } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );
      const bal = await vault.read.balanceOf([aliceAddr]);
      assert.equal(bal, INTEGRATION_ALICE_DEPOSIT, "receipt token balance equals deposit");
    });

    it("vault totalSupply tracks deposits", async () => {
      const { vault } = await networkHelpers.loadFixture(deployCrossMarginIntegrationFixture);
      const supply = await vault.read.totalSupply();
      assert.equal(supply, INTEGRATION_ALICE_DEPOSIT, "total supply equals total deposits");
    });

    it("ERC20 transfer is blocked", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(
        deployCrossMarginIntegrationFixture,
      );
      const [, , bob] = await viem.getWalletClients();
      await viem.assertions.revertWithCustomError(
        //@ts-expect-error — intentionally calling the blocked ERC20 transfer(address,uint256) overload
        vault.write.transfer([bob.account.address, 1_000_000n], { account: alice.account }),
        vault,
        "FunctionDisabled",
      );
    });
  });
});
