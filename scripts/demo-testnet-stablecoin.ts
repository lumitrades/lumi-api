/**
 * npm run demo:testnet:stablecoin            (DEMO_ASSET=RLUSD|USDC, default RLUSD)
 *
 * End-to-end x402 payment in a stablecoin IOU on the XRPL TESTNET against a local Lumi API:
 *   0. throwaway faucet wallets (.testnet/), trust lines on payer + receiver.
 *      Official testnet issuers (Ripple rQhWct2..., Circle rHuGNhq...) only hand out tokens via
 *      login/captcha-gated web faucets, so by default (STANDIN != "0") this uses a STAND-IN testnet
 *      issuer that issues the same 40-hex currency code, and points the API at it with
 *      RLUSD_ISSUER / USDC_ISSUER. That exercises the exact same IOU code path in the API, SDK
 *      and T54 facilitator. With STANDIN=0 it uses the official issuer (fund the payer yourself).
 *   1. GET /v1/market -> 402 with accepts[0] XRP, accepts[1] RLUSD, accepts[2] USDC
 *   2. sign the stablecoin option with x402-xrpl, retry -> 200 + data + receipt
 *   3. replay -> refused
 *   4. confirm on ledger (delivered RLUSD) and write demo/testnet-rlusd-*.json
 * Never touches mainnet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Wallet, type Client } from "xrpl";
import { XRPLPresignedPaymentPayer, decodePaymentRequiredHeader, decodePaymentResponseHeader } from "x402-xrpl";
import { startServer } from "../src/node";
import { readFileSync, chmodSync } from "node:fs";
import { RLUSD_CURRENCY, RLUSD_ISSUERS, USDC_CURRENCY, USDC_ISSUERS } from "../src/config";
import { ensureTestnetWallets, connectTestnet, WALLETS_FILE } from "./testnet-lib";

const SYMBOL = (process.env.DEMO_ASSET || "RLUSD").toUpperCase() as "RLUSD" | "USDC";
if (SYMBOL !== "RLUSD" && SYMBOL !== "USDC") throw new Error("DEMO_ASSET must be RLUSD or USDC");
const CURRENCY = SYMBOL === "RLUSD" ? RLUSD_CURRENCY : USDC_CURRENCY;
const STANDIN = process.env.STANDIN !== "0";
let ISSUER = (SYMBOL === "RLUSD" ? RLUSD_ISSUERS : USDC_ISSUERS)["xrpl:1"]!;
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const say = (...a: unknown[]) => console.log(...a);
const hr = (t: string) => say(`\n=== ${t} ${"=".repeat(Math.max(0, 70 - t.length))}`);

async function rlusdBalance(client: Client, account: string): Promise<number | null> {
  const r = await client.request({ command: "account_lines", account, peer: ISSUER, ledger_index: "validated" });
  const line = r.result.lines.find((l) => l.currency === CURRENCY);
  return line ? Number(line.balance) : null;
}

async function ensureTrustline(client: Client, wallet: Wallet) {
  if ((await rlusdBalance(client, wallet.classicAddress)) !== null) return;
  const r = await client.submitAndWait(
    { TransactionType: "TrustSet", Account: wallet.classicAddress, Flags: 0x00020000, LimitAmount: { currency: CURRENCY, issuer: ISSUER, value: "1000000" } },
    { autofill: true, wallet },
  );
  say(`TrustSet ${wallet.classicAddress}: ${(r.result.meta as any)?.TransactionResult} ${EXPLORER}${r.result.hash}`);
}

async function main() {
  hr("Testnet wallets + RLUSD trust lines");
  const wallets = await ensureTestnetWallets(say);
  const { client, wsUrl } = await connectTestnet();
  const payer = Wallet.fromSeed(wallets.payer.seed);
  const receiver = Wallet.fromSeed(wallets.receiver.seed);
  let server: { close(): void } | undefined;
  try {
    if (STANDIN) {
      // Stand-in issuer: throwaway testnet account, DefaultRipple on so holder->holder payments ripple through it.
      const all = JSON.parse(readFileSync(WALLETS_FILE, "utf8"));
      if (!all.standin_issuer) {
        const w = (await client.fundWallet()).wallet;
        all.standin_issuer = { address: w.classicAddress, seed: w.seed };
        writeFileSync(WALLETS_FILE, JSON.stringify(all, null, 2));
        chmodSync(WALLETS_FILE, 0o600);
        await client.submitAndWait({ TransactionType: "AccountSet", Account: w.classicAddress, SetFlag: 8 }, { autofill: true, wallet: w });
      }
      ISSUER = all.standin_issuer.address;
      say(`STAND-IN testnet issuer ${ISSUER} for currency ${CURRENCY} (${SYMBOL}); not Ripple's/Circle's issuer.`);
    }
    const transcript: Record<string, unknown> = {
      started: new Date().toISOString(), network: "xrpl:1", asset: SYMBOL, currency: CURRENCY, issuer: ISSUER,
      issuer_kind: STANDIN ? "stand-in testnet issuer (official testnet faucets are login/captcha gated)" : "official testnet issuer",
    };
    await ensureTrustline(client, payer);
    await ensureTrustline(client, receiver);
    if (STANDIN && ((await rlusdBalance(client, payer.classicAddress)) ?? 0) < 0.1) {
      const all = JSON.parse(readFileSync(WALLETS_FILE, "utf8"));
      const iw = Wallet.fromSeed(all.standin_issuer.seed);
      const r = await client.submitAndWait(
        { TransactionType: "Payment", Account: iw.classicAddress, Destination: payer.classicAddress, Amount: { currency: CURRENCY, issuer: ISSUER, value: "10" } },
        { autofill: true, wallet: iw },
      );
      say(`issued 10 test ${SYMBOL} to payer: ${(r.result.meta as any)?.TransactionResult} ${EXPLORER}${r.result.hash}`);
    }
    if (!STANDIN && ((await rlusdBalance(client, payer.classicAddress)) ?? 0) < 0.1 && SYMBOL === "RLUSD") {
      say("Claiming testnet RLUSD from https://tryrlusd.com ...");
      const f = await fetch("https://tryrlusd.com/api/mint-xrpl", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: payer.classicAddress }),
      });
      say(`faucet HTTP ${f.status}: ${(await f.text()).slice(0, 300)}`);
      for (let i = 0; i < 15 && ((await rlusdBalance(client, payer.classicAddress)) ?? 0) < 0.1; i++) await new Promise((r) => setTimeout(r, 2000));
    }
    const before = { payer: await rlusdBalance(client, payer.classicAddress), receiver: await rlusdBalance(client, receiver.classicAddress) };
    say(`${SYMBOL} before: payer ${before.payer}, receiver ${before.receiver}`);
    if ((before.payer ?? 0) < 0.1) throw new Error(`payer has no testnet ${SYMBOL}`);

    hr("Start Lumi API locally (testnet config, stablecoins on)");
    const started = await startServer(
      {
        XRPL_NETWORK: "xrpl:1", PAY_TO: receiver.classicAddress, FACILITATOR_URL: "https://xrpl-facilitator-testnet.t54.ai",
        INVOICE_SECRET: randomBytes(32).toString("hex"), [`${SYMBOL}_ISSUER`]: ISSUER,
      },
      0,
    );
    server = started.server;
    const target = `${started.url}/v1/market`;

    hr(`1. GET ${target} (no payment)`);
    const r402 = await fetch(target);
    const challenge = decodePaymentRequiredHeader(r402.headers.get("PAYMENT-REQUIRED")!) as any;
    say(`HTTP ${r402.status}; accepts:`, JSON.stringify(challenge.accepts, null, 2));
    const req = challenge.accepts.find((a: any) => a.asset === CURRENCY && a.extra?.issuer === ISSUER);
    if (!req || req.network !== "xrpl:1") throw new Error(`no testnet ${SYMBOL} option in 402`);
    transcript.step1_payment_required = challenge;

    hr(`2. Sign ${SYMBOL} Payment with x402-xrpl, retry`);
    const sdk = new XRPLPresignedPaymentPayer({ wallet: payer, network: "xrpl:1", wsUrl, maxFeeDrops: "1000" });
    const prepared = await sdk.preparePayment(req, { resource: challenge.resource });
    const t0 = Date.now();
    const paid = await fetch(target, { headers: { "PAYMENT-SIGNATURE": prepared.paymentHeader } });
    const ms = Date.now() - t0;
    const body = (await paid.json()) as any;
    const receipt = paid.headers.get("PAYMENT-RESPONSE") ? (decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE")!) as any) : null;
    say(`HTTP ${paid.status} in ${ms} ms; receipt ${JSON.stringify(receipt)}; payment block ${JSON.stringify(body.payment)}`);
    if (paid.status !== 200 || !receipt?.transaction) throw new Error(`${SYMBOL} payment failed: ${JSON.stringify(body)}`);
    say(`ideas: ${body.ideas?.length}  tx: ${EXPLORER}${receipt.transaction}`);
    transcript.step2 = { status: paid.status, latency_ms: ms, receipt, payment: body.payment, kind: body.kind, ideas: body.ideas?.length };

    hr("3. Replay");
    const replay = await fetch(target, { headers: { "PAYMENT-SIGNATURE": prepared.paymentHeader } });
    const rb = (await replay.json()) as any;
    say(`HTTP ${replay.status} error=${rb.error}`);
    transcript.step3_replay = { status: replay.status, error: rb.error };
    if (replay.status === 200) throw new Error("replay served");

    hr("4. Ledger check");
    let tx: any;
    for (let i = 0; i < 10 && !tx?.validated; i++) {
      try { tx = (await client.request({ command: "tx", transaction: receipt.transaction })).result; } catch { /* not yet */ }
      if (!tx?.validated) await new Promise((r) => setTimeout(r, 1500));
    }
    const j = tx?.tx_json ?? tx;
    const ledger = {
      hash: receipt.transaction, validated: tx?.validated, result: tx?.meta?.TransactionResult, account: j?.Account, destination: j?.Destination,
      amount: j?.DeliverMax ?? j?.Amount, send_max: j?.SendMax, delivered: tx?.meta?.delivered_amount, source_tag: j?.SourceTag, explorer: EXPLORER + receipt.transaction,
    };
    say(JSON.stringify(ledger, null, 2));
    const after = { payer: await rlusdBalance(client, payer.classicAddress), receiver: await rlusdBalance(client, receiver.classicAddress) };
    say(`${SYMBOL} after: payer ${after.payer}, receiver ${after.receiver}`);
    transcript.ledger = ledger;
    transcript.balances = { before, after };
    transcript.ok = ledger.validated === true && ledger.result === "tesSUCCESS" && (ledger.delivered as any)?.value === req.amount && (ledger.delivered as any)?.issuer === ISSUER;
    transcript.finished = new Date().toISOString();
    mkdirSync("demo", { recursive: true });
    const file = `demo/testnet-${SYMBOL.toLowerCase()}-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify(transcript, null, 2));
    hr(transcript.ok ? `${SYMBOL} DEMO PASSED` : `${SYMBOL} DEMO FINISHED WITH ISSUES`);
    say(`transcript: ${file}`);
    if (!transcript.ok) process.exitCode = 1;
  } finally {
    server?.close();
    await client.disconnect();
  }
}

main().catch((e) => { console.error("demo failed:", e); process.exitCode = 1; });
