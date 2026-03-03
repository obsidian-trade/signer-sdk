import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { IRelayerClient } from "./relayerClient";
import {
  OperationType,
  type SafeContractConfig,
  type SafeTransaction,
} from "./types";
import { safeAbi } from "./abi/safe";
import { polygon } from "viem/chains";
import { deriveSafe } from "./utils/derive";
import { USDC_POLYGON } from "./constants";
import { buildSafeTransactionRequest } from "./createSafeTransaction";
import type IAbstractSigner from "./types";

export async function transferUsdcFromSafe(
  client: IRelayerClient,
  signer: IAbstractSigner,
  eoaAddress: Address,
  safeContractConfig: SafeContractConfig,
  toAddress: Address,
  usdcAmount: bigint,
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

  console.log(`Nonce: ${nonce}`);

  const transferTx: SafeTransaction = {
    to: USDC_POLYGON,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [toAddress, usdcAmount],
    }),
    operation: OperationType.Call,
  };

  const req = await buildSafeTransactionRequest(
    signer,
    {
      from: eoaAddress,
      chainId: chain.id,
      transactions: [transferTx],
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
  console.log("[Safe] execTransaction submitted:", txHash);
  return { txHash: txHash.transactionHash };
}
