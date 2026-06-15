import { Address, Bytes, dataSource } from "@graphprotocol/graph-ts";
import { Finalized, Transfer } from "../generated/Points/Points";
import { createEventId } from "./ids";
import { PointsMint } from "../generated/schema";
import { getOrCreateProgram, getOrCreateUser } from "./helpers";

const ZERO_ADDRESS = Address.zero();

// ── Helpers ───────────────────────────────────────────────────────────────

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
