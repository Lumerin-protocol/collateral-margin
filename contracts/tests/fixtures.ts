import type { NetworkConnection } from "hardhat/types/network";
import { encodeFunctionData, maxUint256 } from "viem";

/** Index price used by the PME oracle mock and as perps mock entry price ($50k, token decimals). */
export const DEFAULT_MARKET_PRICE = 50_000_000_000n;

const VAULT_TEST_TOP_UP = 100_000_000_000n; // 100k USDC for alice, bob, engine

const PME_OWNER_DEPOSIT = 50_000_000_000n; // 50k USDC — vault balance for PME unit tests

const INTEGRATION_ALICE_TRANSFER = 100_000_000_000n;

/** Alice vault balance after setup in `deployCrossMarginIntegrationFixture` (50k USDC, 6 decimals). */
export const INTEGRATION_ALICE_DEPOSIT = 50_000_000_000n;

/** Deploy USDC mock + CollateralVault behind ERC1967 proxy (initialized). */
export async function deployCollateralVaultProxy(conn: NetworkConnection) {
  const { viem } = conn;
  const usdc = await viem.deployContract("USDCMock", []);
  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [usdc.address],
    }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);
  return { usdc, vault };
}

/** Perps + options mocks + PortfolioMarginEngine proxy wired to an existing vault. */
export async function deployPortfolioMarginEngineStack(
  conn: NetworkConnection,
  vaultAddress: `0x${string}`,
) {
  const { viem } = conn;
  const perpsMock = await viem.deployContract("PerpsDEXMock", []);
  const optionsMock = await viem.deployContract("OptionsEngineMock", []);
  const futuresMock = await viem.deployContract("FuturesMock", []);
  // PME's own index oracle — spot source for stress math (6 decimals, $50k).
  const oracleMock = await viem.deployContract("PriceOracleMock", [DEFAULT_MARKET_PRICE, 6]);
  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);
  // The PME pins each product to its own vault at registration.
  await perpsMock.write.setVault([vaultAddress]);
  await futuresMock.write.setVault([vaultAddress]);
  await optionsMock.write.setVault([vaultAddress]);
  await pme.write.setVault([vaultAddress]);
  await pme.write.addLinearMarket([perpsMock.address]);
  await pme.write.addLinearMarket([futuresMock.address]);
  await pme.write.setOptions([optionsMock.address]);
  await pme.write.setOracle([oracleMock.address]);
  return { perpsMock, optionsMock, futuresMock, oracleMock, pme };
}

/** CollateralVault tests: fund alice, bob, engine; approvals for deposit flows. */
export async function deployVaultFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice, bob, engine] = await viem.getWalletClients();
  const { usdc, vault } = await deployCollateralVaultProxy(conn);

  for (const w of [alice, bob, engine]) {
    await usdc.write.transfer([w.account.address, VAULT_TEST_TOP_UP], { account: owner.account });
    await usdc.write.approve([vault.address, maxUint256], { account: w.account });
  }
  await usdc.write.approve([vault.address, maxUint256], { account: owner.account });

  return { vault, usdc, owner, alice, bob, engine };
}

/** Alice balance after `deployVaultAuthorizedOperationsFixture` (10 USDC deposited). */
export const VAULT_AUTH_OPS_ALICE_DEPOSIT = 10_000_000n;

/** Vault + engine authorized + Alice 10 USDC deposit (authorized-caller tests). */
export async function deployVaultAuthorizedOperationsFixture(conn: NetworkConnection) {
  const ctx = await deployVaultFixture(conn);
  const { vault, owner, alice, engine } = ctx;

  await vault.write.setAuthorizedCaller([engine.account.address, true], {
    account: owner.account,
  });
  await vault.write.deposit([VAULT_AUTH_OPS_ALICE_DEPOSIT], { account: alice.account });
  return ctx;
}

/** PortfolioMarginEngine unit tests: owner-funded vault, PME as margin engine. */
export async function deployPortfolioMarginEngineFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner] = await viem.getWalletClients();
  const { usdc, vault } = await deployCollateralVaultProxy(conn);
  const { perpsMock, optionsMock, futuresMock, oracleMock, pme } = await deployPortfolioMarginEngineStack(
    conn,
    vault.address,
  );

  const user = owner.account.address;
  await usdc.write.approve([vault.address, maxUint256], { account: owner.account });
  await vault.write.deposit([PME_OWNER_DEPOSIT], { account: owner.account });
  await vault.write.setMarginEngine([pme.address], { account: owner.account });

  return { vault, perpsMock, optionsMock, futuresMock, oracleMock, pme, usdc, user, owner };
}

/** End-to-end: vault + PME + product mocks, Alice funded and deposited. */
export async function deployCrossMarginIntegrationFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, alice] = await viem.getWalletClients();
  const { usdc, vault } = await deployCollateralVaultProxy(conn);
  const { perpsMock, optionsMock, futuresMock, pme } = await deployPortfolioMarginEngineStack(
    conn,
    vault.address,
  );

  await vault.write.setMarginEngine([pme.address], { account: owner.account });
  await vault.write.setAuthorizedCaller([perpsMock.address, true], { account: owner.account });
  await vault.write.setAuthorizedCaller([optionsMock.address, true], { account: owner.account });
  await vault.write.setAuthorizedCaller([futuresMock.address, true], { account: owner.account });

  const aliceAddr = alice.account.address;
  await usdc.write.transfer([aliceAddr, INTEGRATION_ALICE_TRANSFER], { account: owner.account });

  await usdc.write.approve([vault.address, maxUint256], { account: alice.account });
  await vault.write.deposit([INTEGRATION_ALICE_DEPOSIT], { account: alice.account });

  return {
    vault,
    pme,
    perpsMock,
    optionsMock,
    futuresMock,
    usdc,
    owner,
    alice,
    aliceAddr,
  };
}

export type VaultFixture = Awaited<ReturnType<typeof deployVaultFixture>>;
export type PortfolioMarginEngineFixture = Awaited<ReturnType<typeof deployPortfolioMarginEngineFixture>>;
export type CrossMarginIntegrationFixture = Awaited<ReturnType<typeof deployCrossMarginIntegrationFixture>>;
