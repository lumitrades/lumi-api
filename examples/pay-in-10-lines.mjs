// npm i @x402/fetch @x402/evm viem   then: EVM_PRIVATE_KEY=0x... node pay-in-10-lines.mjs "<Lumi paid URL>"
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
const NET = process.env.X402_NETWORK ?? "eip155:8453", MAX = 250000n; // USDC on Base, at most $0.25 (6 decimals)
const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === NET && BigInt(a.amount) <= MAX) ?? (() => { throw new Error("no Base USDC quote <= $0.25"); })());
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY) });
const res = await wrapFetchWithPayment(fetch, client)(process.argv[2]);   // 402 -> sign EIP-3009 -> retry with PAYMENT-SIGNATURE
const receipt = res.headers.get("PAYMENT-RESPONSE");
console.log(res.status, await res.text(), receipt ? decodePaymentResponseHeader(receipt) : "not paid");
