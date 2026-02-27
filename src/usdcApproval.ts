import { RelayerClient } from "./relayerClient";

import type IAbstractSigner from "./types";
import type { SafeContractConfig } from "./types";
import { OperationType, type SafeTransaction } from "./types";
import { createPublicClient, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { deriveSafe } from "./utils/derive";
import { safeAbi } from "./abi/safe";
import { polygon } from "viem/chains";
import type { Chain } from "viem";
import { buildSafeTransactionRequest } from "./createSafeTransaction";
import { erc20Abi } from "./abi/erc20Abi";
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

export async function executeSafeWithUsdcApproval(
    client: RelayerClient,
    signer: IAbstractSigner,
    eoaAddress: Address,
    safeContractConfig: SafeContractConfig,
    railgunTx: { to: Address; data: string; value: bigint },
    usdcAmount: bigint,
    chainId: number = 137,
    chain: Chain = polygon,
): Promise<{ txHash: string }> {
    const publicClient = createPublicClient({
        chain,
        transport: client.getTransport(),
    });

    const nonce = await publicClient.readContract({
        address: deriveSafe(eoaAddress, safeContractConfig.SafeFactory),
        abi: safeAbi,
        functionName: "nonce",
    }) as bigint;

    console.log(`Nonce: ${nonce}`);

    const approveTx: SafeTransaction = {
        to: USDC_POLYGON,
        value: "0",
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [railgunTx.to, usdcAmount],
        }),
        operation: OperationType.Call,
    };

    const req = await buildSafeTransactionRequest(
        signer,
        {
            from: eoaAddress,
            chainId,
            transactions: [approveTx],
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
            0n, 0n, 0n,
            zeroAddress,
            zeroAddress,
            req.signature as Hex,
        ],
    });

    const txHash = await client.sendTransactionSync({
        chainId,
        to: req.proxyWallet as Address,
        data: execCalldata,
    });
    console.log("[Safe] execTransaction submitted:", txHash);
    return { txHash: txHash.transactionHash };
}