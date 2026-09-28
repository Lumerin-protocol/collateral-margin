/**
 * Deploys a CollateralVault proxy from the contracts package artifacts.
 * The indexer Hardhat project has no Solidity sources, so `viem.deployContract`
 * cannot resolve them.
 */
import { readFile } from "node:fs/promises";
import type { NetworkConnection } from "hardhat/types/network";
import type { EntityFields } from "matchstick-ts";
import {
  encodeFunctionData,
  getContract,
  maxUint256,
  type Abi,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { deployContract as viemDeploy } from "viem/actions";

export const FUND = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const ZERO = "0x0000000000000000000000000000000000000000";

type Matchstick = NetworkConnection["matchstick"];

export async function watch(matchstick: Matchstick, vault: { address: `0x${string}`; abi: Abi }): Promise<void> {
  matchstick.bind("CollateralVault", vault.address, vault.abi);
  await matchstick.captureViewMocks();
}

const ARTIFACTS = {
  usdc: "../../contracts/artifacts/contracts/mocks/USDCMock.sol/USDCMock.json",
  vault: "../../contracts/artifacts/contracts/CollateralVault.sol/CollateralVault.json",
  proxy: "../../contracts/artifacts/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json",
  engine: "../../contracts/artifacts/contracts/mocks/MarginEngineMock.sol/MarginEngineMock.json",
} as const;

type Artifact = { abi: Abi; bytecode: { object: `0x${string}` } | `0x${string}` };

async function loadArtifact(path: string): Promise<Artifact> {
  const content = await readFile(new URL(path, import.meta.url), "utf8");
  return JSON.parse(content) as Artifact;
}

function bytecodeOf(artifact: Artifact): `0x${string}` {
  return typeof artifact.bytecode === "string" ? artifact.bytecode : artifact.bytecode.object;
}

async function deploy(
  wallet: WalletClient,
  publicClient: PublicClient,
  artifact: Artifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  if (wallet.account === undefined) throw new Error("Wallet client must have an account");
  const hash = await viemDeploy(wallet, {
    abi: artifact.abi,
    bytecode: bytecodeOf(artifact),
    args: [...args],
    account: wallet.account,
    chain: wallet.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("Deployment receipt has no contract address");
  return receipt.contractAddress;
}

export async function deployVaultFixture(connection: NetworkConnection) {
  const [owner, alice, bob, engine] = await connection.viem.getWalletClients();
  const publicClient = await connection.viem.getPublicClient();
  if (owner === undefined || alice === undefined || bob === undefined || engine === undefined) {
    throw new Error("Hardhat did not provide the expected wallets");
  }

  const usdcArtifact = await loadArtifact(ARTIFACTS.usdc);
  const vaultArtifact = await loadArtifact(ARTIFACTS.vault);
  const proxyArtifact = await loadArtifact(ARTIFACTS.proxy);

  const usdcAddress = await deploy(owner, publicClient, usdcArtifact);
  const implementation = await deploy(owner, publicClient, vaultArtifact);
  const initData = encodeFunctionData({
    abi: vaultArtifact.abi,
    functionName: "initialize",
    args: [usdcAddress],
  });
  const vaultAddress = await deploy(owner, publicClient, proxyArtifact, [implementation, initData]);

  const usdc = getContract({
    address: usdcAddress,
    abi: usdcArtifact.abi,
    client: { public: publicClient, wallet: owner },
  });
  const vault = getContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    client: { public: publicClient, wallet: owner },
  });

  await usdc.write.transfer([alice.account.address, 1_000_000n], { account: owner.account, chain: null });
  await usdc.write.approve([vaultAddress, maxUint256], { account: alice.account, chain: null });
  await usdc.write.approve([vaultAddress, maxUint256], { account: owner.account, chain: null });
  await vault.write.setAuthorizedCaller([engine.account.address, true], {
    account: owner.account,
    chain: null,
  });

  return { vault, usdc, accounts: { owner, alice, bob, engine } };
}

/** A margin engine the vault will accept, pinned to this vault, with a zero requirement. */
export async function deployMarginEngine(
  connection: NetworkConnection,
  owner: WalletClient,
  vaultAddress: Address,
) {
  const publicClient = await connection.viem.getPublicClient();
  const artifact = await loadArtifact(ARTIFACTS.engine);
  const address = await deploy(owner, publicClient, artifact);
  const engine = getContract({
    address,
    abi: artifact.abi,
    client: { public: publicClient, wallet: owner },
  });
  await engine.write.setVault([vaultAddress], { account: owner.account, chain: null });
  return engine;
}

export function num(value: unknown): string {
  return String(value);
}

export function lower(value: unknown): string {
  return String(value).toLowerCase();
}

export function findUser(rows: readonly EntityFields[], address: string): EntityFields | undefined {
  const id = address.toLowerCase();
  return rows.find((row) => String(row.id).toLowerCase() === id);
}

export function accountOf(rows: readonly EntityFields[], address: string): EntityFields | undefined {
  return findUser(rows, address);
}
