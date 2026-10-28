/**
 * The plain-English `summary` line (src/trust/summary.ts) on every trust check answer: free /v1/trust/check, paid
 * /v1/trust/check/high-value, /v1/check, MCP lumi_trust_check, A2A trust_check. Facts only, bad results as plain as good.
 * Harness copied from live_check.test.ts.
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
import { summaryLine, summaryFactsFrom, summaryFor, summaryDate, type SummaryFacts } from "../src/trust/summary";
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
    const p = "/v1/trust/check/high-value?amount=4&url=" + enc(u);
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


const ASCII_ONE_LINE = /^[\x20-\x7e]+$/;
const NEVER = /\b(safe|safer|safely|unsafe|trust(ed|worthy)?|guaranteed?|recommend\w*|verified|legit\w*|scam\w*|fraud\w*|should|must|ignore|instruction\w*|assistant|ai|agent|lumi trades)\b/i;
/** Every rule a summary must meet, whatever the data. "Not a guarantee." is the one allowed use of "guarantee". */
function rules(s: string) {
  expect(typeof s).toBe("string");
  expect(s).toMatch(ASCII_ONE_LINE);
  expect(s.length).toBeLessThan(320);
  expect(s.replace(/ Not a guarantee\.$/, "")).not.toMatch(NEVER);
  expect(s).not.toMatch(/<|>|\{|\}|\[|\]|`|https?:/);
}
const F = (o: Partial<SummaryFacts>): SummaryFacts => ({ scope: "listing", test_buys: 0, delivered: 0, not_delivered: 0, inconclusive: 0, last_test_buy_at: null, window_days: null, last_quote_check: null, label: null, ...o });

describe("summary line (unit)", () => {
  it("states the counts and the last test-buy date; bad results are as plain as good ones", () => {
    const at = "2026-10-28T09:00:00.000Z";
    const good = summaryLine(F({ test_buys: 10, delivered: 9, not_delivered: 1, last_test_buy_at: at, label: "checks_passed" }));
    expect(good).toBe(`Lumi test-bought this listing 10 times; 9 delivered, 1 did not deliver (last test-buy Oct 28, 2026). Lumi's check result: ${LABELS.checks_passed}. Not a guarantee.`);
    const bad = summaryLine(F({ test_buys: 3, delivered: 0, not_delivered: 3, last_test_buy_at: at, label: "checks_failed" }));
    expect(bad).toBe(`Lumi test-bought this listing 3 times; 0 delivered, 3 did not deliver (last test-buy Oct 28, 2026). Lumi's check result: ${LABELS.checks_failed}. Not a guarantee.`);
    const once = summaryLine(F({ scope: "seller", test_buys: 1, delivered: 0, inconclusive: 1, window_days: 30, last_test_buy_at: at, label: "no_data" }));
    expect(once).toBe(`Lumi test-bought this seller once in the last 30 days; 0 delivered, 1 inconclusive (not counted) (last test-buy Oct 28, 2026). Lumi's check result: ${LABELS.no_data}. Not a guarantee.`);
    for (const s of [good, bad, once]) rules(s);
  });
  it("no test-buys, no record, and Lumi itself are said honestly", () => {
    const none = summaryLine(F({ label: "no_data" }));
    expect(none).toBe(`Lumi has not test-bought this listing yet. Lumi's check result: ${LABELS.no_data}. Not a guarantee.`);
    const quoted = summaryLine(F({ last_quote_check: { at: "2026-10-27T10:00:00Z", valid_quote: false }, label: "check_first" }));
    expect(quoted).toContain("Its last free quote check (no payment) on Oct 27, 2026 did not get a valid x402 price quote.");
    const windowed = summaryLine(F({ scope: "seller", window_days: 30, label: "no_data" }));
    expect(windowed).toContain("Lumi has not test-bought this seller yet (none in the last 30 days).");
    const unknown = summaryLine(F({ scope: "not_observed", label: "no_data" }));
    expect(unknown).toContain("Lumi has no record of this seller");
    expect(unknown).toContain("No record is not a negative finding.");
    const self = summaryLine(F({ scope: "lumi_itself" }));
    expect(self).toBe("This is Lumi's own API; Lumi does not test-buy or rate itself.");
    for (const s of [none, quoted, windowed, unknown, self]) rules(s);
  });
  it("a block is never hidden behind good delivery counts", () => {
    const s = summaryLine(F({ test_buys: 12, delivered: 12, last_test_buy_at: "2026-10-20T00:00:00Z", label: "checks_failed" }));
    expect(s).toContain(`Lumi's check result: ${LABELS.checks_failed}.`);
  });
  it("facts come from the full test_buys aggregate, not the 5 newest purchases", () => {
    const exact = { catalog: { entries: [{ purchases: [{ at: "2026-10-28T00:00:00Z", data_returned: true }], test_buys: { count: 10, delivered: 9, not_delivered: 1, inconclusive: 0, last_at: "2026-10-28T00:00:00Z" } }] } };
    expect(summaryFactsFrom(exact, null, "checks_passed")).toMatchObject({ scope: "listing", test_buys: 10, delivered: 9, not_delivered: 1 });
    const curated = { curated: [{ xrpl_test_buys: { window_days: 30, count: 4, delivered: 4, not_delivered: 0, inconclusive: 0, last_at: "2026-10-26T00:00:00Z" } }] };
    expect(summaryFactsFrom(null, curated, "checks_passed")).toMatchObject({ scope: "seller", test_buys: 4, window_days: 30 });
    // other catalog listings on the same domain never hide the curated seller's own test-buys
    expect(summaryFactsFrom({ ...curated, catalog: { entries: [] } }, { catalog: { entries: [{}] } }, "check_first")).toMatchObject({ scope: "seller", test_buys: 4 });
    expect(summaryFactsFrom({ self: true }, null, null).scope).toBe("lumi_itself");
    expect(summaryFactsFrom({ observed: false }, { observed: false }, "no_data").scope).toBe("not_observed");
    expect(summaryDate("nope")).toBeNull();
    expect(summaryFor(null, null, null).summary_facts.version).toBe("1");
  });
});

describe("summary line (end to end)", () => {
  it("free /v1/trust/check: summary first, matches summary_facts, and is inside the signed receipt", async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) await s.buy(1, NOW - (i + 1) * 3_600_000, i !== 2);
    const r = await s.req("/v1/trust/check?url=" + enc(R(1)));
    expect(r.status).toBe(200);
    const b: any = await r.json();
    // the freshness contract keeps kind/timestamp/source first; summary comes straight after
    expect(Object.keys(b).slice(0, 5)).toEqual(["kind", "timestamp", "source", "summary", "summary_facts"]);
    rules(b.summary);
    expect(b.summary).toMatch(/^Lumi test-bought this listing 4 times; 3 delivered, 1 did not deliver \(last test-buy Oct 22, 2026\)\. Lumi's check result: .+\. Not a guarantee\.$/);
    expect(b.summary).toContain(`Lumi's check result: ${b.label_text ?? LABELS[b.label as keyof typeof LABELS]}.`);
    expect(b.summary_facts).toMatchObject({ scope: "listing", test_buys: 4, delivered: 3, not_delivered: 1, inconclusive: 0, label: b.label, version: "1" });
    const v = await verifySignedResponse(b.lumi_receipt, { trusted: [PUB], now: NOW });
    expect(v.ok).toBe(true);
    expect(JSON.stringify(b.lumi_receipt)).toContain(JSON.stringify(b.summary).slice(1, -1));
  });
  it("more than 5 test-buys are all counted", async () => {
    const s = await setup();
    for (let i = 0; i < 8; i++) await s.buy(1, NOW - (i + 1) * 3_600_000, true);
    const b: any = await (await s.req("/v1/trust/check?url=" + enc(R(1)))).json();
    expect(b.summary_facts.test_buys).toBe(8);
    expect(b.summary).toContain("Lumi test-bought this listing 8 times; 8 delivered");
  });
  it("zero test-buys and an unknown seller are said honestly", async () => {
    const s = await setup();
    const zero: any = await (await s.req("/v1/trust/check?url=" + enc(R(2)))).json();
    expect(zero.summary).toMatch(/^Lumi has not test-bought this listing yet\./);
    rules(zero.summary);
    const none: any = await (await s.req("/v1/trust/check?url=" + enc("https://nobody.example/x"))).json();
    expect(none.summary).toMatch(/^Lumi has no record of this seller/);
    expect(none.summary_facts).toMatchObject({ scope: "not_observed", test_buys: 0 });
    rules(none.summary);
  });
  it("paid /v1/trust/check/high-value and /v1/check carry the same line", async () => {
    const s = await setup();
    await s.buy(1, NOW - 3_600_000, true);
    // same query as the paid one (amount=4): the label, and so the line, depends on the query, never on paying
    const free: any = await (await s.req("/v1/trust/check?amount=4&url=" + enc(R(1)))).json();
    const paid = await s.trustCheck(R(1));
    expect(paid.status).toBe(200);
    expect(paid.body.summary).toBe(free.summary);
    expect(paid.body.summary_facts).toEqual(free.summary_facts);
    const c = await s.check(R(1));
    expect(c.signed?.payload?.summary ?? c.payload?.summary ?? c.summary ?? JSON.stringify(c)).toContain("Lumi test-bought this listing once");
  });
  it("MCP lumi_trust_check leads with the summary; A2A trust_check text starts with it", async () => {
    const s = await setup();
    await s.buy(1, NOW - 3_600_000, false);
    const m = await s.req("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lumi_trust_check", arguments: { url: R(1) } } }) });
    const mb: any = await m.json();
    const out = JSON.parse(mb.result.content[0].text);
    expect(Object.keys(out)[0]).toBe("summary");
    expect(out.summary).toMatch(/^Lumi test-bought this listing once; 0 delivered, 1 did not deliver/);
    rules(out.summary);
    const a = await s.req("/a2a", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", kind: "message", messageId: "m1", parts: [{ kind: "data", data: { skill: "trust_check", url: R(1) } }] } } }) });
    const ab = JSON.stringify(await a.json());
    expect(ab).toContain(out.summary);
  });
});
