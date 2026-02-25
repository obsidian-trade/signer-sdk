export default interface IAbstractSigner {
    getAddress(): Promise<string>;
    signMessage(message: string): Promise<string>;
    signTypedData(domain: any, types: any, values: any, primaryType: string): Promise<string>;
}


// Safe Transactions
export enum OperationType {
    Call, // 0
    DelegateCall, // 1
}  


export interface SafeContractConfig {
    SafeFactory: string;
    SafeMultisend: string;
}

export interface ContractConfig {
    SafeContracts: SafeContractConfig;
};


export interface SafeTransactionArgs {
    from: string;
    nonce: string;
    chainId: number;
    transactions: SafeTransaction[];
}

export interface SafeTransaction {
    to: string;
    operation: OperationType
    data: string;
    value: string;
}

export interface TransactionRequest {
    type:               string;
	from:               string;
    to:                 string;
    proxyWallet?:        string;
    data:               string;
    nonce?:              string;
    signature:          string;
    signatureParams:    SignatureParams;
    metadata?:          string;
}


export interface SignatureParams {
    gasPrice?: string;

    // Proxy RelayHub sig params
    relayerFee?: string;
    // gasPrice: string; // User supplied minimum gas price
    gasLimit?: string; // User supplied gas limit
    relayHub?: string; // Relay Hub Address
    relay?: string; // Relayer address

	// SAFE sig parameters
	operation?: string;
    safeTxnGas?: string;
    baseGas?: string;
    // gasPrice: string;
    gasToken?: string;
    refundReceiver?: string;

	// SAFE CREATE sig parameters
    paymentToken?: string;
    payment?: string;
    paymentReceiver?: string;
}

export enum TransactionType {
    SAFE = "SAFE",
    PROXY = "PROXY",
    SAFE_CREATE = "SAFE-CREATE"
}
