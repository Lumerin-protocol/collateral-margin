/**
 * Integration tests: POINTS → GOV redemption.
 *
 * A swap burns the caller's POINTS (`Transfer(holder -> 0x0)`) and emits
 * `PointsRedeemer.Swapped`. The subgraph must debit the balance + circulating
 * supply from the burn, and record the GOV payout split from `Swapped` — while
 * leaving `totalEarned` / `mintCount` untouched (a burn is not a mint).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { read, type EntityFields } from "matchstick-ts";
import {
  FEE,
  NOTIONAL,
  TAKER_PTS,
  deployPointsStackFixture,
} from "../../contracts/tests/pointsIntegrationFixtures.ts";

const conn = await network.getOrCreate();

/** alice earns 1000 POINTS, bob earns 3000 POINTS, pool = 4000 GOV. */
const ALICE_PTS = TAKER_PTS; // 1000 POINTS (6 decimals)
const BOB_PTS = TAKER_PTS * 3n; // 3000 POINTS
const POOL = ALICE_PTS + BOB_PTS; // 4000 GOV, 1 GOV per POINT at this ratio

describe.skip("swap: burn debits supply, Swapped records the GOV payout split", () => {
  after(() => conn.matchstick.reset());

  it("debits balance + supply, records PointsRedemption, leaves totalEarned/mintCount intact", async () => {
    const { contracts, accounts } = await conn.networkHelpers.loadFixture(deployPointsStackFixture);
    const { points, hook, gov, redeemer } = contracts;
    const { owner, alice, bob, carol, venue } = accounts;

    conn.matchstick.bind("Points", points.address, points.abi);
    conn.matchstick.bind("PointsRedeemer", redeemer.address, redeemer.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    // Accrue: carol is the maker (makerFee 0 → no maker mint); alice/bob take.
    await hook.write.onFill(
      [carol.account.address, alice.account.address, NOTIONAL, 0n, FEE, 0n, 0n],
      {
        account: venue.account,
      },
    );
    await hook.write.onFill(
      [carol.account.address, bob.account.address, NOTIONAL * 3n, 0n, FEE, 0n, 0n],
      {
        account: venue.account,
      },
    );

    // Wind down: finalize, fund the pool, open redemption, then alice swaps.
    await points.write.finalize({ account: owner.account });
    await gov.write.transfer([redeemer.address, POOL], { account: owner.account });
    await redeemer.write.enableRedemption([POOL], { account: owner.account });
    await redeemer.write.swap({ account: alice.account });

    const aliceAddr = alice.account.address.toLowerCase() as `0x${string}`;
    const expectedGov = (POOL * ALICE_PTS) / (ALICE_PTS + BOB_PTS); // 1000 GOV
    const liquid = expectedGov / 2n;
    const escrow = expectedGov - liquid;

    const snap = await conn.matchstick.indexSnapshot([
      read("UserPoints", aliceAddr),
      read("PointsProgram", "0"),
    ]);

    const aliceUser = snap.entity("UserPoints", aliceAddr);
    assert.ok(aliceUser);
    assert.equal(String(aliceUser.total), "0", "full balance burned on swap");
    assert.equal(
      String(aliceUser.totalEarned),
      String(ALICE_PTS),
      "totalEarned unaffected by burn",
    );
    assert.equal(String(aliceUser.mintCount), "1", "burn is not a mint");
    assert.equal(String(aliceUser.redeemedPoints), String(ALICE_PTS));
    assert.equal(String(aliceUser.govReceived), String(expectedGov));

    const program = snap.entity("PointsProgram", "0");
    assert.ok(program);
    assert.equal(String(program.totalMinted), String(ALICE_PTS + BOB_PTS), "mints are sticky");
    assert.equal(String(program.totalBurned), String(ALICE_PTS));
    assert.equal(
      String(program.totalPoints),
      String(BOB_PTS),
      "circulating supply drops by the burned amount",
    );
    assert.equal(String(program.mintCount), "2", "two fills, unchanged by the burn");
    assert.equal(String(program.totalRedeemedPoints), String(ALICE_PTS));
    assert.equal(String(program.totalGovDistributed), String(expectedGov));
    assert.equal(String(program.redemptionCount), "1");
    assert.equal(String(program.finalized), "true", "Finalized() flips the program flag");

    const redemptions = snap.saved("PointsRedemption");
    assert.equal(redemptions.length, 1, "one PointsRedemption per swap");
    const r = redemptions[0] as EntityFields;
    assert.equal(String(r.user).toLowerCase(), aliceAddr);
    assert.equal(String(r.pointsBurned), String(ALICE_PTS));
    assert.equal(String(r.govAmount), String(expectedGov));
    assert.equal(String(r.liquidAmount), String(liquid));
    assert.equal(String(r.escrowAmount), String(escrow));
    assert.ok(String(r.id).startsWith("0x"), "PointsRedemption.id is `tx hash ++ logIndex`");
  });
});
