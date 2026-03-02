import { http, createPublicClient, type Address, type Hex } from "viem";
import type { Chain } from "viem";
import type { TransactionReceipt } from "viem";
import { polygon } from "viem/chains";
import { createGelatoEvmRelayerClient } from "@gelatocloud/gasless";
import {
  buildSafeTransactionRequest,
  executeSafeWithUsdcApproval,
  aggregateTransaction,
} from "./createSafeTransaction";
import {
  buildSafeCreateTransaction,
  type SafeCreateTransactionArgs,
} from "./deploySafe";
import { deriveSafe } from "./utils/derive";
import type IAbstractSigner from "./types";
import type {
  SafeContractConfig,
  SafeTransaction,
  SafeTransactionArgs,
  TransactionRequest,
} from "./types";
import { safeAbi } from "./abi/safe";

export type RelayerType = "gelato" | "backend";

export interface RelayerClientConfig {
  rpcUrl: string;
  relayer: RelayerType;
  /** Optional. Omit for relay-only usage (sendTransactionSync, deriveSafeFromEOA, aggregateTransaction, isSafeDeployed). */
  signer?: IAbstractSigner;
  chain?: Chain;
  apiKey?: string;
  backendUrl?: string;
}

export interface SendTransactionParams {
  chainId: number;
  to: Address;
  data: Hex;
  gas?: bigint;
  skipSimulation?: boolean;
  authorizationList?: unknown[];
  timeout?: number;
}

export interface IRelayerClient {
  getTransport(): ReturnType<typeof http>;
  sendTransactionSync(
    params: SendTransactionParams,
  ): Promise<TransactionReceipt>;
}

export class RelayerClient implements IRelayerClient {
  private rpcUrl: string;
  private apiKey: string | undefined;
  private backendUrl: string | undefined;
  private relayer: RelayerType;
  private chain: Chain;
  private signer: IAbstractSigner | undefined;
  private publicClient: ReturnType<typeof createPublicClient>;
  private _gelato: ReturnType<typeof createGelatoEvmRelayerClient> | null =
    null;

  constructor(config: RelayerClientConfig) {
    this.rpcUrl = config.rpcUrl;
    this.apiKey = config.apiKey;
    this.backendUrl = config.backendUrl;
    this.relayer = config.relayer;
    this.chain = config.chain ?? polygon;
    this.signer = config.signer;
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: this.getTransport(),
    });

    if (this.relayer === "gelato" && !this.apiKey) {
      throw new Error("apiKey is required for gelato relayer");
    }
    if (this.relayer === "backend" && !config.backendUrl) {
      throw new Error("backendUrl is required for backend relayer");
    }
  }

  getTransport() {
    return http(this.rpcUrl || this.chain.rpcUrls.default.http[0]);
  }

  private requireSigner(): IAbstractSigner {
    if (!this.signer) {
      throw new Error(
        "RelayerClient: signer is required for this operation. Pass signer in config or use a relayer instance created with signer.",
      );
    }
    return this.signer;
  }

  async sendTransactionSync(
    params: SendTransactionParams,
  ): Promise<TransactionReceipt> {
    if (this.relayer === "gelato") {
      if (!this._gelato) {
        this._gelato = createGelatoEvmRelayerClient({ apiKey: this.apiKey! });
      }
      return this._gelato.sendTransactionSync(
        {
          chainId: params.chainId,
          to: params.to,
          data: params.data,
          gas: params.gas,
          skipSimulation: params.skipSimulation,
          ...(params.authorizationList != null && {
            authorizationList:
              params.authorizationList as import("viem").SignedAuthorizationList,
          }),
        },
        params.timeout != null ? { timeout: params.timeout } : undefined,
      );
    }
    if (this.relayer === "backend") {
      const body = {
        chainId: String(params.chainId),
        to: params.to,
        data: params.data,
        ...(params.authorizationList != null && {
          authorizationList: params.authorizationList,
        }),
        ...(params.timeout != null && { timeout: params.timeout }),
      };

      let url = `${this.backendUrl}/api/relayer/relay_transaction`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        credentials: "include",
      });

      console.log("Response from backend:", res.status);

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Backend relayer failed: ${res.status} ${err}`);
      }
      const receipt = (await res.json()) as TransactionReceipt;
      return receipt;
    }
    throw new Error("Unsupported relayer");
  }

  deriveSafeFromEOA(from: Address, safeFactory: Address): Address {
    return deriveSafe(from, safeFactory);
  }

  aggregateTransaction(
    txns: SafeTransaction[],
    safeMultisend: Address,
  ): SafeTransaction {
    return aggregateTransaction(txns, safeMultisend);
  }

  async buildSafeTransactionRequest(
    args: SafeTransactionArgs,
    safeContractConfig: SafeContractConfig,
    metadata?: string,
  ): Promise<TransactionRequest> {
    return buildSafeTransactionRequest(
      this.requireSigner(),
      args,
      safeContractConfig,
      metadata,
    );
  }

  async getNonce(safeContractConfig: SafeContractConfig) {
    const signer = this.requireSigner();
    const eoaAddress = (await signer.getAddress()) as Address;
    const nonce = (await this.publicClient.readContract({
      address: deriveSafe(eoaAddress, safeContractConfig.SafeFactory),
      abi: safeAbi,
      functionName: "nonce",
    })) as bigint;

    return nonce;
  }

  async approveUsdc(
    eoaAddress: Address,
    safeContractConfig: SafeContractConfig,
    railgunTx: { to: Address; data: string; value: bigint },
    usdcAmount: bigint,
    chainId?: number,
  ): Promise<{ txHash: string }> {
    return executeSafeWithUsdcApproval(
      this,
      this.requireSigner(),
      eoaAddress,
      safeContractConfig,
      railgunTx,
      usdcAmount,
      chainId ?? this.chain.id,
      this.chain,
    );
  }

  async buildSafeCreateTransaction(
    safeContractConfig: SafeContractConfig,
    args: SafeCreateTransactionArgs,
  ) {
    return buildSafeCreateTransaction(
      this.requireSigner(),
      safeContractConfig,
      args,
    );
  }

  async isSafeDeployed(safeAddress: Address): Promise<boolean> {
    const bytecode = await this.publicClient.getBytecode({
      address: safeAddress as Address,
    });
    return bytecode !== undefined && bytecode !== "0x";
  }

  async deploySafe(
    safeContractConfig: SafeContractConfig,
    args: SafeCreateTransactionArgs,
  ): Promise<TransactionReceipt> {
    this.requireSigner();
    const safeAddress = deriveSafe(args.from, safeContractConfig.SafeFactory);
    if (await this.isSafeDeployed(safeAddress)) {
      throw new Error("Safe is already deployed");
    }
    const tx = await this.buildSafeCreateTransaction(safeContractConfig, args);
    return this.sendTransactionSync(tx);
  }
}
