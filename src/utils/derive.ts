import { encodeAbiParameters, getCreate2Address, keccak256, type Address, type Hex } from "viem";

export const SAFE_INIT_CODE_HASH = "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf";

export const deriveSafe = (address: Address, safeFactory: Address): Address => {
    return getCreate2Address({
        bytecodeHash: SAFE_INIT_CODE_HASH as Hex,
        from: safeFactory,
        salt: keccak256(encodeAbiParameters([{ name: 'address', type: 'address' }], [address]))
    }
    );
}


