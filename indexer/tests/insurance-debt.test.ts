import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import {
  assert,
  beforeEach,
  clearStore,
  createMockedFunction,
  describe,
  test,
} from "matchstick-as/assembly/index";
import {
  BadDebt,
  Deposited,
  Initialized,
  InsuranceFundDeposited,
  Transfer,
} from "../generated/CollateralVault/CollateralVault";
import {
  handleBadDebt,
  handleDeposited,
  handleInitialized,
  handleInsuranceFundDeposited,
  handleTransfer,
} from "../src/vault";
import {
  INSURANCE_FUND_ADDRESS,
  VAULT_ADDRESS,
  paramAddr,
  paramUint,
  setupDataSourceMock,
  setupVault,
  userAddress,
} from "./helpers";

const ZERO = Address.zero();
const VENUE = userAddress(9);
const TX = Bytes.fromHexString("0x1111111111111111111111111111111111111111111111111111111111111111");

function stamp(event: ethereum.Event, logIndex: i32, timestamp: i64): void {
  event.transaction.hash = TX;
  event.logIndex = BigInt.fromI32(logIndex);
  event.block.number = BigInt.fromI32(logIndex);
  event.block.timestamp = BigInt.fromI64(timestamp);
}

function eventId(logIndex: i32): string {
  return TX.concatI32(logIndex).toHexString();
}

function transfer(from: Address, to: Address, value: i32, logIndex: i32, timestamp: i64): void {
  const event = newTypedMockEventWithParams<Transfer>([
    paramAddr("from", from),
    paramAddr("to", to),
    paramUint("value", BigInt.fromI32(value)),
  ]);
  stamp(event, logIndex, timestamp);
  handleTransfer(event);
}

function deposit(to: Address, amount: i32, logIndex: i32, timestamp: i64): void {
  const event = newTypedMockEventWithParams<Deposited>([
    paramAddr("user", to),
    paramUint("amount", BigInt.fromI32(amount)),
    paramAddr("sender", to),
  ]);
  stamp(event, logIndex, timestamp);
  handleDeposited(event);
  transfer(ZERO, to, amount, logIndex + 1, timestamp);
}

function badDebt(
  payer: Address,
  receiver: Address,
  amount: i32,
  logIndex: i32,
  timestamp: i64,
): void {
  const event = newTypedMockEventWithParams<BadDebt>([
    paramAddr("payer", payer),
    paramAddr("receiver", receiver),
    paramUint("amount", BigInt.fromI32(amount)),
    paramAddr("venue", VENUE),
  ]);
  stamp(event, logIndex, timestamp);
  handleBadDebt(event);
}

describe("insurance debt worked example", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("empty fund: timing debt, then uncovered loss, then a top-up", () => {
    const winnerA = userAddress(1);
    const loserB = userAddress(2);
    const winnerC = userAddress(3);

    // B already holds the 50 that will be paid in. Deposited is emitted before
    // the mint, so that mint is not insurance debt.
    deposit(loserB, 50, 1, 1000);

    // 1. A closes +20 against an empty fund. The vault mints the profit.
    transfer(ZERO, winnerA, 20, 3, 1100);

    assert.fieldEquals("Vault", "0", "insuranceDebt", "20");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "0");
    assert.fieldEquals("Vault", "0", "timingDebt", "20");
    assert.fieldEquals("Vault", "0", "insuranceDebtBorrowedTotal", "20");
    assert.fieldEquals("Vault", "0", "insuranceDebtSince", "1100");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", "0");
    assert.fieldEquals("Vault", "0", "halted", "false");
    assert.fieldEquals("VaultUser", winnerA.toHexString(), "balance", "20");
    assert.fieldEquals("VaultUser", winnerA.toHexString(), "netFromOther", "20");

    // 2. B's loss is 60 against a 50 balance. 50 repays the debt and leaves 30
    // in the fund; 10 is trader bad debt.
    transfer(loserB, INSURANCE_FUND_ADDRESS, 50, 4, 1200);
    transfer(INSURANCE_FUND_ADDRESS, ZERO, 20, 5, 1200);
    badDebt(loserB, INSURANCE_FUND_ADDRESS, 10, 6, 1200);

    assert.fieldEquals("Vault", "0", "insuranceDebt", "0");
    assert.fieldEquals("Vault", "0", "insuranceDebtSince", "0");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", "30");
    assert.fieldEquals("Vault", "0", "traderBadDebtTotal", "10");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "10");
    assert.fieldEquals("Vault", "0", "timingDebt", "0");
    assert.fieldEquals("VaultUser", loserB.toHexString(), "balance", "0");
    assert.fieldEquals("VaultVenue", VENUE.toHexString(), "traderBadDebtTotal", "10");
    assert.entityCount("BadDebtEvent", 1);
    assert.fieldEquals("BadDebtEvent", eventId(6), "kind", "RESERVE_LOSS");

    // 3. C closes +40. The fund pays its 30 and borrows 10.
    transfer(INSURANCE_FUND_ADDRESS, winnerC, 30, 7, 1300);
    transfer(ZERO, winnerC, 10, 8, 1300);

    assert.fieldEquals("Vault", "0", "insuranceDebt", "10");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "10");
    assert.fieldEquals("Vault", "0", "timingDebt", "0");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", "0");
    assert.fieldEquals("Vault", "0", "insuranceDebtSince", "1300");
    assert.fieldEquals("Vault", "0", "insuranceDebtBorrowedTotal", "30");
    assert.fieldEquals("VaultUser", winnerC.toHexString(), "balance", "40");

    // 4. Top up 10. The mint to the fund is not a borrow; the burn repays the
    // debt, then the deposit counts as capital.
    transfer(ZERO, INSURANCE_FUND_ADDRESS, 10, 9, 1400);
    transfer(INSURANCE_FUND_ADDRESS, ZERO, 10, 10, 1400);
    const deposited = newTypedMockEventWithParams<InsuranceFundDeposited>([
      paramAddr("source", userAddress(4)),
      paramUint("amount", BigInt.fromI32(10)),
    ]);
    stamp(deposited, 11, 1400);
    handleInsuranceFundDeposited(deposited);

    assert.fieldEquals("Vault", "0", "insuranceDebt", "0");
    assert.fieldEquals("Vault", "0", "insuranceCapital", "10");
    assert.fieldEquals("Vault", "0", "uncoveredLoss", "0");
    assert.fieldEquals("Vault", "0", "timingDebt", "0");
    assert.fieldEquals("Vault", "0", "insuranceFundBalance", "0");
    assert.fieldEquals("Vault", "0", "insuranceDebtRepaidTotal", "30");
    assert.fieldEquals("Vault", "0", "insuranceDebtSince", "0");
    assert.entityCount("InsuranceDebtEvent", 4);
  });

  test("initializeV2 reads insuranceCapital from the contract", () => {
    const seeded = newTypedMockEventWithParams<InsuranceFundDeposited>([
      paramAddr("source", userAddress(4)),
      paramUint("amount", BigInt.fromI32(5)),
    ]);
    stamp(seeded, 1, 100);
    handleInsuranceFundDeposited(seeded);

    createMockedFunction(VAULT_ADDRESS, "collateralToken", "collateralToken():(address)").returns([
      ethereum.Value.fromAddress(userAddress(8)),
    ]);
    createMockedFunction(VAULT_ADDRESS, "marginEngine", "marginEngine():(address)").returns([
      ethereum.Value.fromAddress(userAddress(7)),
    ]);
    createMockedFunction(VAULT_ADDRESS, "decimals", "decimals():(uint8)").returns([
      ethereum.Value.fromI32(6),
    ]);
    createMockedFunction(VAULT_ADDRESS, "insuranceCapital", "insuranceCapital():(int256)").returns([
      ethereum.Value.fromSignedBigInt(BigInt.fromI32(99)),
    ]);

    const v1 = newTypedMockEventWithParams<Initialized>([
      paramUint("version", BigInt.fromI32(1)),
    ]);
    stamp(v1, 2, 200);
    handleInitialized(v1);
    assert.fieldEquals("Vault", "0", "insuranceCapital", "5");

    const v2 = newTypedMockEventWithParams<Initialized>([
      paramUint("version", BigInt.fromI32(2)),
    ]);
    stamp(v2, 3, 300);
    handleInitialized(v2);
    assert.fieldEquals("Vault", "0", "insuranceCapital", "99");
  });
});
