import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";
import { safeAbi } from "./abi/safe";
import { buildSafeTransactionRequest } from "./builder";
import { deriveSafe } from "./builder/derive";
import { USDC_POLYGON } from "./constants";
import type { SafeContractConfig } from "./config";
import type IAbstractSigner from "./signer";
import { OperationType, type SafeTransaction } from "./types";

export interface TransactionSubmitter {
  sendTransactionSync(params: {
    chainId: number;
    to: Address;
    data: Hex;
  }): Promise<{ transactionHash: string }>;
}

export class SafeExecutor {
  constructor(
    private readonly transport: ReturnType<typeof http>,
    private readonly signer: IAbstractSigner,
    private readonly submitter: TransactionSubmitter,
    private readonly chain: Chain = polygon,
  ) {}

  async signAndExecuteSafeTransaction(
    eoaAddress: Address,
    safeContractConfig: SafeContractConfig,
    transactions: SafeTransaction[],
  ): Promise<{ txHash: string }> {
    const publicClient = createPublicClient({ chain: this.chain, transport: this.transport });

    const nonce = (await publicClient.readContract({
      address: deriveSafe(eoaAddress, safeContractConfig.SafeFactory) as `0x${string}`,
      abi: safeAbi,
      functionName: "nonce",
    })) as bigint;

    const req = await buildSafeTransactionRequest(
      this.signer,
      {
        from: eoaAddress,
        chainId: this.chain.id,
        transactions,
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

    const txHash = await this.submitter.sendTransactionSync({
      chainId: this.chain.id,
      to: req.proxyWallet as Address,
      data: execCalldata,
    });

    return { txHash: txHash.transactionHash };
  }

  async transferUsdcFromSafe(
    eoaAddress: Address,
    safeContractConfig: SafeContractConfig,
    toAddress: Address,
    usdcAmount: bigint,
  ): Promise<{ txHash: string }> {
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

    return this.signAndExecuteSafeTransaction(
      eoaAddress,
      safeContractConfig,
      [transferTx],
    );
  }

  async approveUsdcFromSafe(
    eoaAddress: Address,
    safeContractConfig: SafeContractConfig,
    spender: Address,
    usdcAmount: bigint,
  ): Promise<{ txHash: string }> {
    const approveTx: SafeTransaction = {
      to: USDC_POLYGON,
      value: "0",
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, usdcAmount],
      }),
      operation: OperationType.Call,
    };

    return this.signAndExecuteSafeTransaction(
      eoaAddress,
      safeContractConfig,
      [approveTx],
    );
  }
}
