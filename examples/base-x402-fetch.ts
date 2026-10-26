/**
 * Any EVM agent, using the official x402 v2 fetch SDK and USDC on Base.
 *
 *   npm i @x402/fetch @x402/evm viem
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/base-x402-fetch.ts /v1/fear-greed
 *
 * The client sees Lumi's 402, skips the XRPL options, picks eip155:8453 USDC, signs an
 * EIP-3009 authorization (gasless: no ETH needed) and retries. Prices: $0.01-$0.03 per read,
 * $0.10 for the Institutional Brief. Free first: GET /v1/trust/vendors, /v1/check, /openapi.json.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const path = process.argv[2] ?? "/v1/fear-greed";
const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`) });
const fetchPaid = wrapFetchWithPayment(fetch, client);

const res = await fetchPaid(`https://api.lumitrades.io${path}`);
console.log(res.status, JSON.stringify(await res.json(), null, 2));
const receipt = res.headers.get("PAYMENT-RESPONSE");
if (receipt) console.log("receipt:", decodePaymentResponseHeader(receipt));
