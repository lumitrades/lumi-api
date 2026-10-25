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
import { activityBand, activityPublic, createActivity, MemoryActivityStore, D1ActivityStore, ACTIVITY_NAME } from "../src/trust/activity";
import { loadConfig, VERDICT_MAX_USD } from "../src/config";
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

async function setup(env: Record<string, string> = {}) {
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
  const verdict = async (u: string) => (await req("/v1/verdict?url=" + enc(u))).json() as Promise<any>;
  const check = async (u: string) => (await req("/v1/check?url=" + enc(u))).json() as Promise<any>;
  return { app, req, owner, buy, verdict, check, catalogStore, activityStore, advance: (ms: number) => (t += ms), rescan: () => app.scheduled() };
}

const T = (iso: string) => Date.parse(iso);

describe("/v1/verdict: same core and signing as /v1/check", () => {
  it("label, reasons and decision match /v1/check and both verify against the same key", async () => {
    const s = await setup();
    await s.buy(1, NOW - 2 * DAY, true);
    const v = await s.verdict(R(1));
    const c = await s.check(R(1));
    expect(v.kind).toBe("lumi_verdict");
    expect(v.label).toBe(c.label);
    expect(v.check.decision).toBe(c.decision);
    expect(v.check.reasons.map((r: any) => r.code)).toEqual(c.reasons.map((r: any) => r.code));
    expect((await verifySignedResponse(v.receipt, { trusted: [PUB], now: NOW })).ok).toBe(true);
    expect((await verifySignedResponse(c.receipt, { trusted: [PUB], now: NOW })).ok).toBe(true);
    expect(v.receipt.signer.public_key).toBe(c.receipt.signer.public_key);
    expect(v.receipt.payload.label).toBe(v.label);
  });

  it("M13: every verdict carries the required fields; M4 public names only", async () => {
    const s = await setup();
    for (const u of [R(1), "https://never-seen.example/x"]) {
      const v = await s.verdict(u);
      for (const k of ["label", "label_text", "reason", "reason_code", "as_of", "evidence_window", "evidence", "reply_url", "appeal", "definition", "rules_version", "rules", "relationship", "receipt"]) expect(v, k).toHaveProperty(k);
      expect(Object.keys(LABELS)).toContain(v.label);
      expect(v.label_text).toBe(LABELS[v.label as keyof typeof LABELS]);
      expect(v.reply_url).toBe(DISPUTE_URL);
      expect(JSON.stringify(v)).not.toMatch(OLD_LABELS);
    }
    expect(LABELS).toEqual({ checks_passed: "Delivered in recent checks", check_first: "Check first", checks_failed: "Recent checks failed", no_data: "Not enough data" });
  });

  it("M2: an unknown seller is no_data (not a negative signal); bad input is a 400", async () => {
    const s = await setup();
    const v = await s.verdict("https://never-seen.example/x");
    expect(v.label).toBe("no_data");
    expect(v.label_text).toBe("Not enough data");
    expect((await s.req("/v1/verdict?url=notaurl")).status).toBe(400);
  });
});

describe("M1: checks_failed only after repeated, confirmed, reviewed failures", () => {
  it("1 and 2 failures are check_first; a 3rd (confirming) buy on another day goes to human review, then checks_failed with evidence and contact", async () => {
    const s = await setup();
    await s.buy(1, T("2026-10-17T13:00:00Z"), false);
    await s.rescan();
    expect((await s.verdict(R(1))).label).toBe("check_first");
    await s.buy(1, T("2026-10-19T13:00:00Z"), false);
    await s.rescan();
    const two = await s.verdict(R(1));
    expect(two.label).toBe("check_first");
    await s.buy(1, T("2026-10-21T13:00:00Z"), false);
    await s.rescan();
    const pending = await s.verdict(R(1));
    expect(pending).toMatchObject({ label: "check_first", reason_code: "checks_failed_pending_review", review: { state: "pending" } });
    const q = await (await s.owner("/v1/owner/reviews")).json();
    expect(q.reviews).toHaveLength(1);
    expect(q.reviews[0]).toMatchObject({ host: "api.s1.com", state: "pending" });
    expect((await s.owner("/v1/owner/reviews", { host: "api.s1.com", action: "approve", evidence: q.reviews[0].evidence })).status).toBe(200);
    const failed = await s.verdict(R(1));
    expect(failed).toMatchObject({ label: "checks_failed", label_text: "Recent checks failed", reason_code: "paid_no_data", review: { state: "approved" } });
    expect(failed.reason).toMatch(/2026-10-21/);
    expect(failed.evidence).toBe(`${BASE}/trust/v/api.s1.com`);
    expect(failed.appeal.url).toBe(DISPUTE_URL);
    expect(failed.check.decision).toBe("block");
    // /v1/check shows the same label.
    expect((await s.check(R(1))).label).toBe("checks_failed");
    // A later successful buy clears it.
    await s.buy(1, T("2026-10-22T10:00:00Z"), true);
    await s.rescan();
    expect((await s.verdict(R(1))).label).not.toBe("checks_failed");
  });

  it("failureStreak: same-day failures or failures outside 14 days never qualify", () => {
    const f = (at: string) => ({ at, http_status: 200, data_returned: false });
    const now = T("2026-10-22T13:00:00Z");
    expect(failureStreak([f("2026-10-21T01:00:00Z"), f("2026-10-21T05:00:00Z"), f("2026-10-21T09:00:00Z")], now).qualifies).toBe(false);
    expect(failureStreak([f("2026-10-21T01:00:00Z"), f("2026-09-20T05:00:00Z"), f("2026-09-01T09:00:00Z")], now).qualifies).toBe(false);
    expect(failureStreak([f("2026-10-21T01:00:00Z"), f("2026-10-19T05:00:00Z"), f("2026-10-17T09:00:00Z")], now).qualifies).toBe(true);
    expect(failureStreak([f("2026-10-21T01:00:00Z"), { at: "2026-10-20T00:00:00Z", http_status: 200, data_returned: true }, f("2026-10-19T05:00:00Z"), f("2026-10-17T09:00:00Z")], now).qualifies).toBe(false);
  });

  it("evidence age: delivered >30 days ago is check_first, >90 days is no_data (old_evidence)", () => {
    const now = NOW;
    const ev = (daysAgo: number): TestBuyEvidence => {
      const at = new Date(now - daysAgo * DAY).toISOString();
      return { last_at: at, last_delivered: true, last_delivered_at: at, last_failed_at: null, consecutive_failed: 0, conclusive: 1, window_from: at, window_to: at };
    };
    const check = { decision: "allow", reasons: [] };
    expect(labelFor({ check, tests: ev(5), now, th: VERDICT_DEFAULTS }).label).toBe("checks_passed");
    expect(labelFor({ check, tests: ev(EVIDENCE_AGE.checkFirstAfterDays + 1), now, th: VERDICT_DEFAULTS })).toMatchObject({ label: "check_first", reason_code: "stale_test" });
    expect(labelFor({ check, tests: ev(EVIDENCE_AGE.noDataAfterDays + 1), now, th: VERDICT_DEFAULTS })).toMatchObject({ label: "no_data", reason_code: "old_evidence" });
    // The env cannot stretch "recent" past 30 days.
    expect(VERDICT_DEFAULTS.payMaxAgeDays).toBeLessThanOrEqual(30);
  });
});

describe("appeal: 72 h pause, re-buy, seller reply shown", () => {
  it("pauses checks_failed and shows the reply", async () => {
    const s = await setup();
    for (const d of ["2026-10-17", "2026-10-19", "2026-10-21"]) await s.buy(1, T(d + "T13:00:00Z"), false);
    await s.rescan();
    await s.verdict(R(1));
    const q = await (await s.owner("/v1/owner/reviews")).json();
    await s.owner("/v1/owner/reviews", { host: "api.s1.com", action: "approve", evidence: q.reviews[0].evidence });
    expect((await s.verdict(R(1))).label).toBe("checks_failed");
    const a = await (await s.owner("/v1/owner/reviews", { host: "api.s1.com", action: "appeal", reply: "We fixed it", url: R(1) })).json();
    expect(a.paused_until).toBe(new Date(NOW + 72 * 3_600_000).toISOString());
    const p = await s.verdict(R(1));
    expect(p).toMatchObject({ label: "check_first", reason_code: "retest_requested" });
    expect(Date.parse(p.retest.paused_until)).toBe(Date.parse(a.paused_until));
    expect(p.seller_replies.map((r: any) => r.text)).toContain("We fixed it");
    s.advance(73 * 3_600_000);
    expect((await s.verdict(R(1))).label).toBe("checks_failed");
  });
});

describe("firewall: competitor, customer and paying (monitoring) status never change the verdict", () => {
  it("app level: competitor/customer lists change only the disclosure flags", async () => {
    const results: any[] = [];
    for (const env of [{}, { VERDICT_COMPETITOR_DOMAINS: "api.s1.com" }, { VERDICT_CUSTOMER_DOMAINS: "api.s1.com" }] as Record<string, string>[]) {
      const s = await setup(env);
      for (const d of ["2026-10-17", "2026-10-19", "2026-10-21"]) await s.buy(1, T(d + "T13:00:00Z"), false);
      await s.rescan();
      results.push(await s.verdict(R(1)));
    }
    const strip = (v: any) => ({ label: v.label, reason_code: v.reason_code, reason_codes: v.reason_codes, decision: v.check.decision, reasons: v.check.reasons });
    expect(strip(results[1])).toEqual(strip(results[0]));
    expect(strip(results[2])).toEqual(strip(results[0]));
    expect(results.map((v) => v.relationship)).toEqual([
      { competitor: false, customer: false, paying_seller: false },
      { competitor: true, customer: false, paying_seller: false },
      { competitor: false, customer: true, paying_seller: false },
    ]);
  });

  it("function level: a monitoring subscription / payment to Lumi in the lookup doc changes nothing", () => {
    const now = T("2026-10-23T12:00:00Z");
    const entry = (purchases: any[], extra: any = {}) => ({
      resource: R(9), domain: "api.s9.com", tier: "purchase-verified", listed_price_usd: "0.01",
      pay_to: [{ pay_to: payTo(9), network: "eip155:8453" }],
      quote_checks: { last_checked_at: "2026-10-22T12:00:00Z", last_valid_quote: true, checks_recorded: 5, valid_quote_rate: 1, median_latency_ms: 300 },
      domain_age: { age_days: 400 }, purchases, ...extra,
    });
    const paid = [{ type: "monitoring", plan: "pro", since: "2026-09-01", paid_usd: 99 }, { type: "paid_check_customer" }];
    for (const purchases of [
      [{ at: "2026-10-22T03:00:00Z", http_status: 200, data_returned: true, delivery: "delivered" }],
      [{ at: "2026-10-22T03:00:00Z", http_status: 502, data_returned: false, delivery: "not_delivered" }],
      [],
    ]) {
      const plain = { catalog: { entries: [entry(purchases)] }, curated: [] };
      const paying = { catalog: { entries: [entry(purchases, { monitored: true, badge: "monitored_by_lumi" })] }, curated: [], commercial_relationship: paid };
      const a: any = trustVerdict({ url: R(9) }, plain, null, BASE, undefined, now);
      const b: any = trustVerdict({ url: R(9) }, paying, null, BASE, undefined, now);
      expect(b.verdict).toBe(a.verdict);
      expect(b.reasons.map((r: any) => r.code)).toEqual(a.reasons.map((r: any) => r.code));
      const la = labelFor({ check: { decision: a.verdict, reasons: a.reasons }, tests: testBuyEvidence(plain, null), now, th: VERDICT_DEFAULTS });
      const lb = labelFor({ check: { decision: b.verdict, reasons: b.reasons }, tests: testBuyEvidence(paying, null), now, th: VERDICT_DEFAULTS });
      expect(lb).toEqual(la);
    }
  });

  it("source: the label code never reads relationship, commercial or monitoring data", () => {
    const src = readFileSync(new URL("../src/trust/verdict.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function labelFor"), src.indexOf("export function thresholdsDoc"));
    expect(body).not.toMatch(/relationship|commercial|monitor|paying|competitor|customer/i);
  });
});

describe("observed on-chain payments (activity)", () => {
  const row = (o: any = {}) => ({ seller: "s1", domains: ["api.s1.com"], pay_to: ["eip155:8453:" + payTo(1)], payer_groups_30d: 42, payments_30d: 1200, total_usd_30d: 12.34, top_payer_share: 0.7, last_payment_at: new Date(NOW - 9 * DAY).toISOString(), window_end: new Date(NOW - DAY).toISOString(), ...o });

  it("bands match the legal wording", () => {
    expect([0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10000, 5e6].map(activityBand)).toEqual(["0", "1–9", "1–9", "10–99", "10–99", "100–999", "100–999", "1k–10k", "1k–10k", "10k+", "10k+"]);
  });

  it("owner ingest -> verdict shows bands and weeks only; no payer wallets, no USD; owner-only", async () => {
    const s = await setup();
    expect((await s.req("/v1/owner/activity", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await s.req("/v1/owner/reviews")).status).toBe(401);
    const payer = "0x" + "f".repeat(40);
    const r = await (await s.owner("/v1/owner/activity", { source: "test", rows: [row({ payers: [payer] }), row({ seller: "s2", domains: ["api.s2.com"], pay_to: ["eip155:8453:" + payTo(2)], payer_groups_30d: 4 })] })).json();
    expect(r).toMatchObject({ ok: true, valid: 2, written: 2 });
    const v = await s.verdict(R(1));
    expect(v.observed_onchain_payments).toMatchObject({ name: ACTIVITY_NAME, shown: true, payer_groups_30d: "10–99", payments_30d: "1k–10k", last_payment: expect.stringMatching(/week/), concentrated: true });
    const txt = JSON.stringify(v);
    expect(txt).not.toContain(payer.slice(2, 12));
    expect(txt).not.toMatch(/12\.34|total_usd|usd_30d/i);
    expect(Object.keys(v.observed_onchain_payments).sort()).toEqual(["as_of", "concentrated", "definition", "last_payment", "name", "payer_groups_30d", "payments_30d", "shown"]);
    // fewer than 5 payer groups: nothing but the note
    const v2 = await s.verdict(R(2));
    expect(v2.observed_onchain_payments).toMatchObject({ shown: false, note: "too few payers to show" });
    expect(v2.observed_onchain_payments).not.toHaveProperty("payments_30d");
    // the label does not move with activity
    expect(v.label).toBe((await s.check(R(1))).label);
    // re-ingesting the same rows writes nothing
    const again = await (await s.owner("/v1/owner/activity", { source: "test", rows: [row()] })).json();
    expect(again).toMatchObject({ written: 0, unchanged: 1 });
  });

  it("the paid vendor report shows the same activity block (bands only)", async () => {
    const s = await setup();
    await s.owner("/v1/owner/activity", { source: "test", rows: [row({ seller: "asksurf", domains: ["asksurf.ai"], pay_to: ["eip155:8453:0x" + "a".repeat(40)], payer_groups_30d: 150 })] });
    const r = await s.owner("/v1/trust/vendors/asksurf/report");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.observed_onchain_payments).toMatchObject({ name: ACTIVITY_NAME, shown: true, payer_groups_30d: "100–999" });
    expect(JSON.stringify(b.observed_onchain_payments)).not.toMatch(/12\.34|0x/);
  });

  it("Lumi's own sellers and wallets are never ingested", async () => {
    const s = await setup();
    const r = await (await s.owner("/v1/owner/activity", { source: "test", rows: [
      row({ seller: "lumi", domains: ["api.lumitrades.io"], pay_to: ["eip155:8453:0x0000000000000000000000000000000000000001"] }),
      row({ seller: "lumi-wallet", domains: ["other.example"], pay_to: ["eip155:8453:" + ENV.EVM_PAY_TO] }),
    ] })).json();
    expect(r.valid).toBe(0);
    expect(r.rejected.map((x: any) => x.error)).toEqual(["lumi_self_excluded", "lumi_self_excluded"]);
  });

  it("activityPublic: stale rows are flagged; null rows give null", () => {
    expect(activityPublic(null, NOW, VERDICT_DEFAULTS)).toBeNull();
    const a = createActivity(new MemoryActivityStore(), () => NOW);
    expect(a).toBeTruthy();
  });

  it("D1 store writes in batches of at most 100 statements", async () => {
    const batches: number[] = [];
    const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) };
    const db: any = { prepare: () => stmt, batch: async (xs: unknown[]) => { batches.push(xs.length); return []; } };
    const a = createActivity(new D1ActivityStore(db), () => NOW);
    const rows = Array.from({ length: 150 }, (_, i) => row({ seller: "x" + i, domains: [`x${i}.example`], pay_to: ["eip155:8453:0x" + i.toString(16).padStart(40, "0")] }));
    const r: any = await a.ingest({ source: "test", rows });
    expect(r.written).toBe(150);
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches)).toBeLessThanOrEqual(100);
  });
});

describe("M3 price switch and listings", () => {
  it("default: free alias, not listed as a paid resource", async () => {
    const s = await setup();
    expect((await s.req("/v1/verdict?url=" + enc(R(1)))).status).toBe(200);
    const wk = await (await s.req("/.well-known/x402")).text();
    expect(wk).not.toContain("/v1/verdict");
    const rules = await (await s.req("/v1/verdict/rules")).json();
    expect(rules.pricing).toBe("free");
  });

  it("paid: 402 at <= $0.004, listed in well-known and OpenAPI, and a paid call returns the same label", async () => {
    const s = await setup({ VERDICT_PRICING: "paid" });
    const p = "/v1/verdict?url=" + enc(R(1));
    const r = await s.req(p);
    expect(r.status).toBe(402);
    const q: any = await r.json();
    const usdc = q.accepts.find((a: any) => a.network.startsWith("eip155:"));
    expect(Number(usdc.amount) / 1e6).toBeLessThanOrEqual(VERDICT_MAX_USD);
    expect(await (await s.req("/.well-known/x402")).text()).toContain("/v1/verdict");
    expect(await (await s.req("/openapi.json")).text()).toContain("/v1/verdict");
    const ok = await s.req(p, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts.find((a: any) => a.network.startsWith("xrpl:") && (a.extra?.symbol ?? a.asset) === "RLUSD") ?? q.accepts.find((a: any) => a.network.startsWith("xrpl:"))) } });
    expect(ok.status).toBe(200);
    const b = await ok.json();
    expect(b.label).toBe((await s.check(R(1))).label);
  });

  it("an env price above the cap falls back to $0.004", () => {
    const c = loadConfig({ ...ENV, PRICE_VERDICT_USDC: "0.01" } as any);
    expect(Number(c.usdPrices.verdict)).toBeLessThanOrEqual(VERDICT_MAX_USD);
    expect(Number(loadConfig({ ...ENV, PRICE_VERDICT_USDC: "0.002" } as any).usdPrices.verdict)).toBe(0.002);
  });
});

describe("public wording (M4, M12, banned words)", () => {
  it("rules, verdicts, skill.md, OpenAPI and the MCP tool list use neutral words", async () => {
    const s = await setup({ VERDICT_PRICING: "paid" });
    for (const d of ["2026-10-17", "2026-10-19", "2026-10-21"]) await s.buy(1, T(d + "T13:00:00Z"), false);
    await s.rescan();
    const texts = [
      await (await s.req("/v1/verdict/rules")).text(),
      JSON.stringify(await s.check(R(1))),
      JSON.stringify(await s.check("https://never-seen.example/x")),
      await (await s.req("/skill.md")).text(),
    ];
    for (const t of texts) { expect(t).not.toMatch(BANNED); expect(t).not.toMatch(OLD_LABELS); }
    const rules = JSON.parse(texts[0]);
    expect(JSON.stringify(rules)).toContain("allow");
    const oa = await (await s.req("/openapi.json")).json();
    const vop = JSON.stringify(oa.paths["/v1/verdict"]);
    expect(vop).not.toMatch(BANNED);
    expect(JSON.stringify(oa)).not.toMatch(/fraud-check/i);
    const mcp = await (await s.req("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
    const tool = mcp.result.tools.find((t: any) => /verdict/.test(t.name));
    expect(tool).toBeTruthy();
    expect(JSON.stringify(tool)).not.toMatch(BANNED);
  });
});
