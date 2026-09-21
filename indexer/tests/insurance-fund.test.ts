import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import {
  InsuranceFundDeposited,
  InsuranceFundWithdrawn,
} from "../generated/CollateralVault/CollateralVault";
import {
  handleInsuranceFundDeposited,
  handleInsuranceFundWithdrawn,
} from "../src/vault";
import { paramAddr, paramUint, setupDataSourceMock, setupVault, userAddress } from "./helpers";

function createInsuranceFundDepositedEvent(
  source: Address,
  amount: BigInt,
): InsuranceFundDeposited {
  return newTypedMockEventWithParams<InsuranceFundDeposited>([
    paramAddr("source", source),
    paramUint("amount", amount),
  ]);
}

function createInsuranceFundWithdrawnEvent(
  recipient: Address,
  amount: BigInt,
): InsuranceFundWithdrawn {
  return newTypedMockEventWithParams<InsuranceFundWithdrawn>([
    paramAddr("recipient", recipient),
    paramUint("amount", amount),
  ]);
}

describe("insurance fund marker handlers", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupVault();
  });

  test("InsuranceFundDeposited bumps Vault.insuranceFundDeposited", () => {
    const treasury = userAddress(7);
    handleInsuranceFundDeposited(createInsuranceFundDepositedEvent(treasury, BigInt.fromI32(1000)));
    handleInsuranceFundDeposited(createInsuranceFundDepositedEvent(treasury, BigInt.fromI32(2500)));

    assert.fieldEquals("Vault", "0", "insuranceFundDeposited", "3500");
    assert.fieldEquals("Vault", "0", "insuranceFundWithdrawn", "0");
  });

  test("InsuranceFundWithdrawn bumps Vault.insuranceFundWithdrawn", () => {
    const treasury = userAddress(7);
    handleInsuranceFundWithdrawn(createInsuranceFundWithdrawnEvent(treasury, BigInt.fromI32(800)));

    assert.fieldEquals("Vault", "0", "insuranceFundWithdrawn", "800");
    assert.fieldEquals("Vault", "0", "insuranceFundDeposited", "0");
  });
});
