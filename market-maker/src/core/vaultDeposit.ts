import { erc20Abi } from "viem";
import type { Account, Chain, PublicClient, WalletClient } from "viem";
import type pino from "pino";

/**
 * Vault-deposit helper shared by both adapters.
 *
 * Both perps and futures are migrated to `CollateralVault`. The MM never calls
 * the per-product `addCollateralWithPermit` / `addMargin` paths anymore — it
 * deposits directly to the vault, and the venue contracts read balances via
 * `vault.balanceOf(user)`.
 *
 * Two paths are supported:
 *
 *   1. Permit (preferred). If the collateral token implements EIP-2612 we sign
 *      a permit and call `vault.depositForPermit(recipient, amount, deadline,
 *      v, r, s)` in one tx. Domain is discovered via EIP-5267 if the token
 *      implements it, else falls back to `name()` + `version()`.
 *
 *   2. Approve + deposit (fallback). Two txs: `erc20.approve(vault, amount)`
 *      then `vault.deposit(amount)`. Used when (1) fails for any reason — the
 *      detection is best-effort, not exhaustive.
 */

const ierc20PermitAbi = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "nonces",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" },
    ],
    name: "permit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ierc5267Abi = [
  {
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { internalType: "bytes1", name: "fields", type: "bytes1" },
      { internalType: "string", name: "name", type: "string" },
      { internalType: "string", name: "version", type: "string" },
      { internalType: "uint256", name: "chainId", type: "uint256" },
      { internalType: "address", name: "verifyingContract", type: "address" },
      { internalType: "bytes32", name: "salt", type: "bytes32" },
      { internalType: "uint256[]", name: "extensions", type: "uint256[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const tokenVersionAbi = [
  {
    inputs: [],
    name: "version",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const vaultAbi = [
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" },
    ],
    name: "depositForPermit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface DepositToVaultOpts {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  vaultAddress: `0x${string}`;
  collateralToken: `0x${string}`;
  amount: bigint;
  logger: pino.Logger;
}

/** Deposit `amount` of `collateralToken` from `account` into `vaultAddress`. */
export async function depositToVault(opts: DepositToVaultOpts): Promise<void> {
  const { amount, logger } = opts;
  if (amount <= 0n) return;
  logger.info({ amount: amount.toString(), vault: opts.vaultAddress }, "depositing to vault");

  const usePermit = await tryPermitDeposit(opts);
  if (usePermit) return;

  // Fallback: approve + deposit.
  await approveAndDeposit(opts);
}

async function tryPermitDeposit(opts: DepositToVaultOpts): Promise<boolean> {
  const { publicClient, walletClient, account, chain, vaultAddress, collateralToken, amount, logger } = opts;

  // Discover permit domain. If nonces() reverts, the token doesn't implement
  // EIP-2612 — bail out cleanly.
  const owner = account.address;
  const reads = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: collateralToken, abi: erc20Abi, functionName: "name" },
      { address: collateralToken, abi: tokenVersionAbi, functionName: "version" },
      { address: collateralToken, abi: ierc20PermitAbi, functionName: "nonces", args: [owner] },
      { address: collateralToken, abi: ierc5267Abi, functionName: "eip712Domain" },
    ],
  });
  const [nameResult, versionResult, nonceResult, domainResult] = reads;

  if (nonceResult.status === "failure") {
    logger.debug("token does not implement EIP-2612 (nonces reverted)");
    return false;
  }

  let domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  if (domainResult.status === "success") {
    const [, dName, dVersion, dChainId, dVerifyingContract] = domainResult.result;
    domain = { name: dName, version: dVersion, chainId: Number(dChainId), verifyingContract: dVerifyingContract };
  } else {
    if (nameResult.status === "failure") {
      logger.warn({ err: nameResult.error }, "token has no name(); using approve fallback");
      return false;
    }
    domain = {
      name: nameResult.result,
      version: versionResult.status === "success" ? versionResult.result || "1" : "1",
      chainId: chain.id,
      verifyingContract: collateralToken,
    };
  }

  const nonce = nonceResult.result;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: permitTypes,
    primaryType: "Permit",
    message: { owner, spender: vaultAddress, value: amount, nonce, deadline },
  });

  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  try {
    const hash = await walletClient.writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "depositForPermit",
      args: [owner, amount, deadline, v, r, s],
      account,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    logger.info({ amount: amount.toString() }, "vault deposit (permit) confirmed");
    return true;
  } catch (err) {
    logger.warn({ err }, "depositForPermit failed; falling back to approve+deposit");
    return false;
  }
}

async function approveAndDeposit(opts: DepositToVaultOpts): Promise<void> {
  const { publicClient, walletClient, account, chain, vaultAddress, collateralToken, amount, logger } = opts;

  logger.info({ amount: amount.toString() }, "approving vault to spend collateral");
  const approveHash = await walletClient.writeContract({
    address: collateralToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [vaultAddress, amount],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const depositHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: "deposit",
    args: [amount],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  logger.info({ amount: amount.toString() }, "vault deposit (approve+deposit) confirmed");
}
