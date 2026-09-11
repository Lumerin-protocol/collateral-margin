import { Bytes, dataSource } from "@graphprotocol/graph-ts";
import { Swapped } from "../generated/PointsRedeemer/PointsRedeemer";
import { PointsRedemption } from "../generated/schema";
import { createEventId } from "./ids";
import { getOrCreateProgram, getOrCreateUser } from "./helpers";

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
