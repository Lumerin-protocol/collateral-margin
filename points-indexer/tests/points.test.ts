import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { Finalized, Transfer } from "../generated/Points/Points";
// import { Swapped } from "../generated/PointsRedeemer/PointsRedeemer";
import { handleFinalized, handleTransfer } from "../src/points";
import {
  POINTS_ADDRESS,
  // REDEEMER_ADDRESS,
  mockDataSource,
  paramAddr,
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

// function swappedEvent(
//   user: Address,
//   pointsBurned: BigInt,
//   govAmount: BigInt,
//   liquidAmount: BigInt,
//   escrowAmount: BigInt,
// ): Swapped {
//   return newTypedMockEventWithParams<Swapped>([
//     paramAddr("user", user),
//     paramUint("pointsBurned", pointsBurned),
//     paramUint("govAmount", govAmount),
//     paramUint("liquidAmount", liquidAmount),
//     paramUint("escrowAmount", escrowAmount),
//   ]);
// }

describe("Points mirror (Transfer)", () => {
  beforeEach(() => {
    clearStore();
    mockDataSource(POINTS_ADDRESS);
  });

  test("mint credits balance, totalEarned, counts the mint, and records it", () => {
    const alice = userAddress(1);
    const evt = transferEvent(ZERO, alice, BigInt.fromI32(1_000_000));
    handleTransfer(evt);

    assert.fieldEquals("UserPoints", alice.toHexString(), "total", "1000000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "totalEarned", "1000000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "mintCount", "1");
    assert.fieldEquals("PointsProgram", "0", "totalPoints", "1000000");
    assert.fieldEquals("PointsProgram", "0", "totalMinted", "1000000");
    assert.fieldEquals("PointsProgram", "0", "totalUsers", "1");
    assert.fieldEquals("PointsProgram", "0", "mintCount", "1");

    const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
    assert.fieldEquals("PointsMint", id, "amount", "1000000");
    assert.fieldEquals("PointsMint", id, "user", alice.toHexString());
  });

  test("repeated mints accumulate mintCount per user and program", () => {
    const alice = userAddress(1);
    handleTransfer(transferEvent(ZERO, alice, BigInt.fromI32(1_000_000)));
    handleTransfer(transferEvent(ZERO, alice, BigInt.fromI32(500_000)));

    assert.fieldEquals("UserPoints", alice.toHexString(), "total", "1500000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "mintCount", "2");
    assert.fieldEquals("PointsProgram", "0", "mintCount", "2");
    assert.fieldEquals("PointsProgram", "0", "totalUsers", "1");
  });

  test("burn debits balance, shrinks supply, and does not count as a mint", () => {
    const alice = userAddress(1);
    handleTransfer(transferEvent(ZERO, alice, BigInt.fromI32(1_000_000)));
    handleTransfer(transferEvent(alice, ZERO, BigInt.fromI32(400_000)));

    assert.fieldEquals("UserPoints", alice.toHexString(), "total", "600000");
    // totalEarned and mintCount do not change on burn.
    assert.fieldEquals("UserPoints", alice.toHexString(), "totalEarned", "1000000");
    assert.fieldEquals("UserPoints", alice.toHexString(), "mintCount", "1");
    assert.fieldEquals("PointsProgram", "0", "totalPoints", "600000");
    assert.fieldEquals("PointsProgram", "0", "totalBurned", "400000");
    assert.fieldEquals("PointsProgram", "0", "mintCount", "1");
  });

  test("finalize flips the program flag", () => {
    handleFinalized(newTypedMockEventWithParams<Finalized>([]));
    assert.fieldEquals("PointsProgram", "0", "finalized", "true");
  });
});

// describe("Redemption (PointsRedeemer)", () => {
//   beforeEach(() => {
//     clearStore();
//     mockDataSource(REDEEMER_ADDRESS);
//   });

//   test("swap records redeemed points and GOV received", () => {
//     const alice = userAddress(1);
//     const evt = swappedEvent(
//       alice,
//       BigInt.fromI32(1_000_000),
//       BigInt.fromI32(2_000_000),
//       BigInt.fromI32(1_000_000),
//       BigInt.fromI32(1_000_000),
//     );
//     handleSwapped(evt);

//     assert.fieldEquals("UserPoints", alice.toHexString(), "redeemedPoints", "1000000");
//     assert.fieldEquals("UserPoints", alice.toHexString(), "govReceived", "2000000");
//     assert.fieldEquals("PointsProgram", "0", "totalRedeemedPoints", "1000000");
//     assert.fieldEquals("PointsProgram", "0", "totalGovDistributed", "2000000");
//     assert.fieldEquals("PointsProgram", "0", "redemptionCount", "1");

//     const id = evt.transaction.hash.concatI32(evt.logIndex.toI32()).toHexString();
//     assert.fieldEquals("PointsRedemption", id, "pointsBurned", "1000000");
//     assert.fieldEquals("PointsRedemption", id, "escrowAmount", "1000000");
//   });
// });

// describe("End-to-end reconciliation", () => {
//   beforeEach(() => {
//     clearStore();
//   });

//   test("mint then redeem reconciles balance, earned, and circulating supply", () => {
//     const alice = userAddress(1);

//     mockDataSource(POINTS_ADDRESS);
//     handleTransfer(transferEvent(ZERO, alice, BigInt.fromI32(1_500_000)));
//     // Redemption burns part of the balance via the token's Transfer(to == 0x0).
//     handleTransfer(transferEvent(alice, ZERO, BigInt.fromI32(500_000)));

//     mockDataSource(REDEEMER_ADDRESS);
//     handleSwapped(
//       swappedEvent(
//         alice,
//         BigInt.fromI32(500_000),
//         BigInt.fromI32(1_000_000),
//         BigInt.fromI32(500_000),
//         BigInt.fromI32(500_000),
//       ),
//     );

//     assert.fieldEquals("UserPoints", alice.toHexString(), "total", "1000000");
//     assert.fieldEquals("UserPoints", alice.toHexString(), "totalEarned", "1500000");
//     assert.fieldEquals("UserPoints", alice.toHexString(), "redeemedPoints", "500000");
//     assert.fieldEquals("PointsProgram", "0", "totalPoints", "1000000");
//     assert.fieldEquals("PointsProgram", "0", "totalUsers", "1");
//   });
// });
