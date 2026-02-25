import { describe, test, expect } from "bun:test";
import { createWalletClient, type Hex } from "viem";
import { http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { RelayerClient, POL } from "./index";
import type IAbstractSigner from "./types";

const RELAY_TX = {
    to: "0x" as const,
    data: "0x" as const,
    gasLimit: "1332838",
};

describe("exec flow", () => {
    test("full flow: deriveSafeFromEOA, isSafeDeployed, deploySafe if needed, sendTransactionSync via relayer", async () => {
        const privateKey = process.env.PRIVATE_KEY as string;
        const rpcUrl = process.env.RPC_URL || "https://polygon-rpc.com";
        const backendUrl = process.env.BACKEND_URL || "http://localhost:3000";
        const apiKey = process.env.GELATO_API_KEY;

        if (!privateKey?.startsWith("0x")) {
            throw new Error("PRIVATE_KEY env (0x-prefixed) required for integration test");
        }

        const account = privateKeyToAccount(privateKey as `0x${string}`);
        const client = createWalletClient({
            account,
            chain: polygon,
            transport: http(rpcUrl),
        });
        const signer: IAbstractSigner = {
            signMessage: (msg) => account.sign({ hash: msg as Hex }),
            signTypedData: (domain, types, values, primaryType) =>
                client.signTypedData({ account, domain, types, message: values, primaryType }),
            getAddress: () => Promise.resolve(account.address),
        };

        const relayer = new RelayerClient({
            rpcUrl,
            apiKey,
            relayer: "backend",
            backendUrl,
            signer,
        });

        const safeAddress = relayer.deriveSafeFromEOA(account.address, POL.SafeContracts.SafeFactory);
        expect(safeAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

        const isSafeDeployed = await relayer.isSafeDeployed(safeAddress);
        expect(typeof isSafeDeployed).toBe("boolean");

        if (!isSafeDeployed) {
            const receipt = await relayer.deploySafe(POL.SafeContracts, {
                from: account.address,
                chainId: 137,
                paymentToken: "0x0000000000000000000000000000000000000000",
                payment: "0",
                paymentReceiver: "0x0000000000000000000000000000000000000000",
            });
            expect(receipt).toBeDefined();
            expect(receipt.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        }

        const receipt = await relayer.sendTransactionSync({
            chainId: 137,
            to: RELAY_TX.to,
            data: RELAY_TX.data,
            gas: BigInt(RELAY_TX.gasLimit),
        });
        expect(receipt).toBeDefined();
        expect(receipt.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
});
