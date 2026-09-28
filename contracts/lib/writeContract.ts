import type {
  Account,
  Chain,
  Transport,
  WalletClient,
  WriteContractParameters,
} from "viem";
import { waitForTransactionReceipt, writeContract } from "viem/actions";

export async function writeAndWait(
  walletClient: WalletClient<Transport, Chain, Account>,
  simulateResult: { request: WriteContractParameters },
) {
  const hash = await writeContract(walletClient, simulateResult.request);
  const receipt = await waitForTransactionReceipt(walletClient, { hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return receipt;
}
