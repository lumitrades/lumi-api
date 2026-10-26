/**
 * npm run demo:mainnet        (requires DEMO_CONFIRM=yes)
 *
 * LABELED DEMO: one real x402 payment on XRPL MAINNET from Lumi's demo-buyer wallet to
 * https://api.lumitrades.io. Both wallets belong to Lumi, so this is a self-payment for
 * demonstration only. It must be shown as a demo and excluded from usage/KPI counts.
 *
 * Safety rails:
 *   - seed is read from DEMO_BUYER_FILE (default /workspace/secrets/xrpl_demo_buyer.json) and never printed
 *   - target must report network xrpl:0 on /health; only api.lumitrades.io unless DEMO_ALLOW_OTHER_HOST=1
 *   - pays in XRP only (accepts[0]); refuses any quote above DEMO_MAX_DROPS (default 10000 = 0.01 XRP)
 *   - one paid call per run; requires DEMO_CONFIRM=yes
 *   - appends the tx to DEMO_LOG (default /workspace/notes/wallet_log.md) and writes demo/mainnet-demo-*.json
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client, Wallet } from "xrpl";
import { XRPLPresignedPaymentPayer, decodePaymentRequiredHeader, decodePaymentResponseHeader } from "x402-xrpl";

const BASE = (process.env.LUMI_API_URL || "https://api.lumitrades.io").replace(/\/+$/, "");
const PATH = process.env.DEMO_PATH || "/v1/fear-greed";
const FILE = process.env.DEMO_BUYER_FILE || "/workspace/secrets/xrpl_demo_buyer.json";
const LOG = process.env.DEMO_LOG || "/workspace/notes/wallet_log.md";
const MAX_DROPS = BigInt(process.env.DEMO_MAX_DROPS || "10000");
const WS = process.env.XRPL_MAINNET_WS || "wss://xrplcluster.com";
const EXPLORER = "https://livenet.xrpl.org/transactions/";
const say = (...a: unknown[]) => console.log(...a);

async function main() {
  say("=== LUMI API LABELED MAINNET DEMO (self-payment from Lumi's demo buyer wallet; not organic usage) ===");
  if (process.env.DEMO_CONFIRM !== "yes") throw new Error("set DEMO_CONFIRM=yes to spend real XRP");
  if (new URL(BASE).host !== "api.lumitrades.io" && process.env.DEMO_ALLOW_OTHER_HOST !== "1") throw new Error(`refusing host ${BASE}`);
  if (!existsSync(FILE)) throw new Error(`no demo buyer wallet at ${FILE}; run npm run demo:buyer:create`);
  const wallet = Wallet.fromSeed(JSON.parse(readFileSync(FILE, "utf8")).seed);
  say(`demo buyer ${wallet.classicAddress}`);

  const health = (await (await fetch(`${BASE}/health`)).json()) as any;
  if (health.network !== "xrpl:0") throw new Error(`refusing: ${BASE} is on ${health.network}`);

  const client = new Client(WS);
  await client.connect();
  try {
    const info = await client.request({ command: "server_info" });
    if ((info.result.info as any).network_id !== undefined && (info.result.info as any).network_id !== 0) throw new Error("node is not mainnet");
    const bal = async () => Number((await client.request({ command: "account_info", account: wallet.classicAddress, ledger_index: "validated" })).result.account_data.Balance) / 1e6;
    const before = await bal();
    say(`balance before ${before} XRP`);

    const target = `${BASE}${PATH}`;
    const r402 = await fetch(target);
    if (r402.status !== 402) throw new Error(`expected 402, got ${r402.status}`);
    const challenge = decodePaymentRequiredHeader(r402.headers.get("PAYMENT-REQUIRED")!) as any;
    const req = challenge.accepts.find((a: any) => a.asset === "XRP");
    if (!req || req.network !== "xrpl:0") throw new Error("no mainnet XRP option");
    if (BigInt(req.amount) > MAX_DROPS) throw new Error(`quote ${req.amount} drops exceeds cap ${MAX_DROPS}`);
    say(`402 quote: ${req.amount} drops to ${req.payTo} (invoice ${req.extra.invoiceId})`);

    const sdk = new XRPLPresignedPaymentPayer({ wallet, network: "xrpl:0", wsUrl: WS, maxFeeDrops: "100" });
    const prepared = await sdk.preparePayment(req, { resource: challenge.resource });
    const t0 = Date.now();
    const paid = await fetch(target, { headers: { "PAYMENT-SIGNATURE": prepared.paymentHeader } });
    const ms = Date.now() - t0;
    const body = (await paid.json()) as any;
    const h = paid.headers.get("PAYMENT-RESPONSE");
    const receipt = h ? (decodePaymentResponseHeader(h) as any) : null;
    say(`HTTP ${paid.status} in ${ms} ms`);
    if (paid.status !== 200 || !receipt?.transaction) throw new Error(`demo payment failed: ${JSON.stringify(body).slice(0, 500)}`);

    let tx: any;
    for (let i = 0; i < 10 && !tx?.validated; i++) {
      try { tx = (await client.request({ command: "tx", transaction: receipt.transaction })).result; } catch { /* pending */ }
      if (!tx?.validated) await new Promise((r) => setTimeout(r, 1500));
    }
    const j = tx?.tx_json ?? tx ?? {};
    const after = await bal();
    const record = {
      label: "LABELED DEMO: self-payment from Lumi's demo buyer wallet to Lumi's API. Not organic usage; exclude from KPIs.",
      date: tx?.close_time_iso ?? new Date().toISOString(),
      endpoint: target,
      tx: receipt.transaction,
      explorer: EXPLORER + receipt.transaction,
      result: tx?.meta?.TransactionResult,
      from: j.Account,
      to: j.Destination,
      amount_drops: j.DeliverMax ?? j.Amount,
      fee_drops: j.Fee,
      source_tag: j.SourceTag,
      latency_ms: ms,
      balance_before_xrp: before,
      balance_after_xrp: after,
      response_kind: body.kind,
      response_label: body.label,
    };
    say(JSON.stringify(record, null, 2));
    mkdirSync("demo", { recursive: true });
    writeFileSync(`demo/mainnet-demo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(record, null, 2));
    if (existsSync(LOG)) {
      const xrp = Number(record.amount_drops) / 1e6;
      appendFileSync(
        LOG,
        `| ${record.date} | x402 Payment (LABELED DEMO, self-payment) | ${xrp} XRP + fee ${Number(record.fee_drops) / 1e6} XRP | ${record.from} -> ${record.to} (${PATH}) | [${record.tx}](${record.explorer}) | Mainnet demo of api.lumitrades.io; not organic usage |\n`,
      );
    }
    if (record.result !== "tesSUCCESS") process.exitCode = 1;
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error("demo failed:", (e as Error).message); process.exitCode = 1; });
