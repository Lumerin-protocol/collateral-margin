import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import {
  InsuranceDebtCapSet,
  MarginEngineSet,
  Transfer,
  VaultHalted,
  VaultResumed,
} from "../generated/CollateralVault/CollateralVault";
import {
  handleInsuranceDebtCapSet,
  handleMarginEngineSet,
  handleTransfer,
  handleVaultHalted,
  handleVaultResumed,
} from "../src/vault";
import {
  INSURANCE_FUND_ADDRESS,
  paramAddr,
  paramI32,
  paramUint,
  setupDataSourceMock,
  setupVault,
  userAddress,
} from "./helpers";

const TX = Bytes.fromHexString("0x3333333333333333333333333333333333333333333333333333333333333333");

function stamp(event: ethereum.Event, logIndex: i32, timestamp: i64): void {
  event.transaction.hash = TX;
  event.logIndex = BigInt.fromI32(logIndex);
  event.block.number = BigInt.fromI32(logIndex);
  event.block.timestamp = BigInt.fromI64(timestamp);
}

function eventId(logIndex: i32): string {
  return TX.concatI32(logIndex).toHexString();
}

describe("halt", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("a cap halt latches until resume, and lowering the cap does not halt", () => {
    const winner = userAddress(1);

    const cap = newTypedMockEventWithParams<InsuranceDebtCapSet>([
      paramUint("oldCap", BigInt.fromI32(0)),
      paramUint("newCap", BigInt.fromI32(100)),
    ]);
    stamp(cap, 1, 1000);
    handleInsuranceDebtCapSet(cap);
    assert.fieldEquals("Vault", "0", "insuranceDebtCap", "100");
    assert.fieldEquals("Vault", "0", "halted", "false");

    const lowered = newTypedMockEventWithParams<InsuranceDebtCapSet>([
      paramUint("oldCap", BigInt.fromI32(100)),
      paramUint("newCap", BigInt.fromI32(5)),
    ]);
    stamp(lowered, 2, 1100);
    handleInsuranceDebtCapSet(lowered);
    assert.fieldEquals("Vault", "0", "insuranceDebtCap", "5");
    assert.fieldEquals("Vault", "0", "halted", "false");

    const borrowed = newTypedMockEventWithParams<Transfer>([
      paramAddr("from", Address.zero()),
      paramAddr("to", winner),
      paramUint("value", BigInt.fromI32(20)),
    ]);
    stamp(borrowed, 3, 1200);
    handleTransfer(borrowed);

    const halted = newTypedMockEventWithParams<VaultHalted>([
      paramI32("reason", 0),
      paramUint("debt", BigInt.fromI32(20)),
      paramUint("effectiveCap", BigInt.fromI32(5)),
    ]);
    stamp(halted, 4, 1200);
    handleVaultHalted(halted);

    assert.fieldEquals("Vault", "0", "halted", "true");
    assert.fieldEquals("Vault", "0", "haltedSince", "1200");
    assert.fieldEquals("Vault", "0", "insuranceDebt", "20");
    assert.fieldEquals("Vault", "0", "timingDebt", "20");
    assert.fieldEquals("VaultHaltEvent", eventId(4), "kind", "HALT");
    assert.fieldEquals("VaultHaltEvent", eventId(4), "reason", "CAP");
    assert.fieldEquals("VaultHaltEvent", eventId(4), "transactionHash", TX.toHexString());

    // Repaying under the cap does not clear the halt. The repayment is the
    // burn of the insurance fund's receipt tokens.
    const repaid = newTypedMockEventWithParams<Transfer>([
      paramAddr("from", INSURANCE_FUND_ADDRESS),
      paramAddr("to", Address.zero()),
      paramUint("value", BigInt.fromI32(20)),
    ]);
    stamp(repaid, 5, 1300);
    handleTransfer(repaid);
    assert.fieldEquals("Vault", "0", "insuranceDebt", "0");
    assert.fieldEquals("Vault", "0", "halted", "true");
    assert.fieldEquals("Vault", "0", "haltedSince", "1200");

    const resumed = newTypedMockEventWithParams<VaultResumed>([
      paramUint("debt", BigInt.fromI32(0)),
      paramUint("effectiveCap", BigInt.fromI32(5)),
    ]);
    stamp(resumed, 6, 1400);
    handleVaultResumed(resumed);
    assert.fieldEquals("Vault", "0", "halted", "false");
    assert.fieldEquals("Vault", "0", "haltedSince", "0");
    assert.fieldEquals("VaultHaltEvent", eventId(6), "kind", "RESUME");
  });

  test("unsetting the margin engine is indexed, and a NO_MARGIN_ENGINE halt records the reason", () => {
    const engine = userAddress(3);
    const set = newTypedMockEventWithParams<MarginEngineSet>([paramAddr("marginEngine", engine)]);
    stamp(set, 1, 1000);
    handleMarginEngineSet(set);
    assert.fieldEquals("Vault", "0", "marginEngine", engine.toHexString());

    const cleared = newTypedMockEventWithParams<MarginEngineSet>([
      paramAddr("marginEngine", Address.zero()),
    ]);
    stamp(cleared, 2, 1100);
    handleMarginEngineSet(cleared);
    assert.fieldEquals("Vault", "0", "marginEngine", Address.zero().toHexString());

    const halted = newTypedMockEventWithParams<VaultHalted>([
      paramI32("reason", 2),
      paramUint("debt", BigInt.fromI32(10)),
      paramUint("effectiveCap", BigInt.fromI32(0)),
    ]);
    stamp(halted, 3, 1100);
    handleVaultHalted(halted);
    assert.fieldEquals("VaultHaltEvent", eventId(3), "reason", "NO_MARGIN_ENGINE");
    assert.fieldEquals("Vault", "0", "halted", "true");
  });

  test("an owner halt records OWNER", () => {
    const halted = newTypedMockEventWithParams<VaultHalted>([
      paramI32("reason", 1),
      paramUint("debt", BigInt.fromI32(0)),
      paramUint("effectiveCap", BigInt.fromI32(100)),
    ]);
    stamp(halted, 1, 1500);
    handleVaultHalted(halted);
    assert.fieldEquals("VaultHaltEvent", eventId(1), "reason", "OWNER");
    assert.fieldEquals("Vault", "0", "haltedSince", "1500");
  });
});
