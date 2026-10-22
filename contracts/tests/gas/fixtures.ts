import type { NetworkConnection } from "hardhat/types/network";
import { maxUint256 } from "viem";
import {
  deployCollateralVaultProxy,
  deployPortfolioMarginEngineStack,
} from "../fixtures.js";

/** One pinned time per fixture: each is first loaded after the previous one's scenarios ran. */
const COLLATERAL_TIMESTAMP = 1_800_000_000n;
const POINTS_TIMESTAMP = 1_900_000_000n;
const TRADER_FUNDING = 100_000_000_000n; // 100k USDC
const TRADER_DEPOSIT = 10_000_000_000n; // 10k USDC
const INSURANCE_DEPOSIT = 10_000_000_000n; // 10k USDC

async function pinTime(conn: NetworkConnection, timestamp: bigint) {
  const tc = await conn.viem.getTestClient();
  await tc.setNextBlockTimestamp({ timestamp });
  await tc.mine({ blocks: 1 });
}

/**
 * Vault + PortfolioMarginEngine wired as in production, with `venue` (an EOA) authorized like a
 * venue contract, two funded traders and a seeded insurance fund. Pinned to a fixed block time so
 * receipt gas is deterministic.
 */
export async function deployCollateralGasFixture(conn: NetworkConnection) {
  await pinTime(conn, COLLATERAL_TIMESTAMP);
  const [owner, alice, bob, venue, carol] = await conn.viem.getWalletClients();
  const { usdc, vault } = await deployCollateralVaultProxy(conn);
  const stack = await deployPortfolioMarginEngineStack(conn, vault.address);

  await vault.write.setMarginEngine([stack.pme.address], {
    account: owner.account,
  });
  await vault.write.setAuthorizedCaller([venue.account.address, true], {
    account: owner.account,
  });
  for (const w of [alice, bob, carol]) {
    await usdc.write.transfer([w.account.address, TRADER_FUNDING], {
      account: owner.account,
    });
    await usdc.write.approve([vault.address, maxUint256], {
      account: w.account,
    });
  }
  await usdc.write.approve([vault.address, maxUint256], {
    account: owner.account,
  });
  for (const w of [alice, bob]) {
    await vault.write.deposit([TRADER_DEPOSIT], { account: w.account });
  }
  await vault.write.depositInsuranceFund([INSURANCE_DEPOSIT], {
    account: owner.account,
  });

  return { usdc, vault, ...stack, owner, alice, bob, venue, carol };
}

/** POINTS + PointsHook + PointsRedeemer as deployed together, pinned to the same block time. */
export async function deployPointsGasFixture(conn: NetworkConnection) {
  await pinTime(conn, POINTS_TIMESTAMP);
  const { viem } = conn;
  const [owner, alice, bob, venue, keeper] = await viem.getWalletClients();
  const points = await viem.deployContract("Points", [owner.account.address]);
  const hook = await viem.deployContract("PointsHook", [
    points.address,
    owner.account.address,
    1_500_000_000_000_000_000n,
    1_000_000_000_000_000_000n,
    5_000_000n,
  ]);
  const gov = await viem.deployContract("GovTokenMock", []);
  const escrow = await viem.deployContract("VestingEscrowMock", []);
  const redeemer = await viem.deployContract("PointsRedeemer", [
    points.address,
    gov.address,
    escrow.address,
    owner.account.address,
  ]);

  const MINTER_ROLE = await points.read.MINTER_ROLE();
  const BURNER_ROLE = await points.read.BURNER_ROLE();
  const HOOK_CALLER_ROLE = await hook.read.HOOK_CALLER_ROLE();
  await points.write.grantRole([MINTER_ROLE, hook.address], {
    account: owner.account,
  });
  await points.write.grantRole([MINTER_ROLE, owner.account.address], {
    account: owner.account,
  });
  await points.write.grantRole([BURNER_ROLE, redeemer.address], {
    account: owner.account,
  });
  await hook.write.grantRole([HOOK_CALLER_ROLE, venue.account.address], {
    account: owner.account,
  });

  return {
    points,
    hook,
    gov,
    escrow,
    redeemer,
    owner,
    alice,
    bob,
    venue,
    keeper,
    MINTER_ROLE,
    BURNER_ROLE,
  };
}
