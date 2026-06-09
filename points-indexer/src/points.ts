import { Address, BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";
import { Finalized, Transfer } from "../generated/Points/Points";
import { Swapped } from "../generated/PointsRedeemer/PointsRedeemer";
import { PointsMint, PointsProgram, PointsRedemption, UserPoints } from "../generated/schema";
import { createEventId } from "./ids";

const ZERO_ADDRESS = Address.zero();

// ── Helpers ───────────────────────────────────────────────────────────────

function getOrCreateProgram(): PointsProgram {
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

/**
 * Returns the leaderboard row, creating it on first sight and bumping the program
 * user count. Caller is responsible for saving both entities.
 */
function getOrCreateUser(address: Address, timestamp: BigInt, program: PointsProgram): UserPoints {
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

// ── Points token: canonical balance mirror ──────────────────────────────────
//
// POINTS (HP) blocks user-to-user transfers, so Transfer events are only mints
// (from == 0x0, attribution) and burns (to == 0x0, redemption). That makes the
// stream a lossless ledger for `total` / `totalSupply`, and lets us count and
// record every mint without needing a separate accrual event from the hook.
export function handleTransfer(event: Transfer): void {
  const from = event.params.from;
  const to = event.params.to;
  const amount = event.params.value;

  const program = getOrCreateProgram();
  if (program.pointsToken.equals(Bytes.empty())) {
    program.pointsToken = dataSource.address();
  }

  if (from.equals(ZERO_ADDRESS)) {
    // Mint (attribution).
    program.totalMinted = program.totalMinted.plus(amount);
    program.totalPoints = program.totalPoints.plus(amount);
    program.mintCount += 1;

    const user = getOrCreateUser(to, event.block.timestamp, program);
    user.total = user.total.plus(amount);
    user.totalEarned = user.totalEarned.plus(amount);
    user.mintCount += 1;
    user.lastActivityAt = event.block.timestamp;
    user.save();

    const mint = new PointsMint(createEventId(event.transaction.hash, event.logIndex));
    mint.user = user.id;
    mint.amount = amount;
    mint.timestamp = event.block.timestamp;
    mint.blockNumber = event.block.number;
    mint.transactionHash = event.transaction.hash;
    mint.save();
  } else if (to.equals(ZERO_ADDRESS)) {
    // Burn (redemption).
    program.totalBurned = program.totalBurned.plus(amount);
    program.totalPoints = program.totalPoints.minus(amount);

    const user = getOrCreateUser(from, event.block.timestamp, program);
    user.total = user.total.minus(amount);
    user.lastActivityAt = event.block.timestamp;
    user.save();
  }

  program.lastUpdatedAt = event.block.timestamp;
  program.save();
}

export function handleFinalized(event: Finalized): void {
  const program = getOrCreateProgram();
  program.finalized = true;
  program.lastUpdatedAt = event.block.timestamp;
  program.save();
}

// ── PointsRedeemer: POINTS → GOV swaps ──────────────────────────────────────

export function handleSwapped(event: Swapped): void {
  const program = getOrCreateProgram();
  if (program.redeemer.equals(Bytes.empty())) {
    program.redeemer = dataSource.address();
  }

  const pointsBurned = event.params.pointsBurned;
  const govAmount = event.params.govAmount;

  const user = getOrCreateUser(event.params.user, event.block.timestamp, program);
  user.redeemedPoints = user.redeemedPoints.plus(pointsBurned);
  user.govReceived = user.govReceived.plus(govAmount);
  user.lastActivityAt = event.block.timestamp;
  user.save();

  program.totalRedeemedPoints = program.totalRedeemedPoints.plus(pointsBurned);
  program.totalGovDistributed = program.totalGovDistributed.plus(govAmount);
  program.redemptionCount += 1;
  program.lastUpdatedAt = event.block.timestamp;
  program.save();

  const redemption = new PointsRedemption(createEventId(event.transaction.hash, event.logIndex));
  redemption.user = user.id;
  redemption.pointsBurned = pointsBurned;
  redemption.govAmount = govAmount;
  redemption.liquidAmount = event.params.liquidAmount;
  redemption.escrowAmount = event.params.escrowAmount;
  redemption.timestamp = event.block.timestamp;
  redemption.blockNumber = event.block.number;
  redemption.transactionHash = event.transaction.hash;
  redemption.save();
}
