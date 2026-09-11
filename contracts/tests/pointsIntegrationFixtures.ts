import type { NetworkConnection } from "hardhat/types/network";
import type { ArtifactMap } from "hardhat/types/artifacts";
import { getContract } from "viem";
import type { Abi, Address, GetContractReturnType, PublicClient, WalletClient } from "viem";
import { KEEPER_POINTS, NOTIONAL, W_MAKER, W_TAKER } from "./pointsFixtures.js";

// Contract ABIs mapping from Hardhat's artifact map.
type ContractAbis = {
  [K in keyof ArtifactMap]: ArtifactMap[K] extends { abi: infer A } ? A : never;
};

type ContractInstance<ContractName extends keyof ContractAbis> = GetContractReturnType<
  ContractAbis[ContractName],
  { public: PublicClient; wallet: WalletClient },
  Address
>;

/**
 * Deploy a contract from its compiled Hardhat artifact JSON using raw viem.
 *
 * The points-indexer hardhat project has no Solidity sources of its own, so we
 * cannot use `viem.deployContract(name)` (it resolves artifacts from the current
 * project). Instead we read the artifact emitted by the contracts package and
 * deploy its bytecode directly — the same approach the futures indexer uses.
 */
export async function deployContract<ContractName extends keyof ContractAbis>(
  walletClient: WalletClient,
  publicClient: PublicClient,
  artifactPath: string,
  args: unknown[] = [],
): Promise<ContractInstance<ContractName>> {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(new URL(artifactPath, import.meta.url), "utf-8");
  const artifact = JSON.parse(content);

  const abi = artifact.abi as Abi;
  const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as `0x${string}`;

  const { deployContract: viemDeploy } = await import("viem/actions");
  if (walletClient.account === undefined) {
    throw new Error("Wallet client must have an account");
  }
  const txHash = await viemDeploy(walletClient, {
    abi,
    bytecode,
    args,
    account: walletClient.account,
    chain: walletClient.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new Error("Contract deployment failed: no contract address in receipt");
  }

  return getContract({
    address: receipt.contractAddress,
    abi,
    client: { public: publicClient, wallet: walletClient, chain: walletClient.chain },
  }) as unknown as ContractInstance<ContractName>;
}

const ARTIFACTS = {
  points: "../artifacts/contracts/Points.sol/Points.json",
  hook: "../artifacts/contracts/PointsHook.sol/PointsHook.json",
  redeemer: "../artifacts/contracts/PointsRedeemer.sol/PointsRedeemer.json",
  gov: "../artifacts/contracts/mocks/GovTokenMock.sol/GovTokenMock.json",
  escrow: "../artifacts/contracts/mocks/VestingEscrowMock.sol/VestingEscrowMock.json",
} as const;

export { KEEPER_POINTS, NOTIONAL, W_MAKER, W_TAKER };

/** Taker points for one `NOTIONAL` fill at `W_TAKER` (1000 POINTS, 6 decimals). */
export const TAKER_PTS = (NOTIONAL * W_TAKER) / 10n ** 18n;
/** Maker points for one `NOTIONAL` fill at `W_MAKER` (1500 POINTS, 6 decimals). */
export const MAKER_PTS = (NOTIONAL * W_MAKER) / 10n ** 18n;
/** A fee comfortably above any minimum threshold (1 unit, 6 decimals). */
export const FEE = 1_000_000n;

/**
 * Full points stack on one chain, wired exactly as production deploys it:
 *   - `Points` (HP ledger), admin = owner,
 *   - `PointsHook` holds POINTS `MINTER_ROLE`; `venue` wallet holds `HOOK_CALLER_ROLE`
 *     (stands in for the perps / futures venue contract),
 *   - `PointsRedeemer` holds POINTS `BURNER_ROLE`, funded from a `GovTokenMock` pool and
 *     escrowing the locked half into a `VestingEscrowMock`.
 *
 * Returns the live viem contract handles plus their ABIs so the matchstick harness can
 * `bind("Points", …)` / `bind("PointsRedeemer", …)` against the deployed addresses.
 */
export async function deployPointsStackFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice, bob, carol, venue, keeper] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  const points = await deployContract<"Points">(owner, pc, ARTIFACTS.points, [
    owner.account.address,
  ]);
  const hook = await deployContract<"PointsHook">(owner, pc, ARTIFACTS.hook, [
    points.address,
    owner.account.address,
    W_MAKER,
    W_TAKER,
    KEEPER_POINTS,
  ]);
  const gov = await deployContract<"GovTokenMock">(owner, pc, ARTIFACTS.gov, []);
  const escrow = await deployContract<"VestingEscrowMock">(owner, pc, ARTIFACTS.escrow, []);
  const redeemer = await deployContract<"PointsRedeemer">(owner, pc, ARTIFACTS.redeemer, [
    points.address,
    gov.address,
    escrow.address,
    owner.account.address,
  ]);

  const MINTER_ROLE = await points.read.MINTER_ROLE();
  const BURNER_ROLE = await points.read.BURNER_ROLE();
  const HOOK_CALLER_ROLE = await hook.read.HOOK_CALLER_ROLE();
  await points.write.grantRole([MINTER_ROLE, hook.address], { account: owner.account, chain: null });
  await points.write.grantRole([BURNER_ROLE, redeemer.address], { account: owner.account, chain: null });
  await hook.write.grantRole([HOOK_CALLER_ROLE, venue.account.address], {
    account: owner.account,
    chain: null,
  });

  return {
    contracts: { points, hook, gov, escrow, redeemer },
    accounts: { owner, alice, bob, carol, venue, keeper, pc },
    roles: { MINTER_ROLE, BURNER_ROLE, HOOK_CALLER_ROLE },
  };
}

export type PointsStackFixture = Awaited<ReturnType<typeof deployPointsStackFixture>>;
