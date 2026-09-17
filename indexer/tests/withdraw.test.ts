import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { Transfer, Withdrawn } from "../generated/CollateralVault/CollateralVault";
import { handleTransfer, handleWithdrawn } from "../src/vault";
import {
  INSURANCE_FUND_ADDRESS,
  paramAddr,
  paramUint,
  setupDataSourceMock,
  setupVault,
  userAddress,
} from "./helpers";

const ZERO = Address.zero();

function createWithdrawnEvent(owner: Address, amount: BigInt, recipient: Address): Withdrawn {
  return newTypedMockEventWithParams<Withdrawn>([
    paramAddr("user", owner),
    paramUint("amount", amount),
    paramAddr("recipient", recipient),
  ]);
}

function createTransferEvent(from: Address, to: Address, value: BigInt): Transfer {
  return newTypedMockEventWithParams<Transfer>([
    paramAddr("from", from),
    paramAddr("to", to),
    paramUint("value", value),
  ]);
}

describe("handleWithdrawn", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("user withdraw creates VaultWithdrawal, bumps user totals, bumps vault totals", () => {
    const alice = userAddress(1);
    const deposit = BigInt.fromI32(1_000_000);
    const withdrawal = BigInt.fromI32(400_000);

    // Seed balance: deposit then withdraw.
    handleTransfer(createTransferEvent(ZERO, alice, deposit));
    handleTransfer(createTransferEvent(alice, ZERO, withdrawal));
    const evt = createWithdrawnEvent(alice, withdrawal, alice);
    handleWithdrawn(evt);

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.entityCount("VaultWithdrawal", 1);
    assert.fieldEquals("VaultWithdrawal", id, "user", alice.toHexString());
    assert.fieldEquals("VaultWithdrawal", id, "recipient", alice.toHexString());
    assert.fieldEquals("VaultWithdrawal", id, "amount", withdrawal.toString());
    assert.fieldEquals("VaultWithdrawal", id, "isInsuranceFund", "false");

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", "600000");
    assert.fieldEquals("VaultUser", alice.toHexString(), "totalWithdrawn", withdrawal.toString());
    assert.fieldEquals("VaultUser", alice.toHexString(), "withdrawalCount", "1");

    assert.fieldEquals("Vault", "0", "totalWithdrawn", withdrawal.toString());
    assert.fieldEquals("Vault", "0", "withdrawalCount", "1");
    assert.fieldEquals("Vault", "0", "totalSupply", "600000");
  });

  test("withdrawTo: balance burned from owner, recipient field tracks the recipient", () => {
    const alice = userAddress(1); // owner / authorized caller
    const bob = userAddress(2); // recipient
    const amount = BigInt.fromI32(500_000);

    handleTransfer(createTransferEvent(ZERO, alice, amount));
    handleTransfer(createTransferEvent(alice, ZERO, amount));
    handleWithdrawn(createWithdrawnEvent(alice, amount, bob));

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", "0");
    assert.fieldEquals("VaultUser", alice.toHexString(), "totalWithdrawn", amount.toString());
    assert.entityCount("VaultWithdrawal", 1);
  });

  test("insurance-fund withdraw is excluded from Vault.totalWithdrawn", () => {
    const treasury = userAddress(7);
    const amount = BigInt.fromI32(2_500_000);

    // Seed insurance-fund balance.
    handleTransfer(createTransferEvent(ZERO, INSURANCE_FUND_ADDRESS, amount));
    handleTransfer(createTransferEvent(INSURANCE_FUND_ADDRESS, ZERO, amount));
    const evt = createWithdrawnEvent(INSURANCE_FUND_ADDRESS, amount, treasury);
    handleWithdrawn(evt);

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.fieldEquals("VaultWithdrawal", id, "isInsuranceFund", "true");

    // VaultUser for the IF address tracks the gross withdrawal.
    assert.fieldEquals(
      "VaultUser",
      INSURANCE_FUND_ADDRESS.toHexString(),
      "totalWithdrawn",
      amount.toString(),
    );
    assert.fieldEquals("VaultUser", INSURANCE_FUND_ADDRESS.toHexString(), "balance", "0");

    // ...but Vault aggregates exclude it.
    assert.fieldEquals("Vault", "0", "totalWithdrawn", "0");
    assert.fieldEquals("Vault", "0", "withdrawalCount", "0");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", "0");
  });
});
