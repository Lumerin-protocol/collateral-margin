import { Address, BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";
import { Finalized, Transfer } from "../generated/Points/Points";
import { FillPointsMinted, KeeperPointsMinted } from "../generated/PointsHook/PointsHook";
import { Swapped } from "../generated/PointsRedeemer/PointsRedeemer";
import { PointsMint, PointsProgram, PointsRedemption, UserPoints } from "../generated/schema";
import { createEventId } from "./ids";

const ZERO_ADDRESS = Address.zero();

// PointsCategory enum string values (must match schema.graphql).
const CATEGORY_MAKER = "MAKER";
const CATEGORY_TAKER = "TAKER";
const CATEGORY_KEEPER = "KEEPER";

// ── Helpers ───────────────────────────────────────────────────────────────

function getOrCreateProgram(): PointsProgram {
  let program = PointsProgram.load("0");
  if (!program) {
    program = new PointsProgram("0");
    program.pointsToken = Bytes.empty();
    program.hook = Bytes.empty();
    program.redeemer = Bytes.empty();
    program.totalPoints = BigInt.zero();
    program.totalMinted = BigInt.zero();
    program.totalBurned = BigInt.zero();
    program.finalized = false;
    program.makerPoints = BigInt.zero();
    program.takerPoints = BigInt.zero();
    program.keeperPoints = BigInt.zero();
    program.totalRedeemedPoints = BigInt.zero();
    program.totalGovDistributed = BigInt.zero();
    program.totalUsers = 0;
    program.fillCount = 0;
    program.liquidationCount = 0;
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
    user.makerPoints = BigInt.zero();
    user.takerPoints = BigInt.zero();
    user.keeperPoints = BigInt.zero();
    user.redeemedPoints = BigInt.zero();
    user.govReceived = BigInt.zero();
    user.fillCount = 0;
    user.liquidationCount = 0;
    user.firstSeenAt = timestamp;
    user.lastActivityAt = timestamp;
    program.totalUsers += 1;
  }
  return user;
}

function recordMint(
  user: UserPoints,
  amount: BigInt,
  category: string,
  transactionHash: Bytes,
  logIndex: BigInt,
  blockNumber: BigInt,
  timestamp: BigInt,
): void {
  const mint = new PointsMint(createEventId(transactionHash, logIndex));
  mint.user = user.id;
  mint.amount = amount;
  mint.category = category;
  mint.timestamp = timestamp;
  mint.blockNumber = blockNumber;
  mint.transactionHash = transactionHash;
  mint.save();
}

// ── Points token: canonical balance mirror ──────────────────────────────────
//
// POINTS (HP) blocks user-to-user transfers, so Transfer events are only mints
// (from == 0x0, attribution) and burns (to == 0x0, redemption). That makes the
// stream a lossless ledger for `total` / `totalSupply`.
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

    const user = getOrCreateUser(to, event.block.timestamp, program);
    user.total = user.total.plus(amount);
    user.totalEarned = user.totalEarned.plus(amount);
    user.lastActivityAt = event.block.timestamp;
    user.save();
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

// ── PointsHook: per-category breakdown ──────────────────────────────────────

export function handleFillPointsMinted(event: FillPointsMinted): void {
  const program = getOrCreateProgram();
  if (program.hook.equals(Bytes.empty())) {
    program.hook = dataSource.address();
  }

  const amount = event.params.amount;
  const user = getOrCreateUser(event.params.account, event.block.timestamp, program);

  let category: string;
  if (event.params.isMaker) {
    user.makerPoints = user.makerPoints.plus(amount);
    program.makerPoints = program.makerPoints.plus(amount);
    category = CATEGORY_MAKER;
  } else {
    user.takerPoints = user.takerPoints.plus(amount);
    program.takerPoints = program.takerPoints.plus(amount);
    category = CATEGORY_TAKER;
  }

  user.fillCount += 1;
  user.lastActivityAt = event.block.timestamp;
  user.save();

  program.fillCount += 1;
  program.lastUpdatedAt = event.block.timestamp;
  program.save();

  recordMint(
    user,
    amount,
    category,
    event.transaction.hash,
    event.logIndex,
    event.block.number,
    event.block.timestamp,
  );
}

export function handleKeeperPointsMinted(event: KeeperPointsMinted): void {
  const program = getOrCreateProgram();
  if (program.hook.equals(Bytes.empty())) {
    program.hook = dataSource.address();
  }

  const amount = event.params.amount;
  const user = getOrCreateUser(event.params.liquidator, event.block.timestamp, program);
  user.keeperPoints = user.keeperPoints.plus(amount);
  user.liquidationCount += 1;
  user.lastActivityAt = event.block.timestamp;
  user.save();

  program.keeperPoints = program.keeperPoints.plus(amount);
  program.liquidationCount += 1;
  program.lastUpdatedAt = event.block.timestamp;
  program.save();

  recordMint(
    user,
    amount,
    CATEGORY_KEEPER,
    event.transaction.hash,
    event.logIndex,
    event.block.number,
    event.block.timestamp,
  );
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
