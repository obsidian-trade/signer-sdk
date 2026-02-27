import { createPublicClient, encodeFunctionData, erc20Abi, hashTypedData, http, zeroAddress, type Address, type Hex } from "viem";
import { OperationType, TransactionType, type SafeContractConfig, type SafeTransaction, type SafeTransactionArgs, type SignatureParams, type TransactionRequest } from "./types";

import { createSafeMultisendTransaction } from "./utils/encode";
import { deriveSafe } from "./utils/derive";
import { splitAndPackSig } from "./utils";
import type IAbstractSigner from "./types";
import { polygon } from "viem/chains";
import { safeAbi } from "./abi/safe";
import { privateKeyToAccount } from "viem/accounts";
import type { IRelayerClient } from "./relayerClient";
import type { Chain } from "viem";

async function createSafeSignature(signer: IAbstractSigner, structHash: string): Promise<string> {
    return signer.signMessage(structHash);
}


export function aggregateTransaction(txns: SafeTransaction[], safeMultisend: string): SafeTransaction {
    let transaction: SafeTransaction;
    if (txns.length == 1) {
        transaction = txns[0] as SafeTransaction;
    } else {
        transaction = createSafeMultisendTransaction(txns, safeMultisend);
    }
    return transaction;
}

function createStructHash(
    chainId: number,
    safe: string,
    to: string,
    value: string,
    data: string,
    operation: OperationType,
    safeTxGas: string,
    baseGas: string,
    gasPrice: string,
    gasToken: string,
    refundReceiver: string,
    nonce: string
): string {
    const domain = {
        chainId: chainId,
        verifyingContract: safe as Hex,
    };

    const types = {
        // keccak256(
        //     "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
        // );
        SafeTx: [
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
            { name: 'operation', type: 'uint8' },
            { name: 'safeTxGas', type: 'uint256' },
            { name: 'baseGas', type: 'uint256' },
            { name: 'gasPrice', type: 'uint256' },
            { name: 'gasToken', type: 'address' },
            { name: 'refundReceiver', type: 'address' },
            { name: 'nonce', type: 'uint256' },
        ],
    };
    const values = {
        to: to,
        value: value,
        data: data,
        operation: operation,
        safeTxGas: safeTxGas,
        baseGas: baseGas,
        gasPrice: gasPrice,
        gasToken: gasToken,
        refundReceiver: refundReceiver,
        nonce: nonce,
    };

    // // viem hashTypedData
    // const structHash = _TypedDataEncoder.hash(domain, types, values);

    const structHash = hashTypedData({ primaryType: "SafeTx", domain: domain, types: types, message: values });
    return structHash;
}


export async function buildSafeTransactionRequest(
    signer: IAbstractSigner,
    args: SafeTransactionArgs,
    safeContractConfig: SafeContractConfig,
    metadata?: string,
): Promise<TransactionRequest> {
    const safeFactory = safeContractConfig.SafeFactory;
    const safeMultisend = safeContractConfig.SafeMultisend;
    const transaction = aggregateTransaction(args.transactions, safeMultisend);
    const safeTxnGas = "0";
    const baseGas = "0";
    const gasPrice = "0";
    const gasToken = zeroAddress;
    const refundReceiver = zeroAddress;

    const safeAddress = deriveSafe(args.from, safeFactory);

    // Generate the struct hash
    const structHash = createStructHash(
        args.chainId,
        safeAddress,
        transaction.to,
        transaction.value,
        transaction.data,
        transaction.operation,
        safeTxnGas,
        baseGas,
        gasPrice,
        gasToken,
        refundReceiver,
        args.nonce,
    );

    const sig = await createSafeSignature(signer, structHash);

    // Split the sig then pack it into Gnosis accepted rsv format
    const packedSig = splitAndPackSig(sig)

    const sigParams: SignatureParams = {
        gasPrice,
        operation: `${transaction.operation}`,
        safeTxnGas,
        baseGas,
        gasToken,
        refundReceiver,
    }

    if (metadata == undefined) {
        metadata = "";
    }

    const req = {
        from: args.from,
        to: transaction.to,
        proxyWallet: safeAddress,
        data: transaction.data,
        nonce: args.nonce,
        signature: packedSig,
        signatureParams: sigParams,
        type: TransactionType.SAFE,
        metadata: metadata,
    }

    console.log(`Created Safe Transaction Request: `);
    console.log(req);
    return req;
}

const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

export async function executeSafeWithUsdcApproval(
    client: IRelayerClient,
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
