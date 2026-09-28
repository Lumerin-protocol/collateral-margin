import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { BadDebt, InsuranceFundDeposited, InsuranceFundWithdrawn } from "../generated/CollateralVault/CollateralVault";
import {
  handleBadDebt,
  handleInsuranceFundDeposited,
  handleInsuranceFundWithdrawn,
} from "../src/vault";
import {
  INSURANCE_FUND_ADDRESS,
  paramAddr,
  paramUint,
  setupDataSourceMock,
  setupVault,
  userAddress,
} from "./helpers";

const VENUE = userAddress(9);
const TX = Bytes.fromHexString("0x2222222222222222222222222222222222222222222222222222222222222222");

function stamp(event: ethereum.Event, logIndex: i32): void {
  event.transaction.hash = TX;
  event.logIndex = BigInt.fromI32(logIndex);
  event.block.number = BigInt.fromI32(logIndex);
  event.block.timestamp = BigInt.fromI32(1000 + logIndex);
}

function badDebt(payer: Address, receiver: Address, amount: i32, logIndex: i32): void {
  const event = newTypedMockEventWithParams<BadDebt>([
    paramAddr("payer", payer),
    paramAddr("receiver", receiver),
    paramUint("amount", BigInt.fromI32(amount)),
    paramAddr("venue", VENUE),
  ]);
  stamp(event, logIndex);
  handleBadDebt(event);
}

describe("bad debt", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("a shortfall owed to the fund is a reserve loss", () => {
    const payer = userAddress(1);
    badDebt(payer, INSURANCE_FUND_ADDRESS, 10, 1);

    const id = TX.concatI32(1).toHexString();
    assert.fieldEquals("BadDebtEvent", id, "kind", "RESERVE_LOSS");
    assert.fieldEquals("BadDebtEvent", id, "payer", payer.toHexString());
    assert.fieldEquals("BadDebtEvent", id, "amount", "10");
    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "10");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "10");
    assert.fieldEquals("VaultVenue", VENUE.toHexString(), "traderBadDebtTotal", "10");
    assert.fieldEquals("VaultVenue", VENUE.toHexString(), "feeBadDebtTotal", "0");
  });

  test("a fee shortfall does not increase trader bad debt", () => {
    const payer = userAddress(1);
    const venueFees = userAddress(8);
    badDebt(payer, venueFees, 4, 1);

    const id = TX.concatI32(1).toHexString();
    assert.fieldEquals("BadDebtEvent", id, "kind", "FEE");
    assert.fieldEquals("BadDebtEvent", id, "receiver", venueFees.toHexString());
    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "0");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "0");
    assert.fieldEquals("VaultVenue", VENUE.toHexString(), "feeBadDebtTotal", "4");
    assert.fieldEquals("VaultVenue", VENUE.toHexString(), "traderBadDebtTotal", "0");
  });

  test("negative insurance capital adds to uncovered loss", () => {
    const treasury = userAddress(4);
    const deposited = newTypedMockEventWithParams<InsuranceFundDeposited>([
      paramAddr("source", treasury),
      paramUint("amount", BigInt.fromI32(10)),
    ]);
    stamp(deposited, 1);
    handleInsuranceFundDeposited(deposited);

    const withdrawn = newTypedMockEventWithParams<InsuranceFundWithdrawn>([
      paramAddr("recipient", treasury),
      paramUint("amount", BigInt.fromI32(15)),
    ]);
    stamp(withdrawn, 2);
    handleInsuranceFundWithdrawn(withdrawn);

    badDebt(userAddress(1), INSURANCE_FUND_ADDRESS, 10, 3);

    assert.fieldEquals("Vault", "0", "insuranceCapital", "-5");
    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "10");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "15");
  });
});
