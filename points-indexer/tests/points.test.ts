import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { Finalized, Transfer } from "../generated/Points/Points";
import { FillPointsMinted, KeeperPointsMinted } from "../generated/PointsHook/PointsHook";
import { Swapped } from "../generated/PointsRedeemer/PointsRedeemer";
import {
  handleFillPointsMinted,
  handleFinalized,
  handleKeeperPointsMinted,
  handleSwapped,
  handleTransfer,
} from "../src/points";
import {
  HOOK_ADDRESS,
  POINTS_ADDRESS,
  REDEEMER_ADDRESS,
  mockDataSource,
  paramAddr,
  paramBool,
  paramUint,
  userAddress,
} from "./helpers";

const ZERO = Address.zero();

function transferEvent(from: Address, to: Address, value: BigInt): Transfer {
  return newTypedMockEventWithParams<Transfer>([
    paramAddr("from", from),
    paramAddr("to", to),
    paramUint("value", value),
  ]);
}

function fillEvent(account: Address, amount: BigInt, isMaker: boolean): FillPointsMinted {
  return newTypedMockEventWithParams<FillPointsMinted>([
    paramAddr("account", account),
    paramUint("amount", amount),
    paramBool("isMaker", isMaker),
  ]);
}

function keeperEvent(liquidator: Address, amount: BigInt): KeeperPointsMinted {
  return newTypedMockEventWithParams<KeeperPointsMinted>([
    paramAddr("liquidator", liquidator),
    paramUint("amount", amount),
  ]);
}

function swappedEvent(
  user: Address,
  pointsBurned: BigInt,
  govAmount: BigInt,
  liquidAmount: BigInt,
  escrowAmount: BigInt,
): Swapped {
  return newTypedMockEventWithParams<Swapped>([
    paramAddr("user", user),
    paramUint("pointsBurned", pointsBurned),
    paramUint("govAmount", govAmount),
    paramUint("liquidAmount", liquidAmount),
    paramUint("escrowAmount", escrowAmount),
  ]);
}

describe("Points mirror (Transfer)", () => {
  beforeEach(() => {
    clearStore();
    mockDataSource(POINTS_ADDRESS);
  });

  test("mint credits balance, totalEarned, and program totals", () => {
    const alice = userAddress(1);
    handleTransfer(transferEvent(ZERO, alice, BigInt.fromI32(1_000_000)));

    assert.fieldEquals("UserPoints", alice.toHexString(), "total", "1000000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "totalEarned", "1000000");
    assert.fieldEquals("PointsProgram", "0", "totalPoints", "1000000");
    assert.fieldEquals("PointsProgram", "0", "totalMinted", "1000000");
    assert.fieldEquals("PointsProgram", "0", "totalUsers", "1");
  });

  test("burn debits balance and shrinks circulating supply", () => {
    const alice = userAddress(1);
    handleTransfer(transferEvent(ZERO, alice, BigInt.fromI32(1_000_000)));
    handleTransfer(transferEvent(alice, ZERO, BigInt.fromI32(400_000)));

    assert.fieldEquals("UserPoints", alice.toHexString(), "total", "600000");
    // totalEarned does not decrease on burn.
    assert.fieldEquals("UserPoints", alice.toHexString(), "totalEarned", "1000000");
    assert.fieldEquals("PointsProgram", "0", "totalPoints", "600000");
    assert.fieldEquals("PointsProgram", "0", "totalBurned", "400000");
  });

  test("finalize flips the program flag", () => {
    handleFinalized(newTypedMockEventWithParams<Finalized>([]));
    assert.fieldEquals("PointsProgram", "0", "finalized", "true");
  });
});

describe("Category breakdown (PointsHook)", () => {
  beforeEach(() => {
    clearStore();
    mockDataSource(HOOK_ADDRESS);
  });

  test("maker fill credits makerPoints and records a MAKER mint", () => {
    const alice = userAddress(1);
    const evt = fillEvent(alice, BigInt.fromI32(1_500_000), true);
    handleFillPointsMinted(evt);

    assert.fieldEquals("UserPoints", alice.toHexString(), "makerPoints", "1500000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "takerPoints", "0");
    assert.fieldEquals("UserPoints", alice.toHexString(), "fillCount", "1");
    assert.fieldEquals("PointsProgram", "0", "makerPoints", "1500000");
    assert.fieldEquals("PointsProgram", "0", "fillCount", "1");

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.fieldEquals("PointsMint", id, "category", "MAKER");
    assert.fieldEquals("PointsMint", id, "amount", "1500000");
  });

  test("taker fill credits takerPoints", () => {
    const bob = userAddress(2);
    handleFillPointsMinted(fillEvent(bob, BigInt.fromI32(1_000_000), false));
    assert.fieldEquals("UserPoints", bob.toHexString(), "takerPoints", "1000000");
    assert.fieldEquals("PointsProgram", "0", "takerPoints", "1000000");
  });

  test("liquidation credits keeperPoints and records a KEEPER mint", () => {
    const keeper = userAddress(3);
    const evt = keeperEvent(keeper, BigInt.fromI32(5_000_000));
    handleKeeperPointsMinted(evt);

    assert.fieldEquals("UserPoints", keeper.toHexString(), "keeperPoints", "5000000");
    assert.fieldEquals("UserPoints", keeper.toHexString(), "liquidationCount", "1");
    assert.fieldEquals("PointsProgram", "0", "keeperPoints", "5000000");
    assert.fieldEquals("PointsProgram", "0", "liquidationCount", "1");

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.fieldEquals("PointsMint", id, "category", "KEEPER");
  });
});

describe("Redemption (PointsRedeemer)", () => {
  beforeEach(() => {
    clearStore();
    mockDataSource(REDEEMER_ADDRESS);
  });

  test("swap records redeemed points and GOV received", () => {
    const alice = userAddress(1);
    const evt = swappedEvent(
      alice,
      BigInt.fromI32(1_000_000),
      BigInt.fromI32(2_000_000),
      BigInt.fromI32(1_000_000),
      BigInt.fromI32(1_000_000),
    );
    handleSwapped(evt);

    assert.fieldEquals("UserPoints", alice.toHexString(), "redeemedPoints", "1000000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "govReceived", "2000000");
    assert.fieldEquals("PointsProgram", "0", "totalRedeemedPoints", "1000000");
    assert.fieldEquals("PointsProgram", "0", "totalGovDistributed", "2000000");
    assert.fieldEquals("PointsProgram", "0", "redemptionCount", "1");

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.fieldEquals("PointsRedemption", id, "pointsBurned", "1000000");
    assert.fieldEquals("PointsRedemption", id, "escrowAmount", "1000000");
  });
});

describe("End-to-end reconciliation", () => {
  beforeEach(() => {
    clearStore();
  });

  test("mirror total and category breakdown reconcile for one fill", () => {
    const alice = userAddress(1);

    // Token mint (canonical balance) ...
    mockDataSource(POINTS_ADDRESS);
    handleTransfer(transferEvent(ZERO, alice, BigInt.fromI32(1_500_000)));

    // ... accompanied by the hook's maker attribution in the same logical tx.
    mockDataSource(HOOK_ADDRESS);
    handleFillPointsMinted(fillEvent(alice, BigInt.fromI32(1_500_000), true));

    assert.fieldEquals("UserPoints", alice.toHexString(), "total", "1500000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "totalEarned", "1500000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "makerPoints", "1500000");
    // Only one distinct user across both data sources.
    assert.fieldEquals("PointsProgram", "0", "totalUsers", "1");
  });
});
