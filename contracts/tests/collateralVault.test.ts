import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, maxUint256, zeroAddress } from "viem";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { viem, networkHelpers } = await network.connect();

async function deployVaultFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice, bob, engine] = await viem.getWalletClients();

  const usdc = await viem.deployContract("USDCMock", []);
  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [usdc.address],
    }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  const topUp = 100_000_000_000n; // 100k USDC
  for (const w of [alice, bob, engine]) {
    await usdc.write.transfer([w.account.address, topUp], { account: owner.account });
    const usdcAs = await viem.getContractAt("USDCMock", usdc.address, { client: { wallet: w } });
    await usdcAs.write.approve([vault.address, maxUint256]);
  }
  await usdc.write.approve([vault.address, maxUint256], { account: owner.account });

  return { vault, usdc, owner, alice, bob, engine };
}

describe("CollateralVault", () => {
  let vault: Awaited<ReturnType<typeof deployVaultFixture>>["vault"];
  let usdc: Awaited<ReturnType<typeof deployVaultFixture>>["usdc"];
  let owner: Awaited<ReturnType<typeof deployVaultFixture>>["owner"];
  let alice: Awaited<ReturnType<typeof deployVaultFixture>>["alice"];
  let bob: Awaited<ReturnType<typeof deployVaultFixture>>["bob"];
  let engine: Awaited<ReturnType<typeof deployVaultFixture>>["engine"];

  beforeEach(async () => {
    ({ vault, usdc, owner, alice, bob, engine } =
      await networkHelpers.loadFixture(deployVaultFixture));
  });

  // ── Initialization ──────────────────────────────────────────────────────

  describe("initialization", () => {
    it("sets collateral token", async () => {
      const token = await vault.read.collateralToken();
      assert.equal(token.toLowerCase(), usdc.address.toLowerCase());
    });

    it("sets name and symbol", async () => {
      assert.equal(await vault.read.name(), "Titan Collateral");
      assert.equal(await vault.read.symbol(), "tCOL");
    });

    it("starts with zero balances", async () => {
      assert.equal(await vault.read.getBalance([alice.account.address]), 0n);
    });
  });

  // ── Deposit ─────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("mints receipt tokens and pulls USDC", async () => {
      const amount = 1_000_000n; // 1 USDC
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });

      const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
      await aliceVault.write.deposit([amount]);
      const usdcAfter = await usdc.read.balanceOf([alice.account.address]);

      assert.equal(await vault.read.getBalance([alice.account.address]), amount);
      assert.equal(await vault.read.balanceOf([alice.account.address]), amount);
      assert.equal(usdcBefore - usdcAfter, amount);
    });

    it("reverts on zero amount", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await viem.assertions.revertWithCustomError(
        aliceVault.write.deposit([0n]),
        vault,
        "ZeroAmount",
      );
    });

    it("accumulates multiple deposits", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([1_000_000n]);
      await aliceVault.write.deposit([2_000_000n]);
      assert.equal(await vault.read.getBalance([alice.account.address]), 3_000_000n);
    });
  });

  // ── Withdraw ────────────────────────────────────────────────────────────

  describe("withdraw", () => {
    it("burns receipt tokens and returns USDC", async () => {
      const amount = 5_000_000n;
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([amount]);

      const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
      await aliceVault.write.withdraw([3_000_000n]);
      const usdcAfter = await usdc.read.balanceOf([alice.account.address]);

      assert.equal(await vault.read.getBalance([alice.account.address]), 2_000_000n);
      assert.equal(usdcAfter - usdcBefore, 3_000_000n);
    });

    it("reverts on zero amount", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await viem.assertions.revertWithCustomError(
        aliceVault.write.withdraw([0n]),
        vault,
        "ZeroAmount",
      );
    });

    it("reverts on insufficient balance", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([1_000_000n]);
      await viem.assertions.revertWithCustomError(
        aliceVault.write.withdraw([2_000_000n]),
        vault,
        "InsufficientBalance",
      );
    });

    it("allows full withdrawal when no margin engine", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([5_000_000n]);
      await aliceVault.write.withdraw([5_000_000n]);
      assert.equal(await vault.read.getBalance([alice.account.address]), 0n);
    });
  });

  // ── Margin-gated withdrawal ─────────────────────────────────────────────

  describe("margin-gated withdrawal", () => {
    it("blocks withdrawal that would breach margin", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([10_000_000n]);

      // Deploy a mock margin engine that always requires 8M
      const mock = await viem.deployContract("MarginEngineMock", []);
      await vault.write.setMarginEngine([mock.address], { account: owner.account });
      await mock.write.setIM([alice.account.address, 8_000_000n]);

      // Can withdraw 2M (leaves 8M >= 8M required)
      await aliceVault.write.withdraw([2_000_000n]);
      assert.equal(await vault.read.getBalance([alice.account.address]), 8_000_000n);

      // Cannot withdraw 1 more (would leave 7,999,999 < 8M)
      await viem.assertions.revertWithCustomError(
        aliceVault.write.withdraw([1n]),
        vault,
        "WithdrawalWouldBreachMargin",
      );
    });
  });

  // ── ERC20 transfer blocked ──────────────────────────────────────────────

  describe("non-transferable", () => {
    it("reverts on ERC20 transfer", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([1_000_000n]);

      await viem.assertions.revertWithCustomError(
        aliceVault.write.transfer([bob.account.address, 500_000n]),
        vault,
        "TransferDisabled",
      );
    });

    it("reverts on ERC20 transferFrom", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([1_000_000n]);
      await aliceVault.write.approve([bob.account.address, maxUint256]);

      const bobVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: bob },
      });
      await viem.assertions.revertWithCustomError(
        bobVault.write.transferFrom([alice.account.address, bob.account.address, 500_000n]),
        vault,
        "TransferDisabled",
      );
    });
  });

  // ── Authorized transfer/credit/debit ────────────────────────────────────

  describe("authorized operations", () => {
    beforeEach(async () => {
      await vault.write.setAuthorizedCaller([engine.account.address, true], {
        account: owner.account,
      });

      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([10_000_000n]);
    });

    it("transfer moves balance between accounts", async () => {
      const engineVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: engine },
      });
      await engineVault.write.transfer([alice.account.address, bob.account.address, 3_000_000n]);

      assert.equal(await vault.read.getBalance([alice.account.address]), 7_000_000n);
      assert.equal(await vault.read.getBalance([bob.account.address]), 3_000_000n);
    });

    it("transfer reverts on insufficient balance", async () => {
      const engineVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: engine },
      });
      await viem.assertions.revertWithCustomError(
        engineVault.write.transfer([alice.account.address, bob.account.address, 99_000_000n]),
        vault,
        "InsufficientBalance",
      );
    });

    it("credit increases balance", async () => {
      const engineVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: engine },
      });
      await engineVault.write.credit([bob.account.address, 5_000_000n]);
      assert.equal(await vault.read.getBalance([bob.account.address]), 5_000_000n);
    });

    it("debit decreases balance", async () => {
      const engineVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: engine },
      });
      await engineVault.write.debit([alice.account.address, 4_000_000n]);
      assert.equal(await vault.read.getBalance([alice.account.address]), 6_000_000n);
    });

    it("debit reverts on insufficient balance", async () => {
      const engineVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: engine },
      });
      await viem.assertions.revertWithCustomError(
        engineVault.write.debit([alice.account.address, 99_000_000n]),
        vault,
        "InsufficientBalance",
      );
    });

    it("transfer is no-op for zero amount", async () => {
      const engineVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: engine },
      });
      await engineVault.write.transfer([alice.account.address, bob.account.address, 0n]);
      assert.equal(await vault.read.getBalance([alice.account.address]), 10_000_000n);
    });
  });

  // ── Access control ──────────────────────────────────────────────────────

  describe("access control", () => {
    it("unauthorized caller cannot transfer", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await aliceVault.write.deposit([1_000_000n]);

      const bobVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: bob },
      });
      await viem.assertions.revertWithCustomError(
        bobVault.write.transfer([alice.account.address, bob.account.address, 500_000n]),
        vault,
        "NotAuthorized",
      );
    });

    it("unauthorized caller cannot credit", async () => {
      const bobVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: bob },
      });
      await viem.assertions.revertWithCustomError(
        bobVault.write.credit([bob.account.address, 1_000_000n]),
        vault,
        "NotAuthorized",
      );
    });

    it("unauthorized caller cannot debit", async () => {
      const bobVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: bob },
      });
      await viem.assertions.revertWithCustomError(
        bobVault.write.debit([alice.account.address, 1_000_000n]),
        vault,
        "NotAuthorized",
      );
    });

    it("only owner can set authorized caller", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await assert.rejects(aliceVault.write.setAuthorizedCaller([bob.account.address, true]));
    });

    it("only owner can set margin engine", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      await assert.rejects(aliceVault.write.setMarginEngine([bob.account.address]));
    });

    it("cannot set zero address as authorized caller", async () => {
      await viem.assertions.revertWithCustomError(
        vault.write.setAuthorizedCaller([zeroAddress, true], { account: owner.account }),
        vault,
        "ZeroAddress",
      );
    });

    it("can revoke authorized caller", async () => {
      await vault.write.setAuthorizedCaller([engine.account.address, true], {
        account: owner.account,
      });
      await vault.write.setAuthorizedCaller([engine.account.address, false], {
        account: owner.account,
      });

      const engineVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: engine },
      });
      await viem.assertions.revertWithCustomError(
        engineVault.write.credit([alice.account.address, 1_000_000n]),
        vault,
        "NotAuthorized",
      );
    });
  });

  // ── totalSupply tracks deposits ─────────────────────────────────────────

  describe("totalSupply", () => {
    it("tracks total deposited collateral", async () => {
      const aliceVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: alice },
      });
      const bobVault = await viem.getContractAt("CollateralVault", vault.address, {
        client: { wallet: bob },
      });

      await aliceVault.write.deposit([5_000_000n]);
      await bobVault.write.deposit([3_000_000n]);
      assert.equal(await vault.read.totalSupply(), 8_000_000n);

      await aliceVault.write.withdraw([2_000_000n]);
      assert.equal(await vault.read.totalSupply(), 6_000_000n);
    });
  });
});
