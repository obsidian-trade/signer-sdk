import { describe, test, expect } from "bun:test";
import { createWalletClient, type Hex } from "viem";
import { http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount, type Address } from "viem/accounts";
import { RelayerClient, POL } from "./index";
import type IAbstractSigner from "./types";

const RELAY_TX = {
    to: "0x19b620929f97b7b990801496c3b361ca5def8c71" as const,
    data: "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002545524332303a207472616e736665722066726f6d20746865207a65726f2061646472657373000000000000000000000000000000000000000000000000" as const,
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

        const toAddress = "0xdE5DA69601810b72bE006957CC0c891BAEAaF7a6" as Address;
        const receipt = await relayer.transferUsdcFromSafe(account.address, POL.SafeContracts, toAddress, 1000n);
        expect(receipt).toBeDefined();
        expect(receipt.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
});
