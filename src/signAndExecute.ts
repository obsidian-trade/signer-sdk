import type { IRelayerClient } from "./relayerClient";
import type { SafeContractConfig, SafeTransaction } from "./types";
import type IAbstractSigner from "./types";
import {
  createPublicClient,
  zeroAddress,
  type Address,
  encodeFunctionData,
} from "viem";
import { safeAbi } from "./abi/safe";
import { polygon } from "viem/chains";
import { deriveSafe } from "./utils/derive";
import type { Chain, Hex } from "viem";
import { buildSafeTransactionRequest } from "./createSafeTransaction";

export async function signAndExecuteSafeTransaction(
  client: IRelayerClient,
  signer: IAbstractSigner,
  eoaAddress: Address,
  safeContractConfig: SafeContractConfig,
  transactions: SafeTransaction[],
  chain: Chain = polygon,
): Promise<{ txHash: string }> {
  const publicClient = createPublicClient({
    chain,
    transport: client.getTransport(),
  });

  const nonce = (await publicClient.readContract({
    address: deriveSafe(eoaAddress, safeContractConfig.SafeFactory),
    abi: safeAbi,
    functionName: "nonce",
  })) as bigint;


  const req = await buildSafeTransactionRequest(
    signer,
    {
      from: eoaAddress,
      chainId: chain.id,
      transactions: transactions,
      nonce: nonce.toString(),
    },
    safeContractConfig,
  );

  const execCalldata = encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [
      req.to as Address,
      0n,
      req.data as Hex,
      Number(req.signatureParams.operation),
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      req.signature as Hex,
    ],
  });

  const txHash = await client.sendTransactionSync({
    chainId: chain.id,
    to: req.proxyWallet as Address,
    data: execCalldata,
  });

  return { txHash: txHash.transactionHash };
}
