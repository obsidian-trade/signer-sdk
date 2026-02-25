import { createWalletClient, type Hex } from "viem";
import { POL } from "./constants";
import { buildSafeCreateTransaction, type SafeCreateTransactionArgs } from "./deploySafe";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { http } from "viem";
import type IAbstractSigner from "./types";
import { createGelatoEvmRelayerClient } from "@gelatocloud/gasless";
import { deriveSafe } from "./derive";

const privateKey = process.env.PRIVATE_KEY as string;
if (!privateKey.startsWith("0x")) {
    throw new Error("PRIVATE_KEY must start with 0x");
}
const account = privateKeyToAccount(privateKey as `0x${string}`);
const client = createWalletClient({ account, chain: polygon, transport: http() });

const args: SafeCreateTransactionArgs = {
    from: account.address,
    chainId: 137,
    paymentToken: "0x0000000000000000000000000000000000000000",
    payment: "0",
    paymentReceiver: "0x0000000000000000000000000000000000000000",
};


const signer: IAbstractSigner = {
    signMessage: (msg) => account.sign({ hash: msg as Hex }),
    signTypedData: (domain, types, values, primaryType) =>
        client.signTypedData({ account, domain, types, message: values, primaryType }),
    getAddress: () => Promise.resolve(account.address),
};


export const GELATO_API_KEY = process.env.GELATO_API_KEY as string;

if (!GELATO_API_KEY) {
    throw new Error("GELATO_API_KEY is not set");

}

const gelato = createGelatoEvmRelayerClient({ apiKey: GELATO_API_KEY });


if (import.meta.main) {
    const safeAddress = deriveSafe(account.address, POL.SafeContracts.SafeFactory);
    console.log(`Safe Address: ${safeAddress}`);
    const result = await buildSafeCreateTransaction(signer, POL.SafeContracts, args);
    const txHash = await gelato.sendTransactionSync(result);
    console.log("Transaction hash:", txHash);
}