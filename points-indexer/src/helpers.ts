import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { PointsProgram, UserPoints } from "../generated/schema";

/**
 * Returns the leaderboard row, creating it on first sight and bumping the program
 * user count. Caller is responsible for saving both entities.
 */
export function getOrCreateUser(
  address: Address,
  timestamp: BigInt,
  program: PointsProgram,
): UserPoints {
  let user = UserPoints.load(address);
  if (!user) {
    user = new UserPoints(address);
    user.address = address;
    user.total = BigInt.zero();
    user.totalEarned = BigInt.zero();
    user.redeemedPoints = BigInt.zero();
    user.govReceived = BigInt.zero();
    user.mintCount = 0;
    user.firstSeenAt = timestamp;
    user.lastActivityAt = timestamp;
    program.totalUsers += 1;
  }
  return user;
}

export function getOrCreateProgram(): PointsProgram {
  let program = PointsProgram.load("0");
  if (!program) {
    program = new PointsProgram("0");
    program.pointsToken = Bytes.empty();
    program.redeemer = Bytes.empty();
    program.totalPoints = BigInt.zero();
    program.totalMinted = BigInt.zero();
    program.totalBurned = BigInt.zero();
    program.finalized = false;
    program.totalRedeemedPoints = BigInt.zero();
    program.totalGovDistributed = BigInt.zero();
    program.totalUsers = 0;
    program.mintCount = 0;
    program.redemptionCount = 0;
    program.lastUpdatedAt = BigInt.zero();
  }
  return program;
}
