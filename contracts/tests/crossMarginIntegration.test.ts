import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, maxUint256 } from "viem";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { viem, networkHelpers } = await network.connect();

/**
 * Full-stack cross-margin integration test.
 *
 * Deploys: USDC → CollateralVault → PortfolioMarginEngine
 *          + PerpsDEXMock + OptionsEngineMock
 *
 * Tests the end-to-end flow: deposit, positions, margin-gated withdrawals,
 * hedging offsets, and health checks.
 */
async function deployFullStackFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice] = await viem.getWalletClients();

  // ── USDC mock ──
  const usdc = await viem.deployContract("USDCMock", []);

  // ── CollateralVault (proxy) ──
  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({ abi: vaultImpl.abi, functionName: "initialize", args: [usdc.address] }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  // ── Product mocks ──
  const perpsMock = await viem.deployContract("PerpsDEXMock", []);
  await perpsMock.write.setMarketPrice([50_000_000_000n]); // $50k in token decimals
  const optionsMock = await viem.deployContract("OptionsEngineMock", []);

  // ── PortfolioMarginEngine (proxy) ──
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

  // ── Wire: vault → PME as margin engine ──
  await vault.write.setMarginEngine([pme.address]);

  // ── Authorize product mocks as vault callers ──
  await vault.write.setAuthorizedCaller([perpsMock.address, true]);
  await vault.write.setAuthorizedCaller([optionsMock.address, true]);

  // ── Fund Alice ──
  const aliceAddr = alice.account.address;
  await usdc.write.transfer([aliceAddr, 100_000_000_000n], { account: owner.account }); // 100k USDC

  // Alice approves vault
  const usdcAlice = await viem.getContractAt("USDCMock", usdc.address, {
    client: { wallet: alice },
  });
  await usdcAlice.write.approve([vault.address, maxUint256]);

  // Alice deposits 50k
  const vaultAlice = await viem.getContractAt("CollateralVault", vault.address, {
    client: { wallet: alice },
  });
  await vaultAlice.write.deposit([50_000_000_000n]);

  return {
    vault,
    vaultAlice,
    pme,
    perpsMock,
    optionsMock,
    usdc,
    usdcAlice,
    owner,
    alice,
    aliceAddr,
  };
}

describe("Cross-Margin Integration", () => {
  describe("deposit and withdraw with no positions", () => {
    it("allows full withdrawal when no positions", async () => {
      const { vaultAlice, aliceAddr, usdcAlice } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      const balBefore = await usdcAlice.read.balanceOf([aliceAddr]);
      await vaultAlice.write.withdraw([50_000_000_000n]);
      const balAfter = await usdcAlice.read.balanceOf([aliceAddr]);

      assert.equal(balAfter - balBefore, 50_000_000_000n, "full withdrawal succeeds");
    });
  });

  describe("perps-only margin-gated withdrawal", () => {
    it("blocks withdrawal that would breach portfolio IM", async () => {
      const { vaultAlice, perpsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // Alice has 50k USDC. 3 lots at $50k → IM = 3 * 10% * $50k = $15k
      await perpsMock.write.setUserPosition([aliceAddr, 3_000_000n, 50_000_000_000n]);

      // Try to withdraw 40k (would leave 10k, but IM requires 15k)
      await assert.rejects(
        vaultAlice.write.withdraw([40_000_000_000n]),
        (err: Error) => err.message.includes("WithdrawalWouldBreachMargin"),
        "should reject withdrawal that breaches IM",
      );
    });

    it("allows withdrawal that stays above portfolio IM", async () => {
      const { vaultAlice, perpsMock, aliceAddr, usdcAlice } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // 3 lots → IM = $15k
      await perpsMock.write.setUserPosition([aliceAddr, 3_000_000n, 50_000_000_000n]);

      // Withdraw 30k (leaves 20k, above 15k IM)
      const balBefore = await usdcAlice.read.balanceOf([aliceAddr]);
      await vaultAlice.write.withdraw([30_000_000_000n]);
      const balAfter = await usdcAlice.read.balanceOf([aliceAddr]);

      assert.equal(balAfter - balBefore, 30_000_000_000n, "partial withdrawal succeeds");
    });
  });

  describe("cross-product hedging", () => {
    it("hedged portfolio allows larger withdrawal than unhedged", async () => {
      const { vaultAlice, perpsMock, optionsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // 3 lots long perp → IM = $15k
      await perpsMock.write.setUserPosition([aliceAddr, 3_000_000n, 50_000_000_000n]);

      // Unhedged: can't withdraw 40k (remaining $10k < $15k IM)
      await assert.rejects(vaultAlice.write.withdraw([40_000_000_000n]), (err: Error) =>
        err.message.includes("WithdrawalWouldBreachMargin"),
      );

      // Offset with options delta: perpDelta = 3e18, need optionsDelta = -3e18
      const offsetDelta = -(3n * 10n ** 18n);
      await optionsMock.write.setNetGreeks([aliceAddr, offsetDelta, 0n, 0n]);

      // Hedged: IM drops to 0, can withdraw 40k
      await vaultAlice.write.withdraw([40_000_000_000n]);

      const remaining = await vaultAlice.read.balanceOf([aliceAddr]);
      assert.equal(remaining, 10_000_000_000n, "10k remains after hedged withdrawal");
    });
  });

  describe("combined perps + options margin components", () => {
    it("aggregates order margin, reserved margin, unrealized loss, and funding", async () => {
      const { pme, perpsMock, optionsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // No directional exposure (no positions) → stress loss = 0
      // But add:
      await perpsMock.write.setOrderMargin([aliceAddr, 5_000_000_000n]); // 5k order margin
      await optionsMock.write.setReservedMargin([aliceAddr, 3_000_000_000n * 10n ** 12n]); // 3k WAD reserved
      await perpsMock.write.setUnrealizedPnl([aliceAddr, -2_000_000_000n]); // 2k loss
      await perpsMock.write.setPendingFunding([aliceAddr, 1_000_000_000n]); // 1k funding owed

      const im = await pme.read.computePortfolioIM([aliceAddr]);
      // 5k + 3k + 2k + 1k = 11k = 11_000_000_000
      assert.equal(im, 11_000_000_000n, "all components aggregate correctly");
    });
  });

  describe("health checks through vault", () => {
    it("PME isHealthy reflects vault balance vs MM", async () => {
      const { pme, perpsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // Healthy: 50k balance, no positions
      assert.equal(await pme.read.isHealthy([aliceAddr]), true);

      // 21 lots → MM = 21 * 5% * $50k = $52.5k > $50k balance → unhealthy
      await perpsMock.write.setUserPosition([aliceAddr, 21_000_000n, 50_000_000_000n]);
      assert.equal(await pme.read.isHealthy([aliceAddr]), false, "unhealthy when MM > balance");
    });
  });

  describe("perps margin considers options positions", () => {
    it("options hedge reduces perps liquidation risk", async () => {
      const { pme, perpsMock, optionsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // 21 lots → MM = $52.5k > $50k balance → unhealthy
      await perpsMock.write.setUserPosition([aliceAddr, 21_000_000n, 50_000_000_000n]);
      assert.equal(await pme.read.isHealthy([aliceAddr]), false, "unhedged = unhealthy");

      // Offset with options delta → portfolio flat → healthy
      // perpDelta = 21e6 * 1e18 / 1e6 = 21e18
      const offsetDelta = -(21n * 10n ** 18n);
      await optionsMock.write.setNetGreeks([aliceAddr, offsetDelta, 0n, 0n]);
      assert.equal(await pme.read.isHealthy([aliceAddr]), true, "hedged = healthy");
    });

    it("options reserved margin restricts perps withdrawal", async () => {
      const { vaultAlice, optionsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // No perps positions, but 40k options reserved margin (WAD)
      await optionsMock.write.setReservedMargin([aliceAddr, 40_000_000_000n * 10n ** 12n]);

      // Try to withdraw 20k (would leave 30k, but IM requires 40k from options reserved)
      await assert.rejects(
        vaultAlice.write.withdraw([20_000_000_000n]),
        (err: Error) => err.message.includes("WithdrawalWouldBreachMargin"),
        "options reserved margin blocks perps-side withdrawal",
      );
    });
  });

  describe("options margin considers perps positions", () => {
    it("perps unrealized loss adds to options margin requirement", async () => {
      const { pme, perpsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      const imBase = await pme.read.computePortfolioIM([aliceAddr]);
      assert.equal(imBase, 0n, "no positions = 0 IM");

      // Perps unrealized loss increases portfolio IM (even with no options)
      await perpsMock.write.setUnrealizedPnl([aliceAddr, -10_000_000_000n]);
      const imWithLoss = await pme.read.computePortfolioIM([aliceAddr]);
      assert.equal(imWithLoss, 10_000_000_000n, "perps loss adds to portfolio IM");
    });

    it("perps order margin adds to options withdrawal gate", async () => {
      const { vaultAlice, perpsMock, aliceAddr } =
        await networkHelpers.loadFixture(deployFullStackFixture);

      // 45k perps order margin
      await perpsMock.write.setOrderMargin([aliceAddr, 45_000_000_000n]);

      // Can't withdraw more than 5k (50k - 45k)
      await assert.rejects(
        vaultAlice.write.withdraw([10_000_000_000n]),
        (err: Error) => err.message.includes("WithdrawalWouldBreachMargin"),
        "perps order margin blocks options-side withdrawal",
      );

      // Can withdraw up to 5k
      await vaultAlice.write.withdraw([5_000_000_000n]);
      const bal = await vaultAlice.read.balanceOf([aliceAddr]);
      assert.equal(bal, 45_000_000_000n);
    });
  });

  describe("ERC20 receipt token", () => {
    it("vault balanceOf matches deposit", async () => {
      const { vault, aliceAddr } = await networkHelpers.loadFixture(deployFullStackFixture);
      const bal = await vault.read.balanceOf([aliceAddr]);
      assert.equal(bal, 50_000_000_000n, "receipt token balance equals deposit");
    });

    it("vault totalSupply tracks deposits", async () => {
      const { vault } = await networkHelpers.loadFixture(deployFullStackFixture);
      const supply = await vault.read.totalSupply();
      assert.equal(supply, 50_000_000_000n, "total supply equals total deposits");
    });

    it("ERC20 transfer is blocked", async () => {
      const { vaultAlice, aliceAddr } = await networkHelpers.loadFixture(deployFullStackFixture);
      const [, , bob] = await viem.getWalletClients();
      await assert.rejects(
        vaultAlice.write.transfer([bob.account.address, 1_000_000n]),
        (err: Error) => err.message.includes("TransferDisabled"),
      );
    });
  });
});
