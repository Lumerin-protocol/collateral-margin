import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, maxUint256, parseEventLogs, zeroAddress } from "viem";
import { network } from "hardhat";
import {
  VAULT_AUTH_OPS_ALICE_DEPOSIT,
  deployCollateralVaultProxy,
  deployVaultAuthorizedOperationsFixture,
  deployVaultFixture,
} from "./fixtures.js";

const conn = await network.connect();
const { viem, networkHelpers } = conn;

/** 1 USDC (6 decimals). Shared across deposit / access-control setup tests. */
const ONE_USDC = 1_000_000n;
/** 0.5 USDC — blocked ERC20 transfer amounts. */
const HALF_USDC = 500_000n;
/** Deliberately larger than Alice's balance in authorized-ops tests. */
const EXCESSIVE_DEBIT = 99_000_000n;

describe("CollateralVault", () => {
  // ── Initialization ──────────────────────────────────────────────────────

  describe("initialization", () => {
    it("sets collateral token", async () => {
      const { vault, usdc } = await networkHelpers.loadFixture(deployVaultFixture);
      const token = await vault.read.collateralToken();
      assert.equal(token.toLowerCase(), usdc.address.toLowerCase());
    });

    it("sets name and symbol", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      assert.equal(await vault.read.name(), "Titan Collateral");
      assert.equal(await vault.read.symbol(), "tCOL");
    });

    it("starts with zero balances", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
    });
  });

  // ── Deposit ─────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("mints receipt tokens and pulls USDC", async () => {
      const { vault, usdc, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const amount = ONE_USDC;

      const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
      await viem.assertions.emitWithArgs(
        vault.write.deposit([amount], { account: alice.account }),
        vault,
        "Deposited",
        [getAddress(alice.account.address), amount, getAddress(alice.account.address)],
      );
      const usdcAfter = await usdc.read.balanceOf([alice.account.address]);

      assert.equal(await vault.read.balanceOf([alice.account.address]), amount);
      assert.equal(await vault.read.balanceOf([alice.account.address]), amount);
      assert.equal(usdcBefore - usdcAfter, amount);
    });

    it("accumulates multiple deposits", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const secondDeposit = 2_000_000n;
      const balanceAfter = ONE_USDC + secondDeposit;

      await vault.write.deposit([ONE_USDC], { account: alice.account });
      await viem.assertions.emitWithArgs(
        vault.write.deposit([secondDeposit], { account: alice.account }),
        vault,
        "Deposited",
        [getAddress(alice.account.address), secondDeposit, getAddress(alice.account.address)],
      );
      assert.equal(await vault.read.balanceOf([alice.account.address]), balanceAfter);
    });
  });

  // ── Withdraw ────────────────────────────────────────────────────────────

  describe("withdraw", () => {
    it("burns receipt tokens and returns USDC", async () => {
      const { vault, usdc, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const depositAmount = 5_000_000n;
      const withdrawAmount = 3_000_000n;
      const balanceAfter = 2_000_000n;

      await vault.write.deposit([depositAmount], { account: alice.account });

      const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
      await viem.assertions.emitWithArgs(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), withdrawAmount, getAddress(alice.account.address)],
      );
      const usdcAfter = await usdc.read.balanceOf([alice.account.address]);

      assert.equal(await vault.read.balanceOf([alice.account.address]), balanceAfter);
      assert.equal(usdcAfter - usdcBefore, withdrawAmount);
    });

    it("reverts on zero amount", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([0n], { account: alice.account }),
        vault,
        "ZeroAmount",
      );
    });

    it("reverts on insufficient balance", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([2_000_000n], { account: alice.account }),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("allows full withdrawal when no margin engine", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const depositAmount = 5_000_000n;

      await vault.write.deposit([depositAmount], { account: alice.account });
      await viem.assertions.emitWithArgs(
        vault.write.withdraw([depositAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), depositAmount, getAddress(alice.account.address)],
      );
      assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
    });
  });

  // ── Margin-gated withdrawal ─────────────────────────────────────────────

  describe("margin engine wiring", () => {
    it("rejects an address holding no code", async () => {
      const { vault,  bob } = await networkHelpers.loadFixture(deployVaultFixture);

      await viem.assertions.revertWithCustomError(
        vault.write.setMarginEngine([bob.account.address]),
        vault,
        "InvalidDependency",
      );
    });

    it("rejects a contract lacking the margin-engine surface", async () => {
      const { vault, usdc } = await networkHelpers.loadFixture(deployVaultFixture);

      await viem.assertions.revertWithCustomError(
        vault.write.setMarginEngine([usdc.address]),
        vault,
        "InvalidDependency",
      );
    });

    it("rejects an engine aggregating a different vault", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      const { vault: otherVault } = await deployCollateralVaultProxy(conn);
      const strayEngine = await viem.deployContract("MarginEngineMock", []);
      await strayEngine.write.setVault([otherVault.address]);

      await viem.assertions.revertWithCustomError(
        vault.write.setMarginEngine([strayEngine.address], ),
        vault,
        "VaultMismatch",
      );
    });

    it("accepts an engine aggregating this vault", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      const engine = await viem.deployContract("MarginEngineMock", []);
      await engine.write.setVault([vault.address]);

      await vault.write.setMarginEngine([engine.address], );
      assert.equal(await vault.read.marginEngine(), getAddress(engine.address));
    });

    it("still allows clearing the engine to ungate withdrawals", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      const engine = await viem.deployContract("MarginEngineMock", []);
      await engine.write.setVault([vault.address]);
      await vault.write.setMarginEngine([engine.address], );

      await vault.write.setMarginEngine([zeroAddress], );
      assert.equal(await vault.read.marginEngine(), zeroAddress);
    });
  });

  describe("margin-gated withdrawal", () => {
    it("blocks withdrawal that would breach margin", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const aliceDeposit = 10_000_000n;
      const requiredIm = 8_000_000n;
      const withdrawAmount = 2_000_000n;

      await vault.write.deposit([aliceDeposit], { account: alice.account });

      const mock = await viem.deployContract("MarginEngineMock", []);
      // The vault only adopts an engine that aggregates it.
      await mock.write.setVault([vault.address]);
      await viem.assertions.emitWithArgs(
        vault.write.setMarginEngine([mock.address], ),
        vault,
        "MarginEngineSet",
        [getAddress(mock.address)],
      );
      await mock.write.setIM([alice.account.address, requiredIm]);

      await viem.assertions.emitWithArgs(
        vault.write.withdraw([withdrawAmount], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), withdrawAmount, getAddress(alice.account.address)],
      );
      assert.equal(await vault.read.balanceOf([alice.account.address]), requiredIm);

      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([1n], { account: alice.account }),
        vault,
        "MarginBreach",
      );
    });
  });

  // ── ERC20 transfer blocked ──────────────────────────────────────────────

  describe("non-transferable", () => {
    it("reverts on ERC20 transfer", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        // @ts-expect-error — intentionally calling the blocked ERC20 transfer(address,uint256) overload
        vault.write.transfer([bob.account.address, HALF_USDC], { account: alice.account }),
        vault,
        "FunctionDisabled",
      );
    });

    it("reverts on ERC20 transferFrom", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });
      await viem.assertions.revertWithCustomError(
        // @ts-expect-error — intentionally calling the blocked ERC20 transferFrom(address,address,uint256) overload
        vault.write.approve([bob.account.address, maxUint256], { account: alice.account }),
        vault,
        "FunctionDisabled",
      );
      await viem.assertions.revertWithCustomError(
        // @ts-expect-error — intentionally calling the blocked ERC20 transferFrom(address,address,uint256) overload
        vault.write.transferFrom([alice.account.address, bob.account.address, HALF_USDC], {
          account: bob.account,
        }),
        vault,
        "FunctionDisabled",
      );
    });
  });

  // ── Authorized transfer/credit/debit ────────────────────────────────────

  describe("authorized operations", () => {
    it("transfer moves balance between accounts", async () => {
      const { vault, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const transferAmount = 3_000_000n;
      const aliceAfter = 7_000_000n;
      const bobAfter = 3_000_000n;

      await viem.assertions.emitWithArgs(
        vault.write.internalTransfer([alice.account.address, bob.account.address, transferAmount], {
          account: engine.account,
        }),
        vault,
        "Transfer",
        [getAddress(alice.account.address), getAddress(bob.account.address), transferAmount],
      );

      assert.equal(await vault.read.balanceOf([alice.account.address]), aliceAfter);
      assert.equal(await vault.read.balanceOf([bob.account.address]), bobAfter);
    });

    it("transfer reverts on insufficient balance", async () => {
      const { vault, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      await viem.assertions.revertWithCustomError(
        vault.write.internalTransfer(
          [alice.account.address, bob.account.address, EXCESSIVE_DEBIT],
          {
            account: engine.account,
          },
        ),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("transfer is no-op for zero amount", async () => {
      const { vault, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      await vault.write.internalTransfer([alice.account.address, bob.account.address, 0n], {
        account: engine.account,
      });
      assert.equal(
        await vault.read.balanceOf([alice.account.address]),
        VAULT_AUTH_OPS_ALICE_DEPOSIT,
      );
    });
  });

  // ── Access control ──────────────────────────────────────────────────────

  describe("access control", () => {
    it("unauthorized caller cannot transfer", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await vault.write.deposit([ONE_USDC], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        vault.write.internalTransfer([alice.account.address, bob.account.address, HALF_USDC], {
          account: bob.account,
        }),
        vault,
        "NotAuthorized",
      );
    });

    it("only owner can set authorized caller", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.setAuthorizedCaller([bob.account.address, true], { account: alice.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("only owner can set margin engine", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.setMarginEngine([bob.account.address], { account: alice.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("only owner can withdraw from insurance fund", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([bob.account.address, ONE_USDC], {
          account: alice.account,
        }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("cannot set zero address as authorized caller", async () => {
      const { vault, owner } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.setAuthorizedCaller([zeroAddress, true], { account: owner.account }),
        vault,
        "ZeroAddress",
      );
    });

    it("can revoke authorized caller", async () => {
      const { vault, owner, alice, bob, engine } =
        await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.emitWithArgs(
        vault.write.setAuthorizedCaller([engine.account.address, true], {
          account: owner.account,
        }),
        vault,
        "AuthorizedCallerSet",
        [getAddress(engine.account.address), true],
      );
      await viem.assertions.emitWithArgs(
        vault.write.setAuthorizedCaller([engine.account.address, false], {
          account: owner.account,
        }),
        vault,
        "AuthorizedCallerSet",
        [getAddress(engine.account.address), false],
      );

      await viem.assertions.revertWithCustomError(
        vault.write.internalTransfer([alice.account.address, bob.account.address, ONE_USDC], {
          account: engine.account,
        }),
        vault,
        "NotAuthorized",
      );
    });
  });

  // ── Insurance fund account ──────────────────────────────────────────────

  describe("insurance fund", () => {
    it("exposes a deterministic vanity address", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      const fund = await vault.read.INSURANCE_FUND_ADDR();
      assert.notEqual(fund, zeroAddress);
    });

    it("starts with zero balance", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      assert.equal(await vault.read.insuranceFundBalance(), 0n);
    });

    it("authorized transfer credits insurance fund and balance view reflects it", async () => {
      const { vault, alice, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const fund = await vault.read.INSURANCE_FUND_ADDR();
      const move = 2_000_000n;
      const aliceAfter = VAULT_AUTH_OPS_ALICE_DEPOSIT - move;

      await vault.write.internalTransfer([alice.account.address, fund, move], {
        account: engine.account,
      });
      assert.equal(await vault.read.balanceOf([alice.account.address]), aliceAfter);
      assert.equal(await vault.read.balanceOf([fund]), move);
      assert.equal(await vault.read.insuranceFundBalance(), move);
    });

    it("owner can withdraw from insurance fund", async () => {
      const { vault, owner, alice, bob, engine } = await networkHelpers.loadFixture(
        deployVaultAuthorizedOperationsFixture,
      );
      const fund = await vault.read.INSURANCE_FUND_ADDR();
      const move = 3_000_000n;

      await vault.write.internalTransfer([alice.account.address, fund, move], {
        account: engine.account,
      });
      assert.equal(await vault.read.insuranceFundBalance(), move);

      await viem.assertions.emitWithArgs(
        vault.write.withdrawInsuranceFund([bob.account.address, move], { account: owner.account }),
        vault,
        "InsuranceFundWithdrawn",
        [getAddress(bob.account.address), move],
      );
      assert.equal(await vault.read.insuranceFundBalance(), 0n);
    });

    it("withdrawInsuranceFund reverts on insufficient balance", async () => {
      const { vault, owner, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([bob.account.address, ONE_USDC], {
          account: owner.account,
        }),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("withdrawInsuranceFund reverts on zero amount", async () => {
      const { vault, owner, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([bob.account.address, 0n], { account: owner.account }),
        vault,
        "ZeroAmount",
      );
    });

    it("withdrawInsuranceFund reverts on zero recipient", async () => {
      const { vault, owner } = await networkHelpers.loadFixture(deployVaultFixture);
      // Fund the insurance fund first so the burn succeeds and we reach the token transfer
      await vault.write.depositInsuranceFund([ONE_USDC], {
        account: owner.account,
      });
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([zeroAddress, ONE_USDC], { account: owner.account }),
        vault,
        "ERC20InvalidReceiver",
      );
    });
  });

  // ── depositForPermit ────────────────────────────────────────────────────

  describe("depositForPermit", () => {
    const PERMIT_TYPES = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;

    type VaultFixture = Awaited<ReturnType<typeof deployVaultFixture>>;
    type Wallet = VaultFixture["alice"];
    type Usdc = VaultFixture["usdc"];

    /** Build an ERC-2612 permit signature for {owner=signer | override} → spender. */
    async function buildPermitSig(opts: {
      signer: Wallet;
      usdc: Usdc;
      spender: `0x${string}`;
      value: bigint;
      deadline: bigint;
      /** Override the `owner` field in the typed message (for invalid-signer tests). */
      owner?: `0x${string}`;
    }) {
      const owner = opts.owner ?? opts.signer.account.address;
      const [, name, version, chainId, verifyingContract] = await opts.usdc.read.eip712Domain();
      const nonce = await opts.usdc.read.nonces([owner]);
      const sig = await opts.signer.signTypedData({
        account: opts.signer.account,
        domain: { name, version, chainId, verifyingContract },
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: {
          owner,
          spender: opts.spender,
          value: opts.value,
          nonce,
          deadline: opts.deadline,
        },
      });
      return {
        r: `0x${sig.slice(2, 66)}` as `0x${string}`,
        s: `0x${sig.slice(66, 130)}` as `0x${string}`,
        v: Number.parseInt(sig.slice(130, 132), 16),
      };
    }

    it("permits and deposits in a single tx without prior allowance", async () => {
      const { vault, usdc, owner } = await networkHelpers.loadFixture(deployVaultFixture);
      // Use a wallet that has NOT approved the vault, to prove the permit path is the only
      // thing setting allowance.
      const wallets = await viem.getWalletClients();
      const fresh = wallets[4];
      const amount = 5_000_000n;
      await usdc.write.transfer([fresh.account.address, amount], { account: owner.account });
      assert.equal(await usdc.read.allowance([fresh.account.address, vault.address]), 0n);

      const latest = await networkHelpers.time.latest();
      const deadline = BigInt(latest + 600);
      const { v, r, s } = await buildPermitSig({
        signer: fresh,
        usdc,
        spender: vault.address,
        value: amount,
        deadline,
      });

      await viem.assertions.emitWithArgs(
        vault.write.depositForPermit([fresh.account.address, amount, deadline, v, r, s], {
          account: fresh.account,
        }),
        vault,
        "Deposited",
        [getAddress(fresh.account.address), amount, getAddress(fresh.account.address)],
      );

      assert.equal(await vault.read.balanceOf([fresh.account.address]), amount);
      assert.equal(await usdc.read.balanceOf([fresh.account.address]), 0n);
      // Permit consumed the entire allowance — none left over for replay.
      assert.equal(await usdc.read.allowance([fresh.account.address, vault.address]), 0n);
      assert.equal(await usdc.read.nonces([fresh.account.address]), 1n);
    });

    it("can mint receipt tokens to a different recipient than the signer", async () => {
      const { vault, usdc, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      const amount = 2_000_000n;
      const latest = await networkHelpers.time.latest();
      const deadline = BigInt(latest + 600);

      const { v, r, s } = await buildPermitSig({
        signer: alice,
        usdc,
        spender: vault.address,
        value: amount,
        deadline,
      });

      await viem.assertions.emitWithArgs(
        vault.write.depositForPermit([bob.account.address, amount, deadline, v, r, s], {
          account: alice.account,
        }),
        vault,
        "Deposited",
        [getAddress(bob.account.address), amount, getAddress(alice.account.address)],
      );

      assert.equal(await vault.read.balanceOf([bob.account.address]), amount);
      assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
    });

    it("reverts on expired deadline", async () => {
      const { vault, usdc, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const amount = 1_000_000n;
      const latest = await networkHelpers.time.latest();
      const deadline = BigInt(latest - 1);

      const { v, r, s } = await buildPermitSig({
        signer: alice,
        usdc,
        spender: vault.address,
        value: amount,
        deadline,
      });

      await viem.assertions.revertWithCustomError(
        vault.write.depositForPermit([alice.account.address, amount, deadline, v, r, s], {
          account: alice.account,
        }),
        usdc,
        "ERC2612ExpiredSignature",
      );
    });

    it("reverts when the signature was not produced by msg.sender", async () => {
      const { vault, usdc, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      const amount = 1_000_000n;
      const latest = await networkHelpers.time.latest();
      const deadline = BigInt(latest + 600);

      // Bob signs a permit message that claims owner = alice. The contract calls
      // permit(msg.sender = alice, …) so the recovered signer (bob) won't match owner (alice).
      const { v, r, s } = await buildPermitSig({
        signer: bob,
        usdc,
        spender: vault.address,
        value: amount,
        deadline,
        owner: alice.account.address,
      });

      await viem.assertions.revertWithCustomError(
        vault.write.depositForPermit([alice.account.address, amount, deadline, v, r, s], {
          account: alice.account,
        }),
        usdc,
        "ERC2612InvalidSigner",
      );
    });

    it("reverts on signature replay (nonce already consumed)", async () => {
      const { vault, usdc, alice } = await networkHelpers.loadFixture(deployVaultFixture);
      const amount = 1_000_000n;
      const latest = await networkHelpers.time.latest();
      const deadline = BigInt(latest + 600);

      const { v, r, s } = await buildPermitSig({
        signer: alice,
        usdc,
        spender: vault.address,
        value: amount,
        deadline,
      });

      await vault.write.depositForPermit(
        [alice.account.address, amount, deadline, v, r, s],
        { account: alice.account },
      );

      // Same signature can't be reused: nonce was bumped, so the recovered signer mismatches.
      await viem.assertions.revertWithCustomError(
        vault.write.depositForPermit([alice.account.address, amount, deadline, v, r, s], {
          account: alice.account,
        }),
        usdc,
        "ERC2612InvalidSigner",
      );
    });
  });

  // ── totalSupply tracks deposits ─────────────────────────────────────────

  describe("totalSupply", () => {
    it("tracks total deposited collateral", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(deployVaultFixture);
      const aliceDeposit = 5_000_000n;
      const bobDeposit = 3_000_000n;
      const aliceWithdraw = 2_000_000n;
      const totalAfterDeposits = aliceDeposit + bobDeposit;
      const totalAfterWithdraw = totalAfterDeposits - aliceWithdraw;

      await viem.assertions.emitWithArgs(
        vault.write.deposit([aliceDeposit], { account: alice.account }),
        vault,
        "Deposited",
        [getAddress(alice.account.address), aliceDeposit, getAddress(alice.account.address)],
      );
      await viem.assertions.emitWithArgs(
        vault.write.deposit([bobDeposit], { account: bob.account }),
        vault,
        "Deposited",
        [getAddress(bob.account.address), bobDeposit, getAddress(bob.account.address)],
      );
      assert.equal(await vault.read.totalSupply(), totalAfterDeposits);

      await viem.assertions.emitWithArgs(
        vault.write.withdraw([aliceWithdraw], { account: alice.account }),
        vault,
        "Withdrawn",
        [getAddress(alice.account.address), aliceWithdraw, getAddress(alice.account.address)],
      );
      assert.equal(await vault.read.totalSupply(), totalAfterWithdraw);
    });
  });

  // ── Insurance debt ──────────────────────────────────────────────────────

  describe("insurance debt", () => {
    /** Margin engine on, so the configured cap is the effective cap, and `engine` may settle. */
    async function ready() {
      const ctx = await networkHelpers.loadFixture(deployVaultFixture);
      const margin = await viem.deployContract("MarginEngineMock", []);
      await margin.write.setVault([ctx.vault.address]);
      await ctx.vault.write.setMarginEngine([margin.address], { account: ctx.owner.account });
      await ctx.vault.write.setAuthorizedCaller([ctx.engine.account.address, true], {
        account: ctx.owner.account,
      });
      const fund = await ctx.vault.read.INSURANCE_FUND_ADDR();
      return { ...ctx, margin, fund };
    }

    async function assertInvariants(
      vault: Awaited<ReturnType<typeof ready>>["vault"],
      usdc: Awaited<ReturnType<typeof ready>>["usdc"],
    ) {
      const supply = await vault.read.totalSupply();
      const debt = await vault.read.insuranceDebt();
      const backing = await usdc.read.balanceOf([vault.address]);
      assert.ok(backing >= supply - debt, "USDC must cover supply minus insurance debt");
      if (debt > 0n) {
        assert.equal(await vault.read.insuranceFundBalance(), 0n);
      }
    }

    async function debtSnapshot(vault: Awaited<ReturnType<typeof ready>>["vault"]) {
      return {
        debt: await vault.read.insuranceDebt(),
        uncovered: await vault.read.uncoveredLoss(),
        timing: await vault.read.timingDebt(),
        capital: await vault.read.insuranceCapital(),
        bad: await vault.read.traderBadDebtTotal(),
        halted: await vault.read.halted(),
      };
    }

    it("reports version 1.3.0", async () => {
      const { vault } = await networkHelpers.loadFixture(deployVaultFixture);
      assert.equal(await vault.read.VERSION(), "1.3.0");
    });

    describe("settleTransfer", () => {
      it("moves a trader payment in full when the balance covers it", async () => {
        const { vault, alice, bob, engine } = await ready();
        await vault.write.deposit([100n], { account: alice.account });
        await vault.write.settleTransfer([alice.account.address, bob.account.address, 40n], {
          account: engine.account,
        });
        assert.equal(await vault.read.balanceOf([alice.account.address]), 60n);
        assert.equal(await vault.read.balanceOf([bob.account.address]), 40n);
        assert.equal(await vault.read.traderBadDebtTotal(), 0n);
      });

      it("records a trader shortfall owed to the fund as bad debt", async () => {
        const { vault, alice, engine, fund } = await ready();
        await vault.write.deposit([40n], { account: alice.account });
        await viem.assertions.emitWithArgs(
          vault.write.settleTransfer([alice.account.address, fund, 100n], { account: engine.account }),
          vault,
          "BadDebt",
          [getAddress(alice.account.address), getAddress(fund), 60n, getAddress(engine.account.address)],
        );
        assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
        assert.equal(await vault.read.insuranceFundBalance(), 40n);
        assert.equal(await vault.read.traderBadDebtTotal(), 60n);
        assert.equal(await vault.read.uncoveredLoss(), 60n);
      });

      it("emits fee shortfalls without counting them as reserve losses", async () => {
        const { vault, alice, bob, engine } = await ready();
        await vault.write.deposit([40n], { account: alice.account });
        await viem.assertions.emitWithArgs(
          vault.write.settleTransfer([alice.account.address, bob.account.address, 100n], {
            account: engine.account,
          }),
          vault,
          "BadDebt",
          [
            getAddress(alice.account.address),
            getAddress(bob.account.address),
            60n,
            getAddress(engine.account.address),
          ],
        );
        assert.equal(await vault.read.balanceOf([bob.account.address]), 40n);
        assert.equal(await vault.read.traderBadDebtTotal(), 0n);
        assert.equal(await vault.read.uncoveredLoss(), 0n);
      });

      it("pays from the fund in full when the balance covers it", async () => {
        const { vault, usdc, alice, engine, fund, owner } = await ready();
        await vault.write.depositInsuranceFund([100n], { account: owner.account });
        await vault.write.settleTransfer([fund, alice.account.address, 40n], { account: engine.account });
        assert.equal(await vault.read.balanceOf([alice.account.address]), 40n);
        assert.equal(await vault.read.insuranceFundBalance(), 60n);
        assert.equal(await vault.read.insuranceDebt(), 0n);
        await assertInvariants(vault, usdc);
      });

      it("borrows the fund shortfall and pays the winner in full", async () => {
        const { vault, usdc, alice, engine, fund, owner } = await ready();
        await vault.write.setInsuranceDebtCap([1000n], { account: owner.account });
        await vault.write.depositInsuranceFund([10n], { account: owner.account });
        await vault.write.settleTransfer([fund, alice.account.address, 25n], { account: engine.account });
        assert.equal(await vault.read.balanceOf([alice.account.address]), 25n);
        assert.equal(await vault.read.insuranceFundBalance(), 0n);
        assert.equal(await vault.read.insuranceDebt(), 15n);
        assert.equal(await vault.read.timingDebt(), 15n);
        assert.equal(await vault.read.uncoveredLoss(), 0n);
        assert.equal(await vault.read.halted(), false);
        await assertInvariants(vault, usdc);
      });

      it("pays in full and latches the halt when a borrow crosses the cap", async () => {
        const { vault, usdc, alice, engine, fund, owner } = await ready();
        const pc = await viem.getPublicClient();
        await vault.write.setInsuranceDebtCap([10n], { account: owner.account });
        const hash = await vault.write.settleTransfer([fund, alice.account.address, 15n], {
          account: engine.account,
        });
        const receipt = await pc.waitForTransactionReceipt({ hash });
        const halted = parseEventLogs({ abi: vault.abi, eventName: "VaultHalted", logs: receipt.logs });
        assert.equal(halted.length, 1);
        assert.equal(Number(halted[0].args.reason), 0);
        assert.equal(halted[0].args.debt, 15n);
        assert.equal(halted[0].args.effectiveCap, 10n);
        assert.equal(await vault.read.balanceOf([alice.account.address]), 15n);
        assert.equal(await vault.read.insuranceDebt(), 15n);
        assert.equal(await vault.read.halted(), true);
        await assertInvariants(vault, usdc);
      });

      it("rejects callers that are not authorized", async () => {
        const { vault, alice, bob, fund } = await ready();
        await viem.assertions.revertWithCustomError(
          vault.write.settleTransfer([fund, alice.account.address, 1n], { account: bob.account }),
          vault,
          "NotAuthorized",
        );
      });
    });

    describe("halt", () => {
      it("keeps settling inside the transaction that crossed the cap", async () => {
        const { vault, alice, fund, owner } = await ready();
        await vault.write.setInsuranceDebtCap([10n], { account: owner.account });
        const harness = await viem.deployContract("InsuranceDebtHarness", []);
        await vault.write.setAuthorizedCaller([harness.address, true], { account: owner.account });
        await harness.write.settleTwice([vault.address, fund, alice.account.address, 15n, 5n]);
        assert.equal(await vault.read.balanceOf([alice.account.address]), 20n);
        assert.equal(await vault.read.insuranceDebt(), 20n);
        assert.equal(await vault.read.halted(), true);
      });

      it("rolls the borrow back when a later withdrawal in the same transaction reverts", async () => {
        const { vault, usdc, alice, fund, owner } = await ready();
        await vault.write.setInsuranceDebtCap([10n], { account: owner.account });
        const harness = await viem.deployContract("InsuranceDebtHarness", []);
        await usdc.write.transfer([harness.address, 100n], { account: owner.account });
        await harness.write.approveAndDeposit([usdc.address, vault.address, 100n]);
        await vault.write.setAuthorizedCaller([harness.address, true], { account: owner.account });

        const usdcInVault = await usdc.read.balanceOf([vault.address]);
        const harnessUsdc = await usdc.read.balanceOf([harness.address]);
        await viem.assertions.revertWithCustomError(
          harness.write.settleThenWithdraw([vault.address, fund, alice.account.address, 15n, 1n]),
          vault,
          "Halted",
        );
        assert.equal(await usdc.read.balanceOf([vault.address]), usdcInVault);
        assert.equal(await usdc.read.balanceOf([harness.address]), harnessUsdc);
        assert.equal(await vault.read.balanceOf([alice.account.address]), 0n);
        assert.equal(await vault.read.insuranceDebt(), 0n);
        assert.equal(await vault.read.halted(), false);
      });

      it("blocks withdrawals and still allows deposits, transfers, and further borrowing", async () => {
        const { vault, alice, bob, engine, fund, owner } = await ready();
        await vault.write.setInsuranceDebtCap([10n], { account: owner.account });
        await vault.write.deposit([50n], { account: alice.account });
        await vault.write.deposit([20n], { account: engine.account });
        await vault.write.settleTransfer([fund, bob.account.address, 15n], { account: engine.account });
        assert.equal(await vault.read.halted(), true);

        await viem.assertions.revertWithCustomError(
          vault.write.withdraw([1n], { account: alice.account }),
          vault,
          "Halted",
        );
        await viem.assertions.revertWithCustomError(
          vault.write.withdrawTo([alice.account.address, 1n], { account: engine.account }),
          vault,
          "Halted",
        );

        await vault.write.deposit([5n], { account: alice.account });
        await vault.write.internalTransfer([alice.account.address, bob.account.address, 5n], {
          account: engine.account,
        });
        await vault.write.settleTransfer([fund, bob.account.address, 7n], { account: engine.account });
        assert.equal(await vault.read.insuranceDebt(), 22n);
        assert.equal(await vault.read.halted(), true);
      });

      it("stays halted after repayment brings the debt back under the cap", async () => {
        const { vault, bob, engine, fund, owner } = await ready();
        await vault.write.setInsuranceDebtCap([10n], { account: owner.account });
        await vault.write.settleTransfer([fund, bob.account.address, 15n], { account: engine.account });
        await vault.write.deposit([15n], { account: bob.account });
        await vault.write.settleTransfer([bob.account.address, fund, 15n], { account: engine.account });
        assert.equal(await vault.read.insuranceDebt(), 0n);
        assert.equal(await vault.read.halted(), true);
      });

      it("resume reverts above the cap and clears the halt at or under it", async () => {
        const { vault, engine, fund, owner, bob } = await ready();
        await vault.write.setInsuranceDebtCap([10n], { account: owner.account });
        await vault.write.settleTransfer([fund, bob.account.address, 15n], { account: engine.account });
        await viem.assertions.revertWithCustomError(
          vault.write.resume({ account: owner.account }),
          vault,
          "DebtAboveCap",
        );
        await vault.write.setInsuranceDebtCap([15n], { account: owner.account });
        await vault.write.resume({ account: owner.account });
        assert.equal(await vault.read.halted(), false);
        await vault.write.deposit([5n], { account: bob.account });
        await vault.write.withdraw([1n], { account: bob.account });
      });

      it("restricts halt and resume to the owner", async () => {
        const { vault, alice } = await ready();
        await viem.assertions.revertWithCustomError(
          vault.write.halt({ account: alice.account }),
          vault,
          "OwnableUnauthorizedAccount",
        );
        await viem.assertions.revertWithCustomError(
          vault.write.resume({ account: alice.account }),
          vault,
          "OwnableUnauthorizedAccount",
        );
      });

      it("halts when the margin engine is removed while debt is outstanding", async () => {
        const { vault, margin, engine, fund, owner, bob } = await ready();
        const pc = await viem.getPublicClient();
        await vault.write.setInsuranceDebtCap([100n], { account: owner.account });
        await vault.write.settleTransfer([fund, bob.account.address, 10n], { account: engine.account });
        assert.equal(await vault.read.halted(), false);
        const hash = await vault.write.setMarginEngine([zeroAddress], { account: owner.account });
        const receipt = await pc.waitForTransactionReceipt({ hash });
        const halted = parseEventLogs({ abi: vault.abi, eventName: "VaultHalted", logs: receipt.logs });
        assert.equal(halted.length, 1);
        assert.equal(Number(halted[0].args.reason), 2);
        assert.equal(await vault.read.halted(), true);
        assert.equal(await vault.read.effectiveInsuranceDebtCap(), 0n);
        await viem.assertions.revertWithCustomError(
          vault.write.resume({ account: owner.account }),
          vault,
          "DebtAboveCap",
        );
        await margin.write.setVault([vault.address]);
        await vault.write.setMarginEngine([margin.address], { account: owner.account });
        await vault.write.resume({ account: owner.account });
        assert.equal(await vault.read.halted(), false);
      });

      it("does not halt when the cap is lowered under the current debt", async () => {
        const { vault, engine, fund, owner, bob } = await ready();
        await vault.write.setInsuranceDebtCap([100n], { account: owner.account });
        await vault.write.settleTransfer([fund, bob.account.address, 20n], { account: engine.account });
        await vault.write.setInsuranceDebtCap([5n], { account: owner.account });
        assert.equal(await vault.read.halted(), false);
        assert.equal(await vault.read.insuranceDebt(), 20n);
      });

      it("does not halt when the margin engine is cleared with no debt", async () => {
        const { vault, owner } = await ready();
        await vault.write.setMarginEngine([zeroAddress], { account: owner.account });
        assert.equal(await vault.read.halted(), false);
        assert.equal(await vault.read.effectiveInsuranceDebtCap(), 0n);
      });
    });

    describe("repayment", () => {
      it("repays debt from a trader payment into the fund before the balance can sit there", async () => {
        const { vault, usdc, bob, engine, fund, owner } = await ready();
        await vault.write.setInsuranceDebtCap([1000n], { account: owner.account });
        await vault.write.settleTransfer([fund, bob.account.address, 20n], { account: engine.account });
        await vault.write.deposit([50n], { account: bob.account });
        await vault.write.settleTransfer([bob.account.address, fund, 50n], { account: engine.account });
        assert.equal(await vault.read.insuranceDebt(), 0n);
        assert.equal(await vault.read.insuranceFundBalance(), 30n);
        assert.equal(await vault.read.balanceOf([bob.account.address]), 20n);
        await assertInvariants(vault, usdc);
      });

      it("repays debt from depositInsuranceFund and counts the deposit as capital", async () => {
        const { vault, usdc, bob, engine, fund, owner } = await ready();
        await vault.write.setInsuranceDebtCap([1000n], { account: owner.account });
        await vault.write.settleTransfer([fund, bob.account.address, 20n], { account: engine.account });
        await vault.write.depositInsuranceFund([12n], { account: owner.account });
        assert.equal(await vault.read.insuranceDebt(), 8n);
        assert.equal(await vault.read.insuranceFundBalance(), 0n);
        assert.equal(await vault.read.insuranceCapital(), 12n);
        await assertInvariants(vault, usdc);
      });
    });

    describe("initializeV2", () => {
      it("seeds capital from the existing fund balance and cannot run twice", async () => {
        const { vault, alice, engine, fund, owner } = await ready();
        await vault.write.deposit([100n], { account: alice.account });
        await vault.write.internalTransfer([alice.account.address, fund, 100n], {
          account: engine.account,
        });
        assert.equal(await vault.read.insuranceCapital(), 0n);
        await vault.write.initializeV2({ account: owner.account });
        assert.equal(await vault.read.insuranceCapital(), 100n);
        await viem.assertions.revertWithCustomError(
          vault.write.initializeV2({ account: owner.account }),
          vault,
          "InvalidInitialization",
        );
      });

      it("is owner-only", async () => {
        const { vault, alice } = await ready();
        await viem.assertions.revertWithCustomError(
          vault.write.initializeV2({ account: alice.account }),
          vault,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    it("follows the empty-fund worked example", async () => {
      const { vault, usdc, alice, bob, engine, fund, owner } = await ready();
      const carol = (await viem.getWalletClients())[4];
      await vault.write.setInsuranceDebtCap([1000n], { account: owner.account });

      await vault.write.settleTransfer([fund, alice.account.address, 20n], { account: engine.account });
      let snap = await debtSnapshot(vault);
      assert.deepEqual(snap, {
        debt: 20n,
        uncovered: 0n,
        timing: 20n,
        capital: 0n,
        bad: 0n,
        halted: false,
      });
      await assertInvariants(vault, usdc);

      await vault.write.deposit([50n], { account: bob.account });
      await vault.write.settleTransfer([bob.account.address, fund, 60n], { account: engine.account });
      snap = await debtSnapshot(vault);
      assert.deepEqual(snap, {
        debt: 0n,
        uncovered: 10n,
        timing: 0n,
        capital: 0n,
        bad: 10n,
        halted: false,
      });
      assert.equal(await vault.read.insuranceFundBalance(), 30n);
      await assertInvariants(vault, usdc);

      await vault.write.settleTransfer([fund, carol.account.address, 40n], { account: engine.account });
      snap = await debtSnapshot(vault);
      assert.deepEqual(snap, {
        debt: 10n,
        uncovered: 10n,
        timing: 0n,
        capital: 0n,
        bad: 10n,
        halted: false,
      });
      assert.equal(await vault.read.balanceOf([carol.account.address]), 40n);
      await assertInvariants(vault, usdc);

      await vault.write.depositInsuranceFund([10n], { account: owner.account });
      snap = await debtSnapshot(vault);
      assert.deepEqual(snap, {
        debt: 0n,
        uncovered: 0n,
        timing: 0n,
        capital: 10n,
        bad: 10n,
        halted: false,
      });
      await assertInvariants(vault, usdc);
    });
  });

  // ── Backstop ────────────────────────────────────────────────────────────

  describe("backstop", () => {
    const BACKSTOP = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

    async function ready() {
      const ctx = await networkHelpers.loadFixture(deployVaultFixture);
      await ctx.vault.write.setAuthorizedCaller([ctx.engine.account.address, true], {
        account: ctx.owner.account,
      });
      const fund = await ctx.vault.read.INSURANCE_FUND_ADDR();
      return { ...ctx, fund };
    }

    it("exposes the vanity address and starts unfunded with zero params", async () => {
      const { vault } = await ready();
      assert.equal(await vault.read.BACKSTOP_ADDR(), getAddress(BACKSTOP));
      assert.equal(await vault.read.balanceOf([BACKSTOP]), 0n);
      assert.deepEqual(await vault.read.backstopParams(), [0, 0]);
    });

    it("records an uncoverable backstop loss as trader bad debt", async () => {
      const { vault, engine, fund } = await ready();
      const hash = await vault.write.settleTransfer([BACKSTOP, fund, 40n], { account: engine.account });
      const receipt = await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });
      const [bad] = parseEventLogs({ abi: vault.abi, logs: receipt.logs, eventName: "BadDebt" });
      assert.equal(bad.args.payer, getAddress(BACKSTOP));
      assert.equal(bad.args.amount, 40n);
      assert.equal(await vault.read.traderBadDebtTotal(), 40n);
      assert.equal(await vault.read.uncoveredLoss(), 40n);
      assert.equal(await vault.read.insuranceDebt(), 0n);
    });

    it("pays what it holds first and records only the remainder", async () => {
      const { vault, engine, fund, owner } = await ready();
      await vault.write.depositFor([BACKSTOP, 15n], { account: owner.account });
      await vault.write.settleTransfer([BACKSTOP, fund, 40n], { account: engine.account });
      assert.equal(await vault.read.balanceOf([BACKSTOP]), 0n);
      assert.equal(await vault.read.insuranceFundBalance(), 15n);
      assert.equal(await vault.read.traderBadDebtTotal(), 25n);
    });

    it("withdrawBackstop sweeps gains to the recipient and is owner-only", async () => {
      const { vault, usdc, engine, fund, owner, bob, alice } = await ready();
      await vault.write.depositInsuranceFund([30n], { account: owner.account });
      await vault.write.settleTransfer([fund, BACKSTOP, 30n], { account: engine.account });
      assert.equal(await vault.read.balanceOf([BACKSTOP]), 30n);

      await viem.assertions.revertWithCustomError(
        vault.write.withdrawBackstop([bob.account.address, 30n], { account: alice.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );

      const before = await usdc.read.balanceOf([bob.account.address]);
      const hash = await vault.write.withdrawBackstop([bob.account.address, 30n], { account: owner.account });
      const receipt = await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });
      const [ev] = parseEventLogs({ abi: vault.abi, logs: receipt.logs, eventName: "BackstopWithdrawn" });
      assert.equal(ev.args.recipient, getAddress(bob.account.address));
      assert.equal(ev.args.amount, 30n);
      assert.equal(await vault.read.balanceOf([BACKSTOP]), 0n);
      assert.equal((await usdc.read.balanceOf([bob.account.address])) - before, 30n);
      // Capital is untouched: the backstop is not protocol capital.
      assert.equal(await vault.read.insuranceCapital(), 30n);
    });

    it("withdrawBackstop respects the halt", async () => {
      const { vault, owner, bob } = await ready();
      await vault.write.depositFor([BACKSTOP, 5n], { account: owner.account });
      await vault.write.halt({ account: owner.account });
      await viem.assertions.revertWithCustomError(
        vault.write.withdrawBackstop([bob.account.address, 5n], { account: owner.account }),
        vault,
        "Halted",
      );
    });

    it("setBackstopParams stores, emits, bounds and is owner-only", async () => {
      const { vault, owner, alice } = await ready();
      const hash = await vault.write.setBackstopParams([50, 10], { account: owner.account });
      const receipt = await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });
      const [ev] = parseEventLogs({ abi: vault.abi, logs: receipt.logs, eventName: "BackstopParamsSet" });
      assert.equal(ev.args.unwindBandBps, 50);
      assert.equal(ev.args.unwindFeeBps, 10);
      assert.deepEqual(await vault.read.backstopParams(), [50, 10]);
      assert.equal(await vault.read.backstopUnwindBandBps(), 50);
      assert.equal(await vault.read.backstopUnwindFeeBps(), 10);

      const max = await vault.read.MAX_BACKSTOP_PARAM_BPS();
      await vault.write.setBackstopParams([max, max], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        vault.write.setBackstopParams([max + 1, 0], { account: owner.account }),
        vault,
        "BackstopParamOutOfBounds",
      );
      await viem.assertions.revertWithCustomError(
        vault.write.setBackstopParams([0, max + 1], { account: owner.account }),
        vault,
        "BackstopParamOutOfBounds",
      );
      await viem.assertions.revertWithCustomError(
        vault.write.setBackstopParams([1, 1], { account: alice.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("keeps halted in its slot after the packed params", async () => {
      const { vault, owner } = await ready();
      await vault.write.setBackstopParams([100, 100], { account: owner.account });
      assert.equal(await vault.read.halted(), false);
      await vault.write.halt({ account: owner.account });
      assert.equal(await vault.read.halted(), true);
      assert.deepEqual(await vault.read.backstopParams(), [100, 100]);
    });
  });
});
