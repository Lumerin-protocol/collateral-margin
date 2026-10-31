import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import {
  AccountDebtAccrued,
  AccountDebtRecovered,
  BadDebt,
} from "../generated/CollateralVault/CollateralVault";
import { handleAccountDebtAccrued, handleAccountDebtRecovered, handleBadDebt } from "../src/vault";
import { INSURANCE_FUND_ADDRESS, paramAddr, paramUint, setupDataSourceMock, setupVault, userAddress } from "./helpers";

const VENUE = userAddress(9);
const BACKSTOP = Address.fromString("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const TX = Bytes.fromHexString("0x3333333333333333333333333333333333333333333333333333333333333333");

function stamp(event: ethereum.Event, logIndex: i32): void {
  event.transaction.hash = TX;
  event.logIndex = BigInt.fromI32(logIndex);
  event.block.number = BigInt.fromI32(logIndex);
  event.block.timestamp = BigInt.fromI32(1000 + logIndex);
}

function badDebt(payer: Address, amount: i32, logIndex: i32): void {
  const event = newTypedMockEventWithParams<BadDebt>([
    paramAddr("payer", payer),
    paramAddr("receiver", INSURANCE_FUND_ADDRESS),
    paramUint("amount", BigInt.fromI32(amount)),
    paramAddr("venue", VENUE),
  ]);
  stamp(event, logIndex);
  handleBadDebt(event);
}

function accrued(account: Address, amount: i32, logIndex: i32): void {
  const event = newTypedMockEventWithParams<AccountDebtAccrued>([
    paramAddr("account", account),
    paramUint("amount", BigInt.fromI32(amount)),
  ]);
  stamp(event, logIndex);
  handleAccountDebtAccrued(event);
}

function recovered(account: Address, amount: i32, logIndex: i32): void {
  const event = newTypedMockEventWithParams<AccountDebtRecovered>([
    paramAddr("account", account),
    paramUint("amount", BigInt.fromI32(amount)),
  ]);
  stamp(event, logIndex);
  handleAccountDebtRecovered(event);
}

describe("account debt", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("a 1.4.0 shortfall is counted once and becomes the account's debt", () => {
    const user = userAddress(1);
    badDebt(user, 10, 1);
    accrued(user, 10, 2);

    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "10");
    assert.fieldEquals("Vault", "0", "accountDebtTotal", "10");
    assert.fieldEquals("VaultUser", user.toHexString(), "accountDebt", "10");
    const id = TX.concatI32(2).toHexString();
    assert.fieldEquals("AccountDebtEvent", id, "kind", "ACCRUED");
    assert.fieldEquals("AccountDebtEvent", id, "debtAfter", "10");
  });

  test("a recovery nets the debt out of the vault totals but not the venue total", () => {
    const user = userAddress(1);
    badDebt(user, 10, 1);
    accrued(user, 10, 2);
    recovered(user, 4, 3);

    assert.fieldEquals("VaultUser", user.toHexString(), "accountDebt", "6");
    assert.fieldEquals("VaultUser", user.toHexString(), "accountDebtRecoveredTotal", "4");
    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "6");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "6");
    assert.fieldEquals("Vault", "0", "accountDebtTotal", "6");
    assert.fieldEquals("Vault", "0", "accountDebtRecoveredTotal", "4");
    assert.fieldEquals("VaultVenue", VENUE.toHexString(), "traderBadDebtTotal", "10");
    assert.fieldEquals("AccountDebtEvent", TX.concatI32(3).toHexString(), "debtAfter", "6");
  });

  test("a backstop recovery also nets the backstop share", () => {
    badDebt(BACKSTOP, 40, 1);
    accrued(BACKSTOP, 40, 2);
    recovered(BACKSTOP, 40, 3);

    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "0");
    assert.fieldEquals("Vault", "0", "backstopBadDebtTotal", "0");
    assert.fieldEquals("VaultVenue", VENUE.toHexString(), "backstopBadDebtTotal", "40");
  });

  test("pre-1.4.0 shortfalls stay bad debt and create no account debt", () => {
    const user = userAddress(1);
    badDebt(user, 10, 1);

    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "10");
    assert.fieldEquals("Vault", "0", "accountDebtTotal", "0");
    assert.fieldEquals("VaultUser", user.toHexString(), "accountDebt", "0");
    assert.entityCount("AccountDebtEvent", 0);
  });

  test("a recovery larger than the indexed debt floors at zero instead of failing", () => {
    const user = userAddress(1);
    recovered(user, 7, 1);

    assert.fieldEquals("VaultUser", user.toHexString(), "accountDebt", "0");
    assert.fieldEquals("Vault", "0", "accountDebtTotal", "0");
    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "0");
    assert.fieldEquals("Vault", "0", "accountDebtRecoveredTotal", "7");
  });
});
