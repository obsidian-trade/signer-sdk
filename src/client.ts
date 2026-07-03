import {
    BaseError,
    ContractFunctionRevertedError,
    createPublicClient,
    ExecutionRevertedError,
    http,
    RawContractError,
    type Chain,
    type PublicClient,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import { polygon } from "viem/chains";
import {
    GET,
    POST,
    HttpClient,
    type RequestOptions,
} from "./http-helpers";
import {
    CallType,
    type DepositWalletCall,
    type DepositWalletTransactionArgs,
    type GetDeployedResponse,
    type NoncePayload,
    OperationType,
    type ProxyTransaction,
    type ProxyTransactionArgs,
    type RelayerTransaction,
    type RelayerTransactionResponse,
    RelayerTxType,
    type RelayPayload,
    type SafeCreateTransactionArgs,
    type SafeTransaction,
    type SafeTransactionArgs,
    type Transaction,
    TransactionType,
    RelayDataSource,
    RelayerTransactionState,
} from "./types";

import {
    buildSafeTransactionRequest,
    buildSafeCreateTransactionRequest,
    buildProxyTransactionRequest,
    buildDepositWalletBatchRequest,
    buildDepositWalletCreateRequest,
    deriveSafe,
} from "./builder";
import { deriveBeaconDepositWallet, deriveProxyWallet, deriveUupsDepositWallet } from "./builder/derive";
import { sleep } from "./utils";
import { ClientRelayerTransactionResponse } from "./response";
import { type ContractConfig, getContractConfig, isProxyContractConfigValid, isSafeContractConfigValid, isDepositWalletContractConfigValid } from "./config";
import { CONFIG_UNSUPPORTED_ON_CHAIN, SAFE_DEPLOYED, SAFE_NOT_DEPLOYED, SIGNER_UNAVAILABLE } from "./errors";
import { encodeProxyTransactionData } from "./encode";
import type IAbstractSigner from "./signer";
import { safeAbi } from "./abi/safe";
import { depositWalletV1Abi } from "./abi/depositWallet";

export const GET_NONCE = "/nonce";
export const GET_RELAY_PAYLOAD = "/relay-payload"
export const GET_TRANSACTION = "/transaction"
export const GET_TRANSACTIONS = "/transactions"
export const SUBMIT_TRANSACTION = "/submit";
export const GET_DEPLOYED = "/deployed";

const FACTORY_BEACON_SELECTOR = "0x49493a4d";
const RPC_TRANSACTION_LOOKBACK_BLOCKS = 100_000n;
const RPC_LOG_CHUNK_SIZE = 2_000n;

function decodeAddressReturnData(data?: string): string {
    if (data === undefined || data.length < 66) {
        return zeroAddress;
    }
    return `0x${data.slice(-40)}`;
}

function isContractRevert(error: unknown): boolean {
    if (!(error instanceof BaseError)) {
        return false;
    }

    return error.walk((err) => (
        err instanceof ContractFunctionRevertedError ||
        err instanceof ExecutionRevertedError ||
        (err instanceof RawContractError && err.code === 3)
    )) !== null;
}

export interface RelayClientOptions {
    chain?: Chain;
    dataSource?: RelayDataSource;
    transactionLookbackBlocks?: bigint;
    /** @deprecated Use dataSource */
    nonceSource?: RelayDataSource;
}

export class RelayClient {
    readonly relayerUrl: string;

    readonly chainId: number;

    readonly relayTxType: RelayerTxType;

    readonly contractConfig: ContractConfig;

    readonly httpClient: HttpClient;

    private readonly publicClient: PublicClient;

    private readonly transport: ReturnType<typeof http>;

    private readonly dataSource: RelayDataSource;

    private readonly transactionLookbackBlocks: bigint;

    readonly signer?: IAbstractSigner;


    constructor(
        relayerUrl: string,
        chainId: number,
        signer?: IAbstractSigner,
        relayTxType?: RelayerTxType,
        options?: RelayClientOptions,
    ) {
        this.relayerUrl = relayerUrl.endsWith("/") ? relayerUrl.slice(0, -1) : relayerUrl;
        this.chainId = chainId;
        if (relayTxType == undefined) {
            relayTxType = RelayerTxType.SAFE;
        }
        this.relayTxType = relayTxType;
        this.contractConfig = getContractConfig(chainId);
        this.httpClient = new HttpClient();
        const chain = options?.chain ?? polygon;
        if (chain.id !== chainId) {
            throw new Error("chain id does not match chainId");
        }
        this.transport = http();
        this.dataSource = options?.dataSource ?? options?.nonceSource ?? RelayDataSource.API;
        this.transactionLookbackBlocks = options?.transactionLookbackBlocks ?? RPC_TRANSACTION_LOOKBACK_BLOCKS;
        this.publicClient = createPublicClient({
            chain,
            transport: this.transport,
        });

        if (signer != undefined) {
            this.signer = signer;
        }
    }

    public getTransport(): ReturnType<typeof http> {
        return this.transport;
    }

    public async getNonce(
        signerAddress: string,
        signerType: string,
        source: RelayDataSource = this.dataSource,
        contractAddress?: string,
    ): Promise<NoncePayload> {
        if (source === RelayDataSource.API) {
            return this.send(
                `${GET_NONCE}`,
                GET,
                { params: { address: signerAddress, type: signerType } },
            );
        }

        let address: string;
        switch (signerType) {
            case TransactionType.SAFE:
                address = deriveSafe(signerAddress, this.contractConfig.SafeContracts.SafeFactory);
                break;
            case TransactionType.WALLET:
                if (contractAddress === undefined) {
                    throw new Error("contractAddress is required for WALLET nonce via RPC");
                }
                address = contractAddress;
                break;
            default:
                throw new Error(`RPC nonce not supported for type: ${signerType}`);
        }

        const abi = signerType === TransactionType.WALLET ? depositWalletV1Abi : safeAbi;
        const nonce = (await this.publicClient.readContract({
            address: address as `0x${string}`,
            abi,
            functionName: "nonce",
        })) as bigint;

        return { nonce: nonce.toString() };
    }

    public async getRelayPayload(signerAddress: string, signerType: string): Promise<RelayPayload> {
        return this.send(
            `${GET_RELAY_PAYLOAD}`,
            GET,
            { params: { address: signerAddress, type: signerType } }
        );
    }

    public async getTransaction(
        transactionId: string,
        source: RelayDataSource = this.dataSource,
    ): Promise<RelayerTransaction[]> {
        if (source === RelayDataSource.API) {
            return this.send(
                `${GET_TRANSACTION}`,
                GET,
                { params: { id: transactionId } },
            );
        }

        const [tx, receipt] = await Promise.all([
            this.publicClient.getTransaction({ hash: transactionId as Hex }),
            this.publicClient.getTransactionReceipt({ hash: transactionId as Hex }),
        ]);

        if (tx === null || receipt === null) {
            return [];
        }

        return [this.mapChainTransaction(tx, receipt, transactionId)];
    }

    public async getTransactions(
        source: RelayDataSource = this.dataSource,
    ): Promise<RelayerTransaction[]> {
        if (source === RelayDataSource.API) {
            return this.sendAuthedRequest(GET, GET_TRANSACTIONS);
        }

        return this.getRpcTransactions();
    }

    /**
     * Executes a batch of transactions
     * @param txns 
     * @param metadata 
     * @returns 
     */
    public async execute(txns: Transaction[], metadata?: string): Promise<RelayerTransactionResponse> {
        this.signerNeeded();

        if (txns.length == 0) {
            throw new Error("no transactions to execute");
        }

        switch (this.relayTxType) {
            case RelayerTxType.SAFE:
                return this.executeSafeTransactions(
                    txns.map(txn => ({
                        to: txn.to,
                        operation: OperationType.Call,
                        data: txn.data,
                        value: "0",
                    })),
                    metadata
                );
            case RelayerTxType.PROXY:
                return this.executeProxyTransactions(
                    txns.map(txn => ({
                        to: txn.to,
                        typeCode: CallType.Call,
                        data: txn.data,
                        value: "0",
                    })),
                    metadata
                );
            default:
                throw new Error(`Unsupported relay transaction type: ${this.relayTxType}`);
        }
    }

    private async executeProxyTransactions(txns: ProxyTransaction[], metadata?: string): Promise<RelayerTransactionResponse> {
        this.signerNeeded();
        console.log(`Executing proxy transactions...`);
        const start = Date.now();
        const from = await this.signer!.getAddress();
        const rp = await this.getRelayPayload(from, TransactionType.PROXY);
        const args: ProxyTransactionArgs = {
            from: from,
            gasPrice: "0",
            data: encodeProxyTransactionData(txns),
            relay: rp.address,
            nonce: rp.nonce,
        }

        const proxyContractConfig = this.contractConfig.ProxyContracts;
        if (!isProxyContractConfigValid(proxyContractConfig)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }

        const request = await buildProxyTransactionRequest(this.signer!, args, proxyContractConfig, metadata);
        console.log(`Client side proxy request creation took: ${(Date.now() - start) / 1000} seconds`);

        const requestPayload = JSON.stringify(request);

        const resp: RelayerTransactionResponse = await this.sendAuthedRequest(POST, SUBMIT_TRANSACTION, requestPayload)
        return new ClientRelayerTransactionResponse(
            resp.transactionID,
            resp.state,
            resp.transactionHash,
            this,
        );
    }

    private async executeSafeTransactions(txns: SafeTransaction[], metadata?: string): Promise<RelayerTransactionResponse> {
        this.signerNeeded();
        console.log(`Executing safe transactions...`);
        const safe = await this.getExpectedSafe();

        const deployed = await this.getDeployed(safe);
        if (!deployed) {
            throw SAFE_NOT_DEPLOYED;
        }

        const start = Date.now();
        const from = await (this.signer as IAbstractSigner).getAddress();

        const noncePayload = await this.getNonce(from, TransactionType.SAFE);

        const args: SafeTransactionArgs = {
            transactions: txns,
            from,
            nonce: noncePayload.nonce,
            chainId: this.chainId,
        }

        const safeContractConfig = this.contractConfig.SafeContracts;
        if (!isSafeContractConfigValid(safeContractConfig)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }

        const request = await buildSafeTransactionRequest(
            this.signer as IAbstractSigner,
            args,
            safeContractConfig,
            metadata,
        );

        console.log(`Client side safe request creation took: ${(Date.now() - start) / 1000} seconds`);

        const requestPayload = JSON.stringify(request);

        const resp: RelayerTransactionResponse = await this.sendAuthedRequest(POST, SUBMIT_TRANSACTION, requestPayload);

        return new ClientRelayerTransactionResponse(
            resp.transactionID,
            resp.state,
            resp.transactionHash,
            this,
        );
    }

    /**
     * Deploys a safe 
     * @returns 
     */
    public async deploy(): Promise<RelayerTransactionResponse> {
        this.signerNeeded();
        const safe = await this.getExpectedSafe();

        const deployed = await this.getDeployed(safe);
        if (deployed) {
            throw SAFE_DEPLOYED;
        }
        console.log(`Deploying safe ${safe}...`);
        return this._deploy();
    }

    private async _deploy(): Promise<RelayerTransactionResponse> {
        const start = Date.now();
        const from = await (this.signer as IAbstractSigner).getAddress();
        const args: SafeCreateTransactionArgs = {
            from: from,
            chainId: this.chainId,
            paymentToken: zeroAddress,
            payment: "0",
            paymentReceiver: zeroAddress,
        };
        const safeContractConfig = this.contractConfig.SafeContracts;

        const request = await buildSafeCreateTransactionRequest(
            this.signer as IAbstractSigner,
            safeContractConfig,
            args
        );

        console.log(`Client side deploy request creation took: ${(Date.now() - start) / 1000} seconds`);

        const requestPayload = JSON.stringify(request);

        const resp: RelayerTransactionResponse = await this.sendAuthedRequest(POST, SUBMIT_TRANSACTION, requestPayload)

        return new ClientRelayerTransactionResponse(
            resp.transactionID,
            resp.state,
            resp.transactionHash,
            this,
        );
    }

    public async getDeployed(
        address: string,
        type?: string,
        source: RelayDataSource = this.dataSource,
    ): Promise<boolean> {
        if (source === RelayDataSource.API) {
            const params: Record<string, string> = { address };
            if (type !== undefined) {
                params.type = type;
            }
            const resp: GetDeployedResponse = await this.send(
                `${GET_DEPLOYED}`,
                GET,
                { params },
            );
            return resp.deployed;
        }

        return this.isContractDeployed(address);
    }

    /**
     * Deploys a new deposit wallet
     * @returns
     */
    public async deployDepositWallet(): Promise<RelayerTransactionResponse> {
        this.signerNeeded();
        const from = await (this.signer as IAbstractSigner).getAddress();

        const depositWalletConfig = this.contractConfig.DepositWalletContracts;
        if (!isDepositWalletContractConfigValid(depositWalletConfig)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }

        const request = buildDepositWalletCreateRequest(from, depositWalletConfig);
        const requestPayload = JSON.stringify(request);

        const resp: RelayerTransactionResponse = await this.sendAuthedRequest(POST, SUBMIT_TRANSACTION, requestPayload);
        return new ClientRelayerTransactionResponse(
            resp.transactionID,
            resp.state,
            resp.transactionHash,
            this,
        );
    }

    /**
     * Executes a batch of calls on a deposit wallet
     * @param calls - Array of calls to execute
     * @param walletAddress - Address of the deposit wallet
     * @param deadline - Unix timestamp deadline for the batch signature
     * @returns
     */
    public async executeDepositWalletBatch(
        calls: DepositWalletCall[],
        walletAddress: string,
        deadline: string,
    ): Promise<RelayerTransactionResponse> {
        this.signerNeeded();
        const from = await (this.signer as IAbstractSigner).getAddress();

        const depositWalletConfig = this.contractConfig.DepositWalletContracts;
        if (!isDepositWalletContractConfigValid(depositWalletConfig)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }

        const noncePayload = await this.getNonce(from, TransactionType.WALLET, this.dataSource, walletAddress);

        const args: DepositWalletTransactionArgs = {
            from,
            chainId: this.chainId,
            walletAddress,
            nonce: noncePayload.nonce,
            deadline,
            calls,
        };

        const request = await buildDepositWalletBatchRequest(
            this.signer as IAbstractSigner,
            args,
            depositWalletConfig,
        );

        const requestPayload = JSON.stringify(request);

        const resp: RelayerTransactionResponse = await this.sendAuthedRequest(POST, SUBMIT_TRANSACTION, requestPayload);
        return new ClientRelayerTransactionResponse(
            resp.transactionID,
            resp.state,
            resp.transactionHash,
            this,
        );
    }

    /**
     * Derives the expected deposit wallet address for the current signer
     * @returns The predicted deposit wallet address
     */
    public async deriveDepositWalletAddress(): Promise<string> {
        this.signerNeeded();
        const config = this.contractConfig.DepositWalletContracts;
        if (!isDepositWalletContractConfigValid(config)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }
        const address = await (this.signer as IAbstractSigner).getAddress();
        const uupsAddress = deriveUupsDepositWallet(address, config.DepositWalletFactory, config.DepositWalletImplementation);
        const beacon = await this.getDepositWalletFactoryBeacon(config.DepositWalletFactory);
        if (beacon.toLowerCase() === zeroAddress) {
            return uupsAddress;
        }
        if (await this.isContractDeployed(uupsAddress)) {
            return uupsAddress;
        }
        return deriveBeaconDepositWallet(address, config.DepositWalletFactory, beacon);
    }

    private async isContractDeployed(address: string): Promise<boolean> {
        const code = await this.publicClient.getCode({ address: address as `0x${string}` });
        return code !== undefined && code !== "0x";
    }

    private async getDepositWalletFactoryBeacon(factory: string): Promise<string> {
        try {
            const { data } = await this.publicClient.call({
                to: factory as `0x${string}`,
                data: FACTORY_BEACON_SELECTOR,
            });
            return decodeAddressReturnData(data);
        } catch (error) {
            if (isContractRevert(error)) {
                return zeroAddress;
            }
            throw error;
        }
    }

    /**
     * Periodically polls the transaction id until it reaches a desired state
     * Returns the relayer transaction if it does each the desired state
     * Returns undefined if the transaction hits the failed state
     * Times out after maxPolls is reached
     * @param transactionId
     * @param states
     * @param failState
     * @param maxPolls
     * @param pollFrequency
     * @returns
     */
    public async pollUntilState(transactionId: string, states: string[], failState?: string, maxPolls?: number, pollFrequency?: number): Promise<RelayerTransaction | undefined> {
        console.log(`Waiting for transaction ${transactionId} matching states: ${states}...`)
        const maxPollCount = maxPolls != undefined ? maxPolls : 10;
        let pollFreq = 2000; // Default to polling every 2 seconds
        if (pollFrequency != undefined) {
            if (pollFrequency >= 1000) {
                pollFreq = pollFrequency;
            }
        }
        let pollCount = 0;
        while (pollCount < maxPollCount) {
            const txns = await this.getTransaction(transactionId);
            if (txns.length > 0) {
                const txn = txns[0];
                if (txn && states.includes(txn.state)) {
                    return txn;
                }
                if (txn && failState != undefined && txn.state == failState) {
                    console.error(`txn ${transactionId} failed onchain! Transaction hash: ${txn.transactionHash}`);
                    return undefined;
                }
            }
            pollCount++
            await sleep(pollFreq);
        }
        console.log(`Transaction not found or not in given states, timing out!`);
    }

    private async sendAuthedRequest(
        method: string,
        path: string,
        body?: string
    ): Promise<any> {

        return this.send(
            path,
            method,
            { data: body }
        );
    }

    private async send(
        endpoint: string,
        method: string,
        options?: RequestOptions
    ): Promise<any> {
        const resp = await this.httpClient.send(`${this.relayerUrl}${endpoint}`, method, options);
        return resp.data;
    }

    private signerNeeded(): void {
        if (this.signer === undefined) {
            throw SIGNER_UNAVAILABLE;
        }
    }

    private mapChainTransaction(
        tx: { from: Address; to: Address | null; input: Hex; nonce: number; value: bigint },
        receipt: { status: "success" | "reverted"; transactionHash: Hex },
        transactionId: string,
    ): RelayerTransaction {
        return {
            transactionID: transactionId,
            transactionHash: receipt.transactionHash,
            from: tx.from,
            to: tx.to ?? "",
            proxyAddress: tx.to ?? "",
            data: tx.input,
            nonce: tx.nonce.toString(),
            value: tx.value.toString(),
            state: receipt.status === "success"
                ? RelayerTransactionState.STATE_CONFIRMED
                : RelayerTransactionState.STATE_FAILED,
            type: "",
            metadata: "",
            createdAt: new Date(),
            updatedAt: new Date(),
        };
    }

    private async getRpcTransactions(): Promise<RelayerTransaction[]> {
        this.signerNeeded();

        const walletAddress = await this.getRpcWalletAddress();
        const latestBlock = await this.publicClient.getBlockNumber();
        const fromBlock = latestBlock > this.transactionLookbackBlocks
            ? latestBlock - this.transactionLookbackBlocks
            : 0n;

        const logs = await this.getLogsInChunks({
            address: walletAddress,
            fromBlock,
            toBlock: latestBlock,
        });

        const hashToBlock = new Map<Hex, bigint>();
        for (const log of logs) {
            const existing = hashToBlock.get(log.transactionHash);
            if (existing === undefined || log.blockNumber > existing) {
                hashToBlock.set(log.transactionHash, log.blockNumber);
            }
        }

        const sortedHashes = [...hashToBlock.entries()]
            .sort((a, b) => Number(b[1] - a[1]))
            .map(([hash]) => hash);

        const transactions = await Promise.all(
            sortedHashes.map(async (hash) => {
                const [tx, receipt] = await Promise.all([
                    this.publicClient.getTransaction({ hash }),
                    this.publicClient.getTransactionReceipt({ hash }),
                ]);
                if (tx === null || receipt === null) {
                    return null;
                }
                return this.mapChainTransaction(tx, receipt, hash);
            }),
        );

        return transactions.filter((tx): tx is RelayerTransaction => tx !== null);
    }

    private async getRpcWalletAddress(): Promise<Address> {
        const from = await (this.signer as IAbstractSigner).getAddress();
        switch (this.relayTxType) {
            case RelayerTxType.PROXY:
                return deriveProxyWallet(
                    from,
                    this.contractConfig.ProxyContracts.ProxyFactory,
                ) as Address;
            case RelayerTxType.SAFE:
            default:
                return deriveSafe(
                    from,
                    this.contractConfig.SafeContracts.SafeFactory,
                ) as Address;
        }
    }

    private async getLogsInChunks(params: {
        address: Address;
        fromBlock: bigint;
        toBlock: bigint;
    }) {
        const logs = [];
        let from = params.fromBlock;

        while (from <= params.toBlock) {
            const to = from + RPC_LOG_CHUNK_SIZE > params.toBlock
                ? params.toBlock
                : from + RPC_LOG_CHUNK_SIZE;

            const chunk = await this.publicClient.getLogs({
                address: params.address,
                fromBlock: from,
                toBlock: to,
            });
            logs.push(...chunk);
            from = to + 1n;
        }

        return logs;
    }

    private async getExpectedSafe(): Promise<string> {
        const address = await (this.signer as IAbstractSigner).getAddress();
        return deriveSafe(address, this.contractConfig.SafeContracts.SafeFactory);
    }
}