import type { NetworkConnection } from "hardhat/types/network";

/** 1.5e18 — maker weight (1.5 POINTS per notional unit). */
export const W_MAKER = 1_500_000_000_000_000_000n;
/** 1e18 — taker weight (1 POINT per notional unit). */
export const W_TAKER = 1_000_000_000_000_000_000n;
/** 5 POINTS (6 decimals) flat per liquidation. */
export const KEEPER_POINTS = 5_000_000n;
/** $1000 notional in collateral (6 decimals). */
export const NOTIONAL = 1_000_000_000n;
/** 1 GOV / POINT helper amounts (6 decimals). */
export const ONE_TOKEN = 1_000_000n;

/** Deploy the bare POINTS token with `owner` as admin. */
export async function deployPointsFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice, bob, carol] = await viem.getWalletClients();
  const points = await viem.deployContract("Points", [owner.account.address]);
  return { points, owner, alice, bob, carol };
}

/**
 * POINTS + PointsHook wired together:
 *  - the hook is the POINTS `minter`,
 *  - `venue` wallet holds HOOK_CALLER_ROLE (stands in for a venue contract).
 */
export async function deployHookFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice, bob, carol, venue, keeper] = await viem.getWalletClients();
  const points = await viem.deployContract("Points", [owner.account.address]);
  const hook = await viem.deployContract("PointsHook", [
    points.address,
    owner.account.address,
    W_MAKER,
    W_TAKER,
    KEEPER_POINTS,
  ]);

  const MINTER_ROLE = await points.read.MINTER_ROLE();
  const HOOK_CALLER_ROLE = await hook.read.HOOK_CALLER_ROLE();
  await points.write.grantRole([MINTER_ROLE, hook.address], { account: owner.account });
  await hook.write.grantRole([HOOK_CALLER_ROLE, venue.account.address], { account: owner.account });

  return { points, hook, owner, alice, bob, carol, venue, keeper, MINTER_ROLE, HOOK_CALLER_ROLE };
}

/**
 * POINTS + GOV + escrow + PointsRedeemer, with balances minted to alice/bob and
 * redemption left DISABLED (tests finalize + enable as needed).
 *  - the redeemer is the POINTS `burner`,
 *  - `owner` is the POINTS `minter` (mints test balances directly).
 */
export async function deployRedeemerFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice, bob, carol] = await viem.getWalletClients();
  const points = await viem.deployContract("Points", [owner.account.address]);
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
  await points.write.grantRole([MINTER_ROLE, owner.account.address], { account: owner.account });
  await points.write.grantRole([BURNER_ROLE, redeemer.address], { account: owner.account });

  return { points, gov, escrow, redeemer, owner, alice, bob, carol, MINTER_ROLE, BURNER_ROLE };
}

export type PointsFixture = Awaited<ReturnType<typeof deployPointsFixture>>;
export type HookFixture = Awaited<ReturnType<typeof deployHookFixture>>;
export type RedeemerFixture = Awaited<ReturnType<typeof deployRedeemerFixture>>;
