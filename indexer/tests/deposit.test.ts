import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { Deposited, Transfer } from "../generated/CollateralVault/CollateralVault";
import { handleDeposited, handleTransfer } from "../src/vault";
import {
  INSURANCE_FUND_ADDRESS,
  paramAddr,
  paramUint,
  setupDataSourceMock,
  setupVault,
  userAddress,
} from "./helpers";

const ZERO = Address.zero();

function createDepositedEvent(recipient: Address, amount: BigInt, sender: Address): Deposited {
  return newTypedMockEventWithParams<Deposited>([
    paramAddr("user", recipient),
    paramUint("amount", amount),
    paramAddr("sender", sender),
  ]);
}

function createTransferEvent(from: Address, to: Address, value: BigInt): Transfer {
  return newTypedMockEventWithParams<Transfer>([
    paramAddr("from", from),
    paramAddr("to", to),
    paramUint("value", value),
  ]);
}

describe("handleDeposited", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("user deposit creates VaultDeposit, bumps user totals, bumps vault totals", () => {
    const alice = userAddress(1);
    const amount = BigInt.fromI32(1_000_000);

    // Real chain order: mint Transfer first, then Deposited.
    handleTransfer(createTransferEvent(ZERO, alice, amount));
    const evt = createDepositedEvent(alice, amount, alice);
    handleDeposited(evt);

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.entityCount("VaultDeposit", 1);
    assert.fieldEquals("VaultDeposit", id, "user", alice.toHexString());
    assert.fieldEquals("VaultDeposit", id, "sender", alice.toHexString());
    assert.fieldEquals("VaultDeposit", id, "amount", amount.toString());
    assert.fieldEquals("VaultDeposit", id, "isInsuranceFund", "false");

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", amount.toString());
    assert.fieldEquals("VaultUser", alice.toHexString(), "totalDeposited", amount.toString());
    assert.fieldEquals("VaultUser", alice.toHexString(), "depositCount", "1");

    assert.fieldEquals("Vault", "0", "totalDeposited", amount.toString());
    assert.fieldEquals("Vault", "0", "depositCount", "1");
    assert.fieldEquals("Vault", "0", "totalSupply", amount.toString());
  });

  test("depositFor: receipt mints to recipient, sender field tracks the funder", () => {
    const alice = userAddress(1); // funder
    const bob = userAddress(2); // receipt recipient
    const amount = BigInt.fromI32(500_000);

    handleTransfer(createTransferEvent(ZERO, bob, amount));
    handleDeposited(createDepositedEvent(bob, amount, alice));

    assert.fieldEquals("VaultUser", bob.toHexString(), "balance", amount.toString());
    assert.fieldEquals("VaultUser", bob.toHexString(), "totalDeposited", amount.toString());
    // Alice never received receipt tokens, so no VaultUser is created for her —
    // her identity is captured in the deposit entity's `sender` field.
    assert.notInStore("VaultUser", alice.toHexString());
    assert.entityCount("VaultDeposit", 1);

    // Only one VaultUser exists (bob); alice was just the funder.
    assert.entityCount("VaultUser", 1);
  });

  test("insurance-fund deposit is excluded from Vault.totalDeposited", () => {
    const treasury = userAddress(7);
    const ifAddr = INSURANCE_FUND_ADDRESS;
    const amount = BigInt.fromI32(2_500_000);

    handleTransfer(createTransferEvent(ZERO, ifAddr, amount));
    const evt = createDepositedEvent(ifAddr, amount, treasury);
    handleDeposited(evt);

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.fieldEquals("VaultDeposit", id, "isInsuranceFund", "true");

    // Insurance-fund "user" still gets credited (useful for queryability).
    assert.fieldEquals(
      "VaultUser",
      INSURANCE_FUND_ADDRESS.toHexString(),
      "totalDeposited",
      amount.toString(),
    );
    assert.fieldEquals(
      "VaultUser",
      INSURANCE_FUND_ADDRESS.toHexString(),
      "balance",
      amount.toString(),
    );

    // ...but Vault aggregates exclude insurance-fund flow.
    assert.fieldEquals("Vault", "0", "totalDeposited", "0");
    assert.fieldEquals("Vault", "0", "depositCount", "0");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", amount.toString());
  });
});
