/**
 * Diagnostic: what happens if the server-side replay guard is bypassed (e.g. a
 * fresh isolate without KV)? Pays once, then replays the identical
 * PAYMENT-SIGNATURE to a *second, fresh* server instance sharing the same
 * INVOICE_SECRET, so only the facilitator/ledger can stop it. Testnet only.
 */
import { randomBytes } from "node:crypto";
import { Wallet } from "xrpl";
import { XRPLPresignedPaymentPayer, decodePaymentRequiredHeader, decodePaymentResponseHeader } from "x402-xrpl";
import { startServer } from "../src/node";
import { ensureTestnetWallets, connectTestnet } from "./testnet-lib";

const w = await ensureTestnetWallets();
const { client, wsUrl } = await connectTestnet();
await client.disconnect();
const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: w.receiver.address, INVOICE_SECRET: randomBytes(32).toString("hex") };
const a = await startServer(env, 0);
const b = await startServer(env, 0); // fresh instance: empty replay memory
try {
  const r402 = await fetch(`${a.url}/v1/verdict?url=https%3A%2F%2Fexample.com%2F`);
  const ch = decodePaymentRequiredHeader(r402.headers.get("PAYMENT-REQUIRED")!) as any;
  const payer = new XRPLPresignedPaymentPayer({ wallet: Wallet.fromSeed(w.payer.seed), network: "xrpl:1", wsUrl });
  const { paymentHeader } = await payer.preparePayment(ch.accepts[0], { resource: ch.resource });
  const first = await fetch(`${a.url}/v1/verdict?url=https%3A%2F%2Fexample.com%2F`, { headers: { "PAYMENT-SIGNATURE": paymentHeader } });
  const rcpt = decodePaymentResponseHeader(first.headers.get("PAYMENT-RESPONSE") ?? "") as any;
  console.log("first payment:", first.status, rcpt?.transaction);
  const replay = await fetch(`${b.url}/v1/verdict?url=https%3A%2F%2Fexample.com%2F`, { headers: { "PAYMENT-SIGNATURE": paymentHeader } });
  const body = (await replay.json()) as any;
  console.log("replay on fresh instance:", replay.status, body.error ?? body.kind, replay.headers.get("PAYMENT-RESPONSE") ? decodePaymentResponseHeader(replay.headers.get("PAYMENT-RESPONSE")!) : "");
} finally {
  a.server.close();
  b.server.close();
}
