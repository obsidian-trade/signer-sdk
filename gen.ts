import { generatePrivateKey } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
console.log(`Private Key: ${privateKey}`);
const account = privateKeyToAccount(privateKey);
console.log(`Account: ${account.address}`);