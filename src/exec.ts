import { createWalletClient, type Hex } from "viem";
import { http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { RelayerClient, POL } from "./index";
import type IAbstractSigner from "./types";

const privateKey = process.env.PRIVATE_KEY as string;
if (!privateKey.startsWith("0x")) {
    throw new Error("PRIVATE_KEY must start with 0x");
}
const account = privateKeyToAccount(privateKey as `0x${string}`);
const client = createWalletClient({ account, chain: polygon, transport: http(process.env.RPC_URL || "https://polygon-rpc.com") });

const signer: IAbstractSigner = {
    signMessage: (msg) => account.sign({ hash: msg as Hex }),
    signTypedData: (domain, types, values, primaryType) =>
        client.signTypedData({ account, domain, types, message: values, primaryType }),
    getAddress: () => Promise.resolve(account.address),
};


const relayer = new RelayerClient({
    rpcUrl: process.env.RPC_URL || "https://polygon-mainnet.g.alchemy.com/v2/XRpSi7BvVRU0_KVUbx-qR",
    apiKey: process.env.GELATO_API_KEY as string,
    relayer: "backend",
    backendUrl: "http://localhost:3000",
    signer,
});


const safeAddress = relayer.deriveSafeFromEOA(account.address, POL.SafeContracts.SafeFactory);
const isSafeDeployed = await relayer.isSafeDeployed(safeAddress);

console.log("Safe deployed:", isSafeDeployed);
console.log("Safe address:", safeAddress);
if (!isSafeDeployed) {
    const receipt = await relayer.deploySafe(POL.SafeContracts, {
        from: account.address,
        chainId: 137,
        paymentToken: "0x0000000000000000000000000000000000000000",
        payment: "0",
        paymentReceiver: "0x0000000000000000000000000000000000000000",
    });
    console.log("Transaction hash:", receipt.transactionHash);
}

console.log("Approving USDC...");
const approveTx = await relayer.approveUsdc(account.address, POL.SafeContracts, { to: account.address, data: "0x", value: 0n }, 1000000000000000000n);
console.log("Approve transaction hash:", approveTx.txHash);