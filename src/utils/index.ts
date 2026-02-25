import { encodePacked, type Hex, hexToBigInt } from "viem";

export interface SplitSig {
    r: string;
    s: string;
    v: string;
}

export function splitAndPackSig(sig: string): string {
    let sigV = parseInt(sig.slice(-2), 16);
    
    // Normalize to 27/28 for Gnosis Safe execTransaction
    if (sigV === 0 || sigV === 1) {
        sigV += 27;
    }

    const r = hexToBigInt(('0x' + sig.slice(2, 66)) as Hex);
    const s = hexToBigInt(('0x' + sig.slice(66, 130)) as Hex);

    return encodePacked(
        ["uint256", "uint256", "uint8"],
        [r, s, sigV],
    );
}

function splitSignature(sig: string) : SplitSig {
    let sigV = parseInt(sig.slice(-2), 16);
    switch (sigV) {
        case 0:
        case 1:
            sigV += 31;
            break;
        case 27:
        case 28:
            sigV += 4;
            break;
        default:
            throw new Error("Invalid signature");
    }

    sig = sig.slice(0, -2) + sigV.toString(16);

    return {
        r: hexToBigInt('0x' + sig.slice(2, 66) as Hex).toString(),
        s: hexToBigInt('0x' + sig.slice(66, 130) as Hex).toString(),
        v: hexToBigInt('0x' + sig.slice(130, 132) as Hex).toString(),
    };
}


export function sleep(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}