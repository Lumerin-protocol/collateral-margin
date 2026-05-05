import type { Account, Chain, PublicClient, WalletClient } from "viem";
import { erc20Abi } from "viem";
import type pino from "pino";
import { hashPowerPerpsDexAbi, ierc20PermitAbi, ierc5267Abi } from "./abi.ts";

const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Deposit `amount` of the perps' collateral token into the venue using ERC-2612 permit
 * (no prior approve tx needed). Token must implement EIP-2612; if it also implements
 * EIP-5267 we use that to discover the permit domain, otherwise we fall back to
 * `name()` + `version()`.
 */
export async function topUpCollateralWithPermit(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  perpsAddress: `0x${string}`;
  collateralTokenAddress: `0x${string}`;
  amount: bigint;
  logger: pino.Logger;
}): Promise<void> {
  const {
    publicClient,
    walletClient,
    account,
    chain,
    perpsAddress,
    collateralTokenAddress,
    amount,
    logger,
  } = opts;
  if (amount <= 0n) return;
  const owner = account.address;
  logger.info({ amount: amount.toString() }, "topping up collateral");

  const [nameResult, versionResult, nonceResult, eip712DomainResult] = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: collateralTokenAddress, abi: erc20Abi, functionName: "name" },
      {
        address: collateralTokenAddress,
        abi: [
          {
            inputs: [],
            name: "version",
            outputs: [{ internalType: "string", name: "", type: "string" }],
            stateMutability: "view",
            type: "function",
          },
        ],
        functionName: "version",
      },
      {
        address: collateralTokenAddress,
        abi: ierc20PermitAbi,
        functionName: "nonces",
        args: [owner],
      },
      {
        address: collateralTokenAddress,
        abi: ierc5267Abi,
        functionName: "eip712Domain",
      },
    ],
  });

  let domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  if (eip712DomainResult.status === "success") {
    const [, name, version, chainId, verifyingContract] = eip712DomainResult.result;
    domain = { name, version, chainId: Number(chainId), verifyingContract };
  } else {
    if (nameResult.status === "failure") throw nameResult.error;
    domain = {
      name: nameResult.result,
      version: versionResult.status === "success" ? versionResult.result || "1" : "1",
      chainId: chain.id,
      verifyingContract: collateralTokenAddress,
    };
  }

  if (nonceResult.status === "failure") throw nonceResult.error;
  const nonce = nonceResult.result;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: permitTypes,
    primaryType: "Permit",
    message: { owner, spender: perpsAddress, value: amount, nonce, deadline },
  });

  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  const hash = await walletClient.writeContract({
    address: perpsAddress,
    abi: hashPowerPerpsDexAbi,
    functionName: "addCollateralWithPermit",
    args: [amount, deadline, v, r, s],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  logger.info({ amount: amount.toString() }, "collateral topped up");
}
