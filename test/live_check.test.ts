/**
 * GET /v1/verdict + per-seller observed on-chain payments (legal review 2026-10-25: M1, M2, M3, M4, M8, M12, M13, M14, appeal).
 * The verdict is the free /v1/check core with a label on top: same data, same signing key, and nothing commercial is an input.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { trustVerdict } from "../src/quick";
import { verifySignedResponse } from "../src/trust/lumi_sign";
import { labelFor, testBuyEvidence, failureStreak, LABELS, VERDICT_DEFAULTS, EVIDENCE_AGE, DISPUTE_URL, type TestBuyEvidence } from "../src/trust/verdict";
import { activityBand, activityPublic, activityFlags, parseActivityRow, createActivity, MemoryActivityStore, D1ActivityStore, ACTIVITY_NAME } from "../src/trust/activity";
import { loadConfig, VERDICT_MAX_USD } from "../src/config";
import { liveProbe, compare, liveAlertView, type LiveBaseline } from "../src/trust/live_check";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const DAY = 86_400_000;
const BASE = "https://api.lumitrades.io";
const OWNER = "k".repeat(52);
const SEED = Buffer.from(ed25519.utils.randomPrivateKey()).toString("hex");
const PUB = Buffer.from(ed25519.getPublicKey(Buffer.from(SEED, "hex"))).toString("hex");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BANNED = /\b(scam\w*|fraud\w*|unsafe|dishonest\w*|fake\w*)\b/i;
const OLD_LABELS = /\b(proceed|caution|avoid)\b/;

const payTo = (i: number) => "0x" + (0xabc0000 + i).toString(16).padStart(40, "0");
const R = (i: number) => `https://api.s${i}.com/v1/q`;
const ITEMS = [1, 2, 3].map((i) => ({
  resource: R(i), type: "http", description: "d",
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: payTo(i) }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 6, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
}));
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER,
  PUBLIC_BASE_URL: BASE, LUMI_CHECK_SIGNING_KEY: SEED, XRPL_RPC_URLS: "https://xrpl.rpc.test/",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: "https://evm-fac.test", BASE_RPC_URL: "https://base-rpc.test",
};
const enc = encodeURIComponent;

const seller = { payTo: payTo(1), amount: "10000", calls: 0, paymentHeaders: 0, down: false };
async function setup(env: Record<string, string> = {}) {
  Object.assign(seller, { payTo: payTo(1), amount: "10000", calls: 0, paymentHeaders: 0, down: false });
  let t = NOW;
  const ev = new MemoryEvidenceStore();
  ev.resources = new Set(ITEMS.map((i) => i.resource));
  const catalogStore = new MemoryCatalogStore();
  const activityStore = new MemoryActivityStore();
  const fallback = makeFetch(happyFacilitator());
  const doFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: ITEMS.length } }));
    if (url === "https://xrpl.rpc.test/") return new Response(JSON.stringify({ result: { transactions: [] } }));
    if (url.startsWith("https://base-rpc.test")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
    if (url.startsWith("https://api.s1.com/")) {
      seller.calls++;
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) seller.paymentHeaders++;
      if (seller.down) throw new Error("TimeoutError: The operation was aborted due to timeout");
      const pr = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: seller.amount, payTo: seller.payTo }] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64"), "Content-Type": "application/json" } });
    }
    if (/^https:\/\/api\.s\d\.com\//.test(url)) return new Response("nope", { status: 200 });
    return fallback(input, init);
  }) as typeof fetch;
  const trustStore = new MemoryTrustStore(SEED_OBSERVATIONS);
  const app = createApp({ ...ENV, ...env } as any, { fetch: doFetch, log: () => {}, now: () => t, catalogStore, evidenceStore: ev, trialStore: new MemoryTrialStore(), activityStore, trustStore } as any);
  await app.scheduled();
  let ip = 0;
  const req = (p: string, init: RequestInit = {}) => {
    const r = new Request(BASE + p, init);
    const h = new Headers(r.headers); h.set("CF-Connecting-IP", "203.0.113." + (++ip % 250));
    return app.fetch(new Request(r, { headers: h }));
  };
  const owner = (p: string, body?: unknown) => req(p, body === undefined ? { headers: { Authorization: `Bearer ${OWNER}` } } : { method: "POST", headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const buy = (i: number, ts: number, ok: boolean) => catalogStore.addBuy({
    resource: R(i), domain: `api.s${i}.com`, ts, network: "eip155:8453", tx_hash: "0x" + ts.toString(16).padStart(64, "0"), amount: "0.01", asset: "USDC",
    pay_to: payTo(i), facilitator: null, http_status: 200, data_returned: ok, latency_ms: 100, summary: ok ? "ok" : "200 with an empty body",
  } as any);
  // /v1/verdict is paid ($0.01) by default: pay the 402 like a buyer would (XRPL RLUSD option, test facilitator).
  const verdict = async (u: string) => {
    const p = "/v1/verdict?url=" + enc(u);
    const r = await req(p);
    if (r.status !== 402) return r.json() as Promise<any>;
    const q: any = await r.json();
    const opt = q.accepts.find((a: any) => a.network.startsWith("xrpl:") && (a.extra?.symbol ?? a.asset) === "RLUSD") ?? q.accepts.find((a: any) => a.network.startsWith("xrpl:"));
    return (await req(p, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(opt) } })).json() as Promise<any>;
  };
  const check = async (u: string) => (await req("/v1/check?url=" + enc(u))).json() as Promise<any>;
  const trustCheck = async (u: string, headers: Record<string, string> = {}) => {
    const p = "/v1/trust/check?url=" + enc(u);
    const r = await req(p, { headers });
    if (r.status !== 402) return { status: r.status, body: await r.json() as any, callsAtQuote: -1 };
    const callsAtQuote = seller.calls;
    const q: any = await r.json();
    const opt = q.accepts.find((a: any) => a.network.startsWith("xrpl:"));
    const paid = await req(p, { headers: { ...headers, "PAYMENT-SIGNATURE": paymentHeaderFor(opt) } });
    return { status: paid.status, body: await paid.json() as any, callsAtQuote };
  };
  return { app, req, owner, buy, verdict, check, trustCheck, catalogStore, activityStore, advance: (ms: number) => (t += ms), rescan: () => app.scheduled() };
}


const base = (o: Partial<LiveBaseline> = {}): LiveBaseline => ({ pay_tos: ["0xAbc"], price_usd: "0.01", quote_ok: true, https: true, as_of: null, source: "test", ...o });
const q402 = (payTo: string, amount: string) => (async () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo }] })).toString("base64") } })) as unknown as typeof fetch;

describe("liveProbe / compare (unit)", () => {
  it("labelFor: a live alert turns checks_passed into check_first but never softens checks_failed", () => {
    const at = new Date(NOW - 2 * DAY).toISOString();
    const tests: TestBuyEvidence = { last_at: at, last_delivered: true, last_delivered_at: at, last_failed_at: null, consecutive_failed: 0, conclusive: 1, window_from: at, window_to: at };
    const check = { decision: "allow", reasons: [] };
    expect(labelFor({ check, tests, now: NOW, th: VERDICT_DEFAULTS }).label).toBe("checks_passed");
    expect(labelFor({ check, tests, now: NOW, th: VERDICT_DEFAULTS, liveAlert: true }).label).toBe("check_first");
    expect(labelFor({ check: { decision: "block", reasons: [] }, tests, now: NOW, th: VERDICT_DEFAULTS, liveAlert: true }).label).toBe("checks_failed");
  });
  it("unchanged when payTo and price match (payTo compared case-insensitively for 0x)", async () => {
    const r = await liveProbe(q402("0xABC", "10000"), "https://s.test/x", base(), () => NOW);
    expect(r).toMatchObject({ outcome: "unchanged", tls: "pass", safety_change: false, http_status: 402 });
    expect(r.quote?.price_usd).toBe("0.01");
  });
  it("a new payTo is a safety change; a price over 2x is a safety change, a small rise is not", async () => {
    const p = await liveProbe(q402("0xdef", "10000"), "https://s.test/x", base(), () => NOW);
    expect(p.outcome).toBe("changed");
    expect(p.changes.map((c) => [c.field, c.safety])).toEqual([["pay_to", true]]);
    const big = await liveProbe(q402("0xabc", "30000"), "https://s.test/x", base(), () => NOW);
    expect(big.changes).toEqual([expect.objectContaining({ field: "price", safety: true })]);
    const small = await liveProbe(q402("0xabc", "15000"), "https://s.test/x", base(), () => NOW);
    expect(small.changes).toEqual([expect.objectContaining({ field: "price", safety: false })]);
    expect(small.safety_change).toBe(false);
  });
  it("a timeout or network error is tls unknown (no false safety alert); a certificate error is a TLS failure", async () => {
    const thrower = (msg: string) => (async () => { throw new Error(msg); }) as unknown as typeof fetch;
    const t = await liveProbe(thrower("TimeoutError: The operation was aborted due to timeout"), "https://s.test/x", base(), () => NOW);
    expect(t).toMatchObject({ outcome: "unreachable", tls: "unknown", safety_change: false });
    const n = await liveProbe(thrower("TypeError: fetch failed"), "https://s.test/x", base(), () => NOW);
    expect(n).toMatchObject({ tls: "unknown", safety_change: false });
    const c = await liveProbe(thrower("Error: certificate has expired"), "https://s.test/x", base(), () => NOW);
    expect(c).toMatchObject({ tls: "fail", safety_change: true });
    expect(compare(base({ https: null }), { tls: "fail", quote: null, http_status: null }).some((x) => x.safety)).toBe(false);
  });
  it("no baseline: reports what it saw without inventing a change", async () => {
    const r = await liveProbe(q402("0xabc", "10000"), "https://s.test/x", base({ pay_tos: [], price_usd: null, quote_ok: null, https: null }), () => NOW);
    expect(r.outcome).toBe("no_baseline");
  });
  it("liveAlertView shows safety changes only and expires after 48 h", () => {
    const raw = JSON.stringify({ checked_at: new Date(NOW).toISOString(), url: "https://s.test/x", changes: [{ field: "pay_to", safety: true, text: "t" }, { field: "price", safety: false, text: "p" }] });
    expect(liveAlertView(raw, NOW + 1000)).toMatchObject({ changes: [{ field: "pay_to", text: "t" }], age_seconds: 1 });
    expect(liveAlertView(raw, NOW + 49 * 3_600_000)).toBeNull();
    expect(liveAlertView("", NOW)).toBeNull();
    expect(liveAlertView("not json", NOW)).toBeNull();
  });
});

describe("paid /v1/trust/check is a live check (Phase 2)", () => {
  it("never contacts the seller before payment; never sends a payment header to the seller; signed live evidence", async () => {
    const s = await setup();
    const before = seller.calls;
    const r = await s.trustCheck(R(1));
    expect(r.status).toBe(200);
    expect(r.callsAtQuote).toBe(before); // the unpaid 402 quote did not probe the seller
    expect(seller.calls).toBe(before + 1);
    expect(seller.paymentHeaders).toBe(0);
    expect(r.body.live).toMatchObject({ outcome: "unchanged", safety_change: false, tls: "pass" });
    expect(r.body.live.baseline.pay_tos.map((x: string) => x.toLowerCase())).toContain(payTo(1).toLowerCase());
    expect(r.body.live_note).toMatch(/no payment was sent to the seller/);
    const v = await verifySignedResponse(r.body.live_evidence, { trusted: [PUB], now: NOW });
    expect(v.ok).toBe(true);
    expect(r.body.live_evidence.payload.live.outcome).toBe("unchanged");
  });
  it("a payTo change found by a paid check shows on the free check at once (check_first), and clears when the live quote matches again", async () => {
    const s = await setup();
    await s.buy(1, NOW - 2 * DAY, true);
    const free0 = await s.check(R(1));
    expect(free0.live_alert ?? null).toBeNull();
    expect(free0.data_age).toMatchObject({ cached: true });
    seller.payTo = "0x" + "9".repeat(40);
    const r = await s.trustCheck(R(1));
    expect(r.body.live).toMatchObject({ outcome: "changed", safety_change: true });
    expect(r.body.live.changes[0].field).toBe("pay_to");
    const free = await s.check(R(1));
    expect(free.live_alert).toMatchObject({ changes: [{ field: "pay_to" }] });
    expect(free.label).not.toBe("checks_passed");
    expect(free0.label).toBe("checks_passed");
    expect(free.label).toBe("check_first");
    // paid verdict: the one-word version of the live check
    const v = await s.verdict(R(1));
    expect(v.label_live).toBe(v.label === "checks_failed" ? "checks_failed" : "check_first");
    expect(v.live).toMatchObject({ safety_change: true });
    expect((await verifySignedResponse(v.live_evidence, { trusted: [PUB], now: NOW })).ok).toBe(true);
    // the seller goes back to the recorded address: the next live check clears the alert
    seller.payTo = payTo(1);
    expect((await s.trustCheck(R(1))).body.live.outcome).toBe("unchanged");
    expect((await s.check(R(1))).live_alert ?? null).toBeNull();
  });
  it("a seller timeout is reported as unreachable and raises no alert", async () => {
    const s = await setup();
    seller.down = true;
    const r = await s.trustCheck(R(1));
    expect(r.status).toBe(200);
    expect(r.body.live).toMatchObject({ outcome: "unreachable", tls: "unknown", safety_change: false });
    expect((await s.check(R(1))).live_alert ?? null).toBeNull();
  });
});

describe("free limits per IP and per wallet / key (Phase 2)", () => {
  it("30 a minute per key even across IPs; 429 points to the paid live check", async () => {
    const s = await setup();
    const h = { "X-Wallet": "rWalletForLimitTest" };
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await s.req("/v1/check?url=" + enc(R(2)), { headers: h });
    expect(last!.status).toBe(429);
    const b: any = await last!.json();
    expect(JSON.stringify(b.more)).toContain("/v1/trust/check");
    // another key on the same rotating IPs is not affected
    expect((await s.req("/v1/check?url=" + enc(R(2)), { headers: { "X-Wallet": "rOther" } })).status).toBe(200);
  });
});
