/**
 * Integration tests: POINTS accrual mirrored from the on-chain `Transfer` stream.
 *
 * The points-indexer does NOT index the hook — every accrual ends in
 * `points.mint(...)`, which emits `Transfer(0x0 -> account)`. These tests drive
 * the real `PointsHook` from a venue wallet and assert that the subgraph counts
 * each mint (`mintCount`), records a `PointsMint`, and tracks balances/totals.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { read, type EntityFields } from "matchstick-ts";
import {
  FEE,
  KEEPER_POINTS,
  MAKER_PTS,
  NOTIONAL,
  TAKER_PTS,
  deployPointsStackFixture,
} from "../../contracts/tests/pointsIntegrationFixtures.ts";

const conn = await network.getOrCreate();

describe("onFill accrual: maker + taker mints mirrored to the leaderboard", () => {
  after(() => conn.matchstick.reset());

  it("credits balances/totalEarned, counts each mint, and records PointsMint rows", async () => {
    const { contracts, accounts } =
      await conn.networkHelpers.loadFixture(deployPointsStackFixture);
    const { points, hook } = contracts;
    const { alice, bob, venue } = accounts;

    conn.matchstick.bind("Points", points.address, points.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    // alice = maker, bob = taker. Both fees above threshold → both sides mint.
    await hook.write.onFill([alice.account.address, bob.account.address, NOTIONAL, FEE, FEE, 0n, 0n], {
      account: venue.account.address, chain: null,
    });

    const aliceAddr = alice.account.address.toLowerCase() as `0x${string}`;
    const bobAddr = bob.account.address.toLowerCase() as `0x${string}`;

    const snap = await conn.matchstick.indexSnapshot([
      read("UserPoints", aliceAddr),
      read("UserPoints", bobAddr),
      read("PointsProgram", "0"),
    ]);

    const aliceUser = snap.entity("UserPoints", aliceAddr);
    assert.ok(aliceUser, "maker UserPoints row must exist");
    assert.equal(String(aliceUser.total), String(MAKER_PTS), "maker balance = NOTIONAL * wMaker");
    assert.equal(String(aliceUser.totalEarned), String(MAKER_PTS));
    assert.equal(String(aliceUser.mintCount), "1");

    const bobUser = snap.entity("UserPoints", bobAddr);
    assert.ok(bobUser, "taker UserPoints row must exist");
    assert.equal(String(bobUser.total), String(TAKER_PTS), "taker balance = NOTIONAL * wTaker");
    assert.equal(String(bobUser.totalEarned), String(TAKER_PTS));
    assert.equal(String(bobUser.mintCount), "1");

    const program = snap.entity("PointsProgram", "0");
    assert.ok(program);
    assert.equal(String(program.totalMinted), String(MAKER_PTS + TAKER_PTS));
    assert.equal(String(program.totalPoints), String(MAKER_PTS + TAKER_PTS));
    assert.equal(String(program.mintCount), "2", "two mints (maker + taker) in one fill");
    assert.equal(String(program.totalUsers), "2");
    assert.equal(String(program.totalBurned), "0");

    // One PointsMint row per mint, attributed to the right account.
    const mints = snap.saved("PointsMint");
    assert.equal(mints.length, 2, "one PointsMint per mint");
    const byUser = new Map(mints.map((m: EntityFields) => [String(m.user).toLowerCase(), m]));
    assert.equal(String(byUser.get(aliceAddr)?.amount), String(MAKER_PTS));
    assert.equal(String(byUser.get(bobAddr)?.amount), String(TAKER_PTS));
    for (const m of mints) {
      assert.ok(
        String(m.id).startsWith("0x"),
        "PointsMint.id is `tx hash ++ logIndex` (hex Bytes)",
      );
      assert.ok(BigInt(String(m.blockNumber)) > 0n, "PointsMint.blockNumber is set");
      assert.ok(BigInt(String(m.timestamp)) > 0n, "PointsMint.timestamp is set");
    }
  });
});

describe("onFill accrual: a self-match contributes nothing to the leaderboard", () => {
  after(() => conn.matchstick.reset());

  it("self-match mints no Transfer; only the genuine taker fill is mirrored", async () => {
    const { contracts, accounts } =
      await conn.networkHelpers.loadFixture(deployPointsStackFixture);
    const { points, hook } = contracts;
    const { alice, bob, carol, venue } = accounts;

    conn.matchstick.bind("Points", points.address, points.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    // A self-match by alice (maker == taker) mints nothing...
    await hook.write.onFill([alice.account.address, alice.account.address, NOTIONAL, FEE, FEE, 0n, 0n], {
      account: venue.account.address, chain: null,
    });
    // ...while a real fill (carol maker w/ 0 fee → no maker mint; bob takes) mints once.
    await hook.write.onFill([carol.account.address, bob.account.address, NOTIONAL, 0n, FEE, 0n, 0n], {
      account: venue.account.address, chain: null,
    });

    const aliceAddr = alice.account.address.toLowerCase() as `0x${string}`;
    const bobAddr = bob.account.address.toLowerCase() as `0x${string}`;
    const snap = await conn.matchstick.indexSnapshot([
      read("UserPoints", aliceAddr),
      read("UserPoints", bobAddr),
      read("PointsProgram", "0"),
    ]);

    assert.equal(snap.entity("UserPoints", aliceAddr), null, "no leaderboard row for a self-match");
    const bobUser = snap.entity("UserPoints", bobAddr);
    assert.ok(bobUser, "the genuine taker is on the leaderboard");
    assert.equal(String(bobUser.total), String(TAKER_PTS));
    assert.equal(String(bobUser.mintCount), "1");

    assert.equal(snap.saved("PointsMint").length, 1, "exactly one mint: the taker fill");
    assert.equal(snap.saved("UserPoints").length, 1, "only the taker, not the self-matcher");

    const program = snap.entity("PointsProgram", "0");
    assert.ok(program);
    assert.equal(String(program.mintCount), "1");
    assert.equal(String(program.totalMinted), String(TAKER_PTS));
    assert.equal(String(program.totalUsers), "1");
  });
});

describe("onLiquidation accrual: flat keeper points mirrored", () => {
  after(() => conn.matchstick.reset());

  it("mints KEEPER_POINTS to the liquidator and counts it as a mint", async () => {
    const { contracts, accounts } =
      await conn.networkHelpers.loadFixture(deployPointsStackFixture);
    const { points, hook } = contracts;
    const { keeper, venue } = accounts;

    conn.matchstick.bind("Points", points.address, points.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    await hook.write.onLiquidation([keeper.account.address, FEE], { account: venue.account.address, chain: null });

    const keeperAddr = keeper.account.address.toLowerCase() as `0x${string}`;
    const snap = await conn.matchstick.indexSnapshot([
      read("UserPoints", keeperAddr),
      read("PointsProgram", "0"),
    ]);

    const keeperUser = snap.entity("UserPoints", keeperAddr);
    assert.ok(keeperUser);
    assert.equal(String(keeperUser.total), String(KEEPER_POINTS));
    assert.equal(String(keeperUser.totalEarned), String(KEEPER_POINTS));
    assert.equal(String(keeperUser.mintCount), "1");

    const program = snap.entity("PointsProgram", "0");
    assert.ok(program);
    assert.equal(String(program.totalMinted), String(KEEPER_POINTS));
    assert.equal(String(program.mintCount), "1");
    assert.equal(String(program.totalUsers), "1");

    assert.equal(snap.saved("PointsMint").length, 1);
  });
});
