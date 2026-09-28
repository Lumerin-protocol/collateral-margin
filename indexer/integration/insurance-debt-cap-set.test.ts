import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployVaultFixture, num, watch } from "./fixture.ts";

const conn = await network.getOrCreate();

describe("handleInsuranceDebtCapSet", () => {
  beforeEach(() => conn.matchstick.reset());
  afterEach(() => conn.matchstick.reset());

  it("stores each cap update", async () => {
    const { vault, accounts } = await conn.networkHelpers.loadFixture(deployVaultFixture);
    const { owner } = accounts;
    await watch(conn.matchstick, vault);

    await vault.write.setInsuranceDebtCap([5_000n], { account: owner.account, chain: null });
    await vault.write.setInsuranceDebtCap([1_200n], { account: owner.account, chain: null });

    const snap = await conn.matchstick.indexSnapshot([read("Vault", "0")]);
    const state = snap.entity("Vault", "0");
    assert.ok(state);
    assert.equal(num(state.insuranceDebtCap), "1200");
    assert.equal(state.halted, false);

    assert.deepEqual(
      snap.saved("InsuranceDebtCapChange").map((row) => [num(row.oldCap), num(row.newCap)]),
      [
        ["0", "5000"],
        ["5000", "1200"],
      ],
    );
  });
});
