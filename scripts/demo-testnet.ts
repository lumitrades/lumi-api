/**
 * npm run demo:testnet
 *
 * End-to-end x402 payment on the XRPL TESTNET against a local Lumi API:
 *   1. GET a paid endpoint with no payment            -> 402 + x402 requirements
 *   2. sign an XRP Payment with the x402-xrpl SDK, retry with PAYMENT-SIGNATURE -> 200 + data + receipt
 *   3. replay the same PAYMENT-SIGNATURE              -> refused (invoice already used)
 *   4. one-liner agent flow with x402Fetch            -> 200 on /v1/verdict?url=https%3A%2F%2Fexample.com%2F
 *   5. confirm both transactions on the ledger and write a transcript to demo/
 *
 * Uses throwaway faucet wallets from .testnet/ (created on first run). Never touches mainnet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Wallet, convertHexToString, type Client } from "xrpl";
import {
  XRPLPresignedPaymentPayer,
  x402Fetch,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "x402-xrpl";
import { startServer } from "../src/node";
import { ensureTestnetWallets, connectTestnet, balanceXrp } from "./testnet-lib";

const EXPLORER = "https://testnet.xrpl.org/transactions/";
const transcript: Record<string, unknown> = { started: new Date().toISOString(), network: "xrpl:1" };
const say = (...a: unknown[]) => console.log(...a);
const hr = (t: string) => say(`\n=== ${t} ${"=".repeat(Math.max(0, 70 - t.length))}`);

async function ledgerTx(client: Client, hash: string) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await client.request({ command: "tx", transaction: hash });
      const res = r.result as any;
      if (res.validated) {
        const tx = res.tx_json ?? res;
        return {
          hash,
          validated: true,
          result: res.meta?.TransactionResult,
          ledger_index: res.ledger_index,
          account: tx.Account,
          destination: tx.Destination,
          amount_drops: tx.DeliverMax ?? tx.Amount,
          delivered_drops: res.meta?.delivered_amount,
          fee_drops: tx.Fee,
          source_tag: tx.SourceTag,
          invoice_id_field: tx.InvoiceID,
          memos: (tx.Memos ?? []).map((m: any) => ({
            type: m.Memo.MemoType ? convertHexToString(m.Memo.MemoType) : undefined,
            data: m.Memo.MemoData ? convertHexToString(m.Memo.MemoData) : undefined,
          })),
          explorer: EXPLORER + hash,
        };
      }
    } catch { /* not found yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { hash, validated: false, explorer: EXPLORER + hash };
}

async function main() {
  hr("Testnet wallets");
  const wallets = await ensureTestnetWallets(say);
  const { client, wsUrl } = await connectTestnet();
  const payer = Wallet.fromSeed(wallets.payer.seed);
  say(`payer    ${payer.classicAddress}   (testnet faucet wallet)`);
  say(`receiver ${wallets.receiver.address}   (stands in for Lumi's mainnet wallet)`);
  say(`XRPL node ${wsUrl}`);
  const before: { payer: number; receiver: number } = {
    payer: await balanceXrp(client, payer.classicAddress),
    receiver: await balanceXrp(client, wallets.receiver.address),
  };
  say(`balances before: payer ${before.payer} XRP, receiver ${before.receiver} XRP`);

  // Default: run the API in-process on Node. Set LUMI_API_URL to target a running
  // instance instead (e.g. `wrangler dev --env testnet` on http://127.0.0.1:8787).
  let server: { close(): void } | undefined;
  let base = process.env.LUMI_API_URL?.replace(/\/+$/, "");
  if (base) {
    hr(`Using running Lumi API at ${base}`);
    const health = (await (await fetch(`${base}/health`)).json()) as any;
    if (health.network !== "xrpl:1") throw new Error(`refusing: ${base} is configured for ${health.network}, not testnet`);
    say(JSON.stringify(health));
  } else {
    hr("Start Lumi API locally (testnet config)");
    const started = await startServer(
      {
        XRPL_NETWORK: "xrpl:1",
        PAY_TO: wallets.receiver.address,
        FACILITATOR_URL: process.env.FACILITATOR_URL || "https://xrpl-facilitator-testnet.t54.ai",
        INVOICE_SECRET: randomBytes(32).toString("hex"),
      },
      0,
    );
    server = started.server;
    base = started.url;
    say(`Lumi API at ${base} (Node) -> facilitator https://xrpl-facilitator-testnet.t54.ai`);
  }
  transcript.server = base;

  try {
    // ---------------------------------------------------------------- 1. 402
    const target = `${base}/v1/verdict?url=https%3A%2F%2Fexample.com%2F`;
    hr(`1. GET ${target} (no payment)`);
    const r402 = await fetch(target);
    const challengeHeader = r402.headers.get("PAYMENT-REQUIRED");
    say(`HTTP ${r402.status}`);
    if (r402.status !== 402 || !challengeHeader) throw new Error("expected 402 with PAYMENT-REQUIRED");
    const challenge = decodePaymentRequiredHeader(challengeHeader) as any;
    const req = challenge.accepts[0];
    if (req.network !== "xrpl:1") throw new Error("refusing to pay: quote is not for XRPL testnet");
    const receiverAddr: string = req.payTo;
    say("PAYMENT-REQUIRED accepts[0]:", JSON.stringify(req, null, 2));
    transcript.step1_payment_required = challenge;

    // ---------------------------------------------------------------- 2. pay + retry
    hr("2. Sign XRP Payment with x402-xrpl, retry with PAYMENT-SIGNATURE");
    const payerSdk = new XRPLPresignedPaymentPayer({ wallet: payer, network: "xrpl:1", wsUrl, maxFeeDrops: "1000" });
    const prepared = await payerSdk.preparePayment(req, { resource: challenge.resource });
    say(`signed Payment blob (${prepared.signedTxBlob.length / 2} bytes) bound to invoice ${prepared.invoiceId}`);
    const t0 = Date.now();
    const paid = await fetch(target, { headers: { "PAYMENT-SIGNATURE": prepared.paymentHeader } });
    const paidMs = Date.now() - t0;
    const paidBody = (await paid.json()) as any;
    const receiptHeader = paid.headers.get("PAYMENT-RESPONSE");
    const receipt = receiptHeader ? (decodePaymentResponseHeader(receiptHeader) as any) : null;
    say(`HTTP ${paid.status} in ${paidMs} ms (verify + on-ledger settlement)`);
    say("PAYMENT-RESPONSE:", JSON.stringify(receipt));
    if (paid.status !== 200 || !receipt?.transaction) throw new Error(`payment failed: ${JSON.stringify(paidBody)}`);
    say("data:", JSON.stringify({
      kind: paidBody.kind, coin: paidBody.coin?.symbol, label: paidBody.label, score: paidBody.score,
      timeframes: Object.fromEntries(Object.entries(paidBody.timeframes ?? {}).map(([k, v]: any) => [k, v.label])),
      price_usd: paidBody.price?.usd, timestamp: paidBody.timestamp, source: paidBody.source,
    }, null, 2));
    say(`tx: ${EXPLORER}${receipt.transaction}`);
    transcript.step2 = { status: paid.status, latency_ms: paidMs, receipt, response: paidBody };

    // ---------------------------------------------------------------- 3. replay
    hr("3. Replay the same PAYMENT-SIGNATURE");
    const replay = await fetch(target, { headers: { "PAYMENT-SIGNATURE": prepared.paymentHeader } });
    const replayBody = (await replay.json()) as any;
    say(`HTTP ${replay.status} error=${replayBody.error}`);
    transcript.step3_replay = { status: replay.status, error: replayBody.error };
    if (replay.status === 200) throw new Error("replay was served: this must not happen");

    // ---------------------------------------------------------------- 4. x402Fetch one-liner
    const target2 = `${base}/v1/verdict?url=https%3A%2F%2Fexample.com%2F`;
    hr(`4. Agent one-liner: x402Fetch(${target2})`);
    const fetchPaid = x402Fetch({ wallet: payer, network: "xrpl:1", wsUrl, maxValue: "100000" });
    const t1 = Date.now();
    const r2 = await fetchPaid(target2);
    const ms2 = Date.now() - t1;
    const body2 = (await r2.json()) as any;
    const h2 = r2.headers.get("PAYMENT-RESPONSE");
    const receipt2 = h2 ? (decodePaymentResponseHeader(h2) as any) : null;
    say(`HTTP ${r2.status} in ${ms2} ms (402 -> sign -> retry -> settle, all inside x402Fetch)`);
    if (r2.status !== 200 || !receipt2?.transaction) throw new Error(`x402Fetch failed: ${JSON.stringify(body2)}`);
    say("data:", JSON.stringify({
      kind: body2.kind,
      btc_bias: body2.btc_backdrop?.bias,
      btc_projection: body2.btc_backdrop?.projection,
      yen_note: body2.macro?.yen_note?.slice(0, 240) + "...",
      breadth: body2.breadth,
    }, null, 2));
    say(`tx: ${EXPLORER}${receipt2.transaction}`);
    transcript.step4 = { status: r2.status, latency_ms: ms2, receipt: receipt2, response: body2 };

    // ---------------------------------------------------------------- 5. ledger check
    hr("5. Confirm on the XRP Ledger (testnet)");
    const txs = [await ledgerTx(client, receipt.transaction), await ledgerTx(client, receipt2.transaction)];
    for (const t of txs) say(JSON.stringify(t, null, 2));
    const after = {
      payer: await balanceXrp(client, payer.classicAddress),
      receiver: await balanceXrp(client, receiverAddr),
    };
    if (receiverAddr !== wallets.receiver.address) before.receiver = NaN;
    say(`balances after: payer ${after.payer} XRP, receiver ${after.receiver} XRP (receiver +${(after.receiver - before.receiver).toFixed(6)})`);
    transcript.ledger = txs;
    transcript.balances = { before, after };
    transcript.finished = new Date().toISOString();
    transcript.ok = txs.every((t: any) => t.validated && t.result === "tesSUCCESS" && t.destination === receiverAddr);

    mkdirSync("demo", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `demo/testnet-run-${stamp}.json`;
    writeFileSync(file, JSON.stringify(transcript, null, 2));
    writeFileSync("demo/latest.json", JSON.stringify(transcript, null, 2));
    hr(transcript.ok ? "DEMO PASSED" : "DEMO FINISHED WITH ISSUES");
    for (const t of txs) say(`${(t as any).result ?? "?"}  ${t.explorer}`);
    say(`transcript: ${file}`);
    if (!transcript.ok) process.exitCode = 1;
  } finally {
    server?.close();
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
