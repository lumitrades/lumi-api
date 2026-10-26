/**
 * Minimal agent client (Node/TypeScript) using the x402-xrpl SDK.
 *
 *   XRPL_SEED=s... LUMI_API_URL=https://api.lumitrades.io XRPL_NETWORK=xrpl:0 \
 *     npx tsx examples/agent-client.ts /v1/fear-greed
 *
 * The SDK sees the 402, signs an XRP Payment for the quoted amount (refusing
 * anything above MAX_DROPS), retries with PAYMENT-SIGNATURE and returns the data.
 */
import { Wallet } from "xrpl";
import { x402Fetch, decodePaymentResponseHeader, type XRPLNetworkId } from "x402-xrpl";

const base = process.env.LUMI_API_URL ?? "http://127.0.0.1:8787";
const network = (process.env.XRPL_NETWORK ?? "xrpl:1") as XRPLNetworkId;
const wsUrl = process.env.XRPL_WS ?? (network === "xrpl:0" ? "wss://xrplcluster.com" : "wss://testnet.xrpl-labs.com");
const path = process.argv[2] ?? "/v1/fear-greed";

const fetchPaid = x402Fetch({
  wallet: Wallet.fromSeed(process.env.XRPL_SEED!),
  network,
  wsUrl,
  maxValue: process.env.MAX_DROPS ?? "100000", // never pay more than 0.1 XRP per call
});

const res = await fetchPaid(`${base}${path}`);
console.log(res.status, JSON.stringify(await res.json(), null, 2));
const receipt = res.headers.get("PAYMENT-RESPONSE");
if (receipt) console.log("receipt:", decodePaymentResponseHeader(receipt));
