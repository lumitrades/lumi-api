/**
 * Optional capped test-buy. DRY-RUN unless { live: true }. Order: free quote -> pick the chain you hold -> local caps ->
 * (live only) sign and pay via the official x402 client for that chain -> measure the response -> receipt input.
 * Payment libraries are optional peer dependencies, loaded only for a live buy.
 */
import { checkQuote } from "./quote.js";
import { measureBody, outcomeOf } from "./measure.js";
import { capsFrom, checkSpend, loadState, recordSpend, saveState, defaultStatePath } from "./caps.js";
import { decodeHeaderJson } from "./quote.js";

const PREF = ["xrpl:0", "stellar:pubnet", "eip155:8453"];

export function pickQuote(q, networks, want) {
  const ok = q.quotes.map((x, i) => ({ ...x, i })).filter((x) => networks.includes(x.network) && x.scheme === "exact");
  if (want) return ok.find((x) => x.network === want) ?? null;
  return ok.sort((a, b) => PREF.indexOf(a.network) - PREF.indexOf(b.network))[0] ?? null;
}

async function payXrpl({ url, method, body, req, resource, secret }) {
  const { Wallet, hashes } = await import("xrpl");
  const { XRPLPresignedPaymentPayer, buildPaymentSignatureHeaderForSignedBlob } = await import("x402-xrpl");
  const wallet = Wallet.fromSeed(secret);
  const sdk = new XRPLPresignedPaymentPayer({ wallet, network: "xrpl:0", wsUrl: process.env.LUMI_KIT_XRPL_WS || "wss://xrplcluster.com", maxFeeDrops: "100" });
  const prepared = await sdk.preparePayment(req, { resource });
  const header = buildPaymentSignatureHeaderForSignedBlob({ req, signedTxBlob: prepared.signedTxBlob, invoiceId: prepared.invoiceId, resource });
  const tx = hashes.hashSignedTx(prepared.signedTxBlob);
  const t0 = Date.now();
  const res = await fetch(url, { method, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), "PAYMENT-SIGNATURE": header }, body, signal: AbortSignal.timeout(90_000) }).catch((e) => ({ error: e }));
  return { tx, payer: wallet.address, res, latency_ms: Date.now() - t0 };
}

/**
 * @param o { url, method?, body?, networks: string[], network?, live?: boolean, secretFor(network) => Promise<string>, caps?, statePath?, fetchImpl? }
 */
export async function testBuy(o) {
  const method = o.method ?? "GET";
  const body = o.body == null ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  const q = await checkQuote(o.url, { method, body, fetchImpl: o.fetchImpl });
  if (!q.ok) return { ok: false, step: "quote", quote: q };
  const pick = pickQuote(q, o.networks, o.network);
  if (!pick) return { ok: false, step: "pick", reason: "no quote on a chain you hold", quote: q };
  const caps = o.caps ?? capsFrom();
  const statePath = o.statePath ?? defaultStatePath();
  const st = loadState(statePath);
  const amount = Number(pick.amount);
  const cap = checkSpend(st, pick.asset, amount, caps);
  const plan = { url: o.url, method, network: pick.network, asset: pick.asset, amount: pick.amount, pay_to: pick.pay_to, caps, remaining_today: cap.remaining };
  if (!cap.ok) return { ok: false, step: "caps", reason: cap.reason, plan, quote: q };
  if (!o.live) return { ok: true, dry_run: true, plan, quote: q, note: "Dry run: nothing was signed or paid. Add --live to pay (within your caps)." };
  if (pick.network !== "xrpl:0") return { ok: false, step: "pay", reason: `live buys on ${pick.network} are not in kit v0 yet; buy with your usual client, then use passive "report"`, plan };
  const secret = await o.secretFor(pick.network);
  const req = q.accepts[pick.i];
  const resource = q.payment_required?.resource ?? { url: o.url };
  const t0 = Date.now();
  const paid = await payXrpl({ url: o.url, method, body, req, resource, secret });
  // Record the spend as soon as a payment was signed and sent (even if delivery failed).
  saveState(recordSpend(cap.state, pick.asset, amount, paid.tx), statePath);
  const res = paid.res;
  let m = {}, outcome = "timeout", status = 0, settle = null, facilitator = pick.facilitator;
  if (res && !res.error) {
    status = res.status;
    const buf = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    m = measureBody(buf, res.headers.get("content-type"));
    let j; try { j = JSON.parse(new TextDecoder().decode(buf)); } catch { j = undefined; }
    outcome = outcomeOf(status, buf.length, j);
    settle = decodeHeaderJson(res.headers.get("PAYMENT-RESPONSE"));
    facilitator = settle?.facilitator ?? facilitator;
  }
  return {
    ok: true, dry_run: false, tx_hash: paid.tx, payer: paid.payer, plan, http_status: status, outcome,
    // No prices, amounts or addresses in measurements: a contributed receipt carries only the chain and tx hash of the payment.
    measurements: { ...m, latency_ms: paid.latency_ms, http_status: status, quote_latency_ms: q.quote_latency_ms, facilitator, settlement_ms: Date.now() - t0 },
    observed_at: new Date().toISOString(),
  };
}
