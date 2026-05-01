import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { Transfer } from "../generated/CollateralVault/CollateralVault";
import { handleTransfer } from "../src/vault";
import {
  INSURANCE_FUND_ADDRESS,
  OPTIONS_ADDRESS,
  PERPS_ADDRESS,
  paramAddr,
  paramUint,
  setupDataSourceMock,
  setupVault,
  userAddress,
} from "./helpers";

const ZERO = Address.zero();

function createTransferEvent(
  from: Address,
  to: Address,
  value: BigInt,
  callerAddress: Address = ZERO,
): Transfer {
  const event = newTypedMockEventWithParams<Transfer>([
    paramAddr("from", from),
    paramAddr("to", to),
    paramUint("value", value),
  ]);
  if (!callerAddress.equals(ZERO)) {
    event.transaction.to = callerAddress;
  }
  return event;
}

describe("handleTransfer", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("mint credits balance and grows totalSupply", () => {
    const alice = userAddress(1);
    const event = createTransferEvent(ZERO, alice, BigInt.fromI32(1_000_000));

    handleTransfer(event);

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", "1000000");
    assert.fieldEquals("Vault", "0", "totalSupply", "1000000");
    assert.fieldEquals("Vault", "0", "totalUsers", "1");
    assert.entityCount("VaultInternalTransfer", 0);
  });

  test("burn debits balance and shrinks totalSupply", () => {
    const alice = userAddress(1);
    handleTransfer(createTransferEvent(ZERO, alice, BigInt.fromI32(1_000_000)));
    handleTransfer(createTransferEvent(alice, ZERO, BigInt.fromI32(400_000)));

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", "600000");
    assert.fieldEquals("Vault", "0", "totalSupply", "600000");
    assert.entityCount("VaultInternalTransfer", 0);
  });

  test("internal transfer between real accounts moves balance and creates VaultInternalTransfer", () => {
    const alice = userAddress(1);
    const bob = userAddress(2);
    handleTransfer(createTransferEvent(ZERO, alice, BigInt.fromI32(1_000_000)));

    const transferEvt = createTransferEvent(alice, bob, BigInt.fromI32(250_000));
    handleTransfer(transferEvt);

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", "750000");
    assert.fieldEquals("VaultUser", bob.toHexString(), "balance", "250000");
    assert.fieldEquals("VaultUser", alice.toHexString(), "netInternalIn", "-250000");
    assert.fieldEquals("VaultUser", bob.toHexString(), "netInternalIn", "250000");
    assert.fieldEquals("Vault", "0", "totalSupply", "1000000");
    assert.fieldEquals("Vault", "0", "internalTransferCount", "1");
    assert.entityCount("VaultInternalTransfer", 1);

    const id = transferEvt.transaction.hash.concatI32(transferEvt.logIndex.toI32()).toHexString();
    assert.fieldEquals("VaultInternalTransfer", id, "from", alice.toHexString());
    assert.fieldEquals("VaultInternalTransfer", id, "to", bob.toHexString());
    assert.fieldEquals("VaultInternalTransfer", id, "amount", "250000");
    // No transaction.to set ⇒ falls through to OTHER.
    assert.fieldEquals("VaultInternalTransfer", id, "callerCategory", "OTHER");
  });

  test("internal transfer attributes callerCategory by transaction.to", () => {
    const alice = userAddress(1);
    const bob = userAddress(2);
    handleTransfer(createTransferEvent(ZERO, alice, BigInt.fromI32(2_000_000)));

    // PERPS-routed transfer
    const perpsCall = createTransferEvent(alice, bob, BigInt.fromI32(100_000), PERPS_ADDRESS);
    perpsCall.logIndex = BigInt.fromI32(10);
    handleTransfer(perpsCall);

    // OPTIONS-routed transfer
    const optionsCall = createTransferEvent(bob, alice, BigInt.fromI32(70_000), OPTIONS_ADDRESS);
    optionsCall.logIndex = BigInt.fromI32(11);
    handleTransfer(optionsCall);

    const perpsId = perpsCall.transaction.hash.concatI32(10).toHexString();
    const optionsId = optionsCall.transaction.hash.concatI32(11).toHexString();
    assert.fieldEquals("VaultInternalTransfer", perpsId, "callerCategory", "PERPS");
    assert.fieldEquals("VaultInternalTransfer", optionsId, "callerCategory", "OPTIONS");

    // Per-user signed nets per category
    assert.fieldEquals("VaultUser", alice.toHexString(), "netFromPerps", "-100000");
    assert.fieldEquals("VaultUser", alice.toHexString(), "netFromOptions", "70000");
    assert.fieldEquals("VaultUser", bob.toHexString(), "netFromPerps", "100000");
    assert.fieldEquals("VaultUser", bob.toHexString(), "netFromOptions", "-70000");

    // Combined net is the sum.
    assert.fieldEquals("VaultUser", alice.toHexString(), "netInternalIn", "-30000");
    assert.fieldEquals("VaultUser", bob.toHexString(), "netInternalIn", "30000");
  });

  test("transfers touching the insurance fund update Vault.insuranceFundBalance", () => {
    const alice = userAddress(1);
    handleTransfer(createTransferEvent(ZERO, alice, BigInt.fromI32(1_000_000)));

    // Alice → insurance fund (e.g. liquidation penalty). Routed through perps.
    handleTransfer(
      createTransferEvent(alice, INSURANCE_FUND_ADDRESS, BigInt.fromI32(300_000), PERPS_ADDRESS),
    );

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", "700000");
    assert.fieldEquals("VaultUser", INSURANCE_FUND_ADDRESS.toHexString(), "balance", "300000");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", "300000");

    // Insurance fund pays a recovery back to alice.
    handleTransfer(
      createTransferEvent(INSURANCE_FUND_ADDRESS, alice, BigInt.fromI32(50_000), PERPS_ADDRESS),
    );

    assert.fieldEquals("VaultUser", alice.toHexString(), "balance", "750000");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", "250000");
  });
});
