import { encodeFunctionData, hexToSignature, type Address, type Hex } from "viem";
import type IAbstractSigner from "./types";
import type { SafeContractConfig } from "./types";
import { SAFE_FACTORY_NAME } from "./constants";
import { safeFactoryAbi } from "./abi/safeFactory";

export interface SafeCreateTransactionArgs {
    from: Address;
    chainId: number;
    paymentToken: string;
    payment: string;
    paymentReceiver: string;
}

async function createSafeCreateSignature(
    signer: IAbstractSigner,
    safeFactory: Address,
    chainId: number,
    paymentToken: string,
    payment: string,
    paymentReceiver: string
): Promise<string> {
    const domain = {
        name: SAFE_FACTORY_NAME,
        chainId: BigInt(chainId),
        verifyingContract: safeFactory,
    };
    const types = {
        CreateProxy: [
            { name: "paymentToken", type: "address" },
            { name: "payment", type: "uint256" },
            { name: "paymentReceiver", type: "address" },
        ],
    };

    const values = {
        paymentToken,
        payment: BigInt(payment),
        paymentReceiver,
    };
    const sig = await signer.signTypedData(domain, types, values, "CreateProxy");

    console.log(`Sig: ${sig}`);
    return sig;
}


export async function buildSafeCreateTransaction(
    signer: IAbstractSigner,
    safeContractConfig: SafeContractConfig,
    args: SafeCreateTransactionArgs,
) {
    const safeFactory = safeContractConfig.SafeFactory;

    const sig = await createSafeCreateSignature(
        signer, safeFactory, args.chainId,
        args.paymentToken, args.payment, args.paymentReceiver
    );

    // Split into v, r, s
    const { v, r, s } = hexToSignature(sig as Hex);

    const calldata = encodeFunctionData({
        abi: safeFactoryAbi,
        functionName: "createProxy",
        args: [
            args.paymentToken as Hex,
            BigInt(args.payment),
            args.paymentReceiver as Hex,
            { v: Number(v), r, s }
        ],
    });


    return {
        chainId: args.chainId,
        to: safeFactory as Hex,
        data: calldata,
    }
}

