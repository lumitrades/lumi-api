import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { MemoryActivityStore } from "../src/trust/activity";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { labelFor, VERDICT_DEFAULTS, type TestBuyEvidence } from "../src/trust/verdict";
import {
  evaluateQuote, eip55Ok, payToFormat, rollupSeller, evidenceWeight, historyBand, parseProbeRow, toRow, probeRowPublic, MemoryProbeStore,
  PROBE_LABEL, PROBE_MAX_WEIGHT, BUY_MIN_WEIGHT, FAIL_TEXT, type EndpointProbe,
} from "../src/trust/probe_checked";
import { robotsAllows } from "../tools/probe_checked";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const GOOD = "0x5E617bac19912e6d212CB303ae84655E9E203532"; // valid EIP-55
const BANNED = /\b(scam\w*|fraud\w*|unsafe|dishonest\w*|fake\w*|verified)\b/i;
const q402 = (o: Record<string, unknown> = {}) => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: GOOD, maxTimeoutSeconds: 60, ...o }] });
const ep = (quote: ReturnType<typeof evaluateQuote> | null, extra: Partial<EndpointProbe> = {}): EndpointProbe => ({ endpoint: "https://a.example/x", ts: NOW, status: quote ? 402 : null, latency_ms: 120, error: null, quote, ...extra });
const allGood = { tls: { ok: true, days_left: 60 }, domain_age_days: 400, pay_to_history: "100+" as const, listing_complete: true };

describe("probe-checked: quote evaluation", () => {
  it("accepts a well-formed Base quote, checks price against the listing and the payTo", () => {
    const e = evaluateQuote(402, q402(), { price_usd: "0.01", pay_tos: [GOOD.toLowerCase()] });
    expect(e).toMatchObject({ x402: true, fields_ok: true, base_offer: true, price_usd: 0.01, price_match: true, pay_to_listed: true, pay_to_format_ok: true, codes: [] });
  });
  it("neutral codes for each failure", () => {
    expect(evaluateQuote(200, null).codes).toEqual(["no_402"]);
    expect(evaluateQuote(402, { foo: 1 }).codes).toEqual(["payment_response_invalid"]);
    expect(evaluateQuote(402, q402({ payTo: undefined })).codes).toContain("quote_fields_missing");
    expect(evaluateQuote(402, q402(), { price_usd: "0.02" }).codes).toContain("price_differs");
    expect(evaluateQuote(402, q402(), { pay_tos: ["0x" + "1".repeat(40)] }).codes).toContain("pay_to_not_listed");
    expect(evaluateQuote(402, q402({ payTo: "0x5e617BAC19912e6d212CB303ae84655E9E203532" })).codes).toContain("pay_to_checksum");
    expect(evaluateQuote(402, q402({ payTo: "rXYZ" })).codes).toContain("pay_to_format");
  });
  it("v1 quotes (maxAmountRequired, network 'base') are read too", () => {
    const e = evaluateQuote(402, { x402Version: 1, accepts: [{ scheme: "exact", network: "base", asset: USDC, maxAmountRequired: "5000", payTo: GOOD }] }, { price_usd: "0.005" });
    expect(e.fields_ok && e.price_match).toBe(true);
  });
  it("payTo formats per network and EIP-55", () => {
    expect(eip55Ok(GOOD)).toBe(true);
    expect(eip55Ok(GOOD.toLowerCase())).toBe(true);
    expect(payToFormat("eip155:8453", "0x" + "0".repeat(40)).ok).toBe(false);
    expect(payToFormat("xrpl:0", "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH").ok).toBe(true);
    expect(payToFormat("stellar:pubnet", "G" + "A".repeat(55)).ok).toBe(true);
    expect(payToFormat("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").ok).toBe(true);
  });
  it("history is a band only", () => {
    expect([historyBand(0), historyBand(3), historyBand(42), historyBand(5000), historyBand(null)]).toEqual(["none", "1-9", "10-99", "100+", "unknown"]);
  });
});

describe("probe-checked: integrity rules", () => {
  it("a probe-only seller is labelled 'checked, not test-bought', never verified, and weight is capped below one buy", () => {
    const r = rollupSeller({ seller: "a.example", endpoints: [ep(evaluateQuote(402, q402(), { price_usd: "0.01" }))], ...allGood });
    expect(r.outcome).toBe("pass");
    expect(r.label).toBe(PROBE_LABEL);
    expect(r.label).toBe("checked, not test-bought");
    expect(r.verified).toBe(false);
    expect(r.score_weight).toBe(PROBE_MAX_WEIGHT);
    expect(PROBE_MAX_WEIGHT).toBeLessThan(BUY_MIN_WEIGHT);
    expect(evidenceWeight({ delivered_test_buys: 0, probe_weight: 99 })).toBe(PROBE_MAX_WEIGHT);
    expect(evidenceWeight({ delivered_test_buys: 1, probe_weight: 0 })).toBeGreaterThan(evidenceWeight({ delivered_test_buys: 0, probe_weight: 1 }));
    expect(probeRowPublic(toRow(r, NOW), 0)).toMatchObject({ tier: "checked, not test-bought", verified: false, test_bought: false });
  });
  it("failures are partial/fail with neutral notes; no accusatory words anywhere in the wording", () => {
    const bad = rollupSeller({ seller: "b.example", endpoints: [ep(evaluateQuote(402, { nope: true }))], ...allGood });
    expect(bad.outcome).toBe("fail");
    expect(bad.notes).toEqual(["payment response invalid"]);
    const young = rollupSeller({ seller: "c.example", endpoints: [ep(evaluateQuote(402, q402()))], ...allGood, domain_age_days: 3 });
    expect(young.outcome).toBe("partial");
    for (const t of Object.values(FAIL_TEXT)) expect(t).not.toMatch(BANNED);
    const src = readFileSync(new URL("../src/trust/probe_checked.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bscam\w*|\bfraud\w*/i);
  });
  it("robots-disallowed endpoints are not counted as checked", () => {
    const r = rollupSeller({ seller: "d.example", endpoints: [ep(null, { error: "robots_disallowed" })] });
    expect(r.outcome).toBe("not_checked");
    expect(r.score_weight).toBe(0);
  });
  it("labelFor: probe pass gives check_first/probe_checked_only, never checks_passed; buys still decide checks_passed", () => {
    const none: TestBuyEvidence = { conclusive: 0, last_delivered_at: null, last_failed_at: null, window_from: null, window_to: null, failed_streak: null } as any;
    const allow = { decision: "allow", reasons: [] };
    expect(labelFor({ check: allow, tests: none, now: NOW, th: VERDICT_DEFAULTS, probe: { outcome: "pass" } })).toMatchObject({ label: "check_first", reason_code: "probe_checked_only" });
    expect(labelFor({ check: { decision: "unknown", reasons: [{ code: "not_observed", severity: "info" }] }, tests: none, now: NOW, th: VERDICT_DEFAULTS, probe: { outcome: "pass" } }).label).toBe("check_first");
    expect(labelFor({ check: allow, tests: none, now: NOW, th: VERDICT_DEFAULTS, probe: { outcome: "fail" } }).reason_code).toBe("untested");
    const delivered = { ...none, conclusive: 1, last_delivered_at: new Date(NOW - 86_400_000).toISOString() };
    expect(labelFor({ check: allow, tests: delivered, now: NOW, th: VERDICT_DEFAULTS, probe: null }).label).toBe("checks_passed");
    expect(labelFor({ check: { decision: "block", reasons: [{ code: "pay_to_mismatch", severity: "block" }] }, tests: none, now: NOW, th: VERDICT_DEFAULTS, probe: { outcome: "pass" } }).label).toBe("checks_failed");
  });
  it("uploads reject addresses, amounts, free text and over-weight rows", () => {
    const r = toRow(rollupSeller({ seller: "a.example", endpoints: [ep(evaluateQuote(402, q402()))], ...allGood }), NOW);
    expect(typeof parseProbeRow(r)).toBe("object");
    expect(parseProbeRow({ ...r, seller: GOOD })).toBe("invalid_seller");
    expect(parseProbeRow({ ...r, notes: JSON.stringify(["this seller is shady"]) })).toBe("invalid_notes");
    expect(parseProbeRow({ ...r, score_weight: 1 })).toBe("invalid_score_weight");
    expect(parseProbeRow({ ...r, checks: JSON.stringify({ income: "pass" }) })).toBe("invalid_checks");
  });
  it("robots.txt matching", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /api/", "/api/x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /api/\nAllow: /api/paid", "/api/paid/x")).toBe(true);
    expect(robotsAllows("User-agent: LumiTrustProbe\nDisallow: /\n\nUser-agent: *\nAllow: /", "/x")).toBe(false);
    expect(robotsAllows("", "/x")).toBe(true);
  });
});

describe("probe-checked: API", () => {
  const OWNER = "k".repeat(52);
  const BASE = "https://api.lumitrades.io";
  const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: OWNER, PUBLIC_BASE_URL: BASE, XRPL_RPC_URLS: "https://xrpl.rpc.test/" };
  const mk = () => {
    const probeStore = new MemoryProbeStore();
    const fallback = makeFetch(happyFacilitator());
    const doFetch = (async (input: any, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.cdp.coinbase.com/")) return new Response(JSON.stringify({ items: [], pagination: { limit: 30, offset: 0, total: 0 } }));
      if (url === "https://xrpl.rpc.test/") return new Response(JSON.stringify({ result: { transactions: [] } }));
      return fallback(input, init);
    }) as typeof fetch;
    const app = createApp(ENV as any, { fetch: doFetch, log: () => {}, now: () => NOW, catalogStore: new MemoryCatalogStore(), evidenceStore: new MemoryEvidenceStore(), trialStore: new MemoryTrialStore(), activityStore: new MemoryActivityStore(), trustStore: new MemoryTrustStore(SEED_OBSERVATIONS), probeStore } as any);
    const req = (p: string, init: RequestInit = {}) => app.fetch(new Request(BASE + p, { ...init, headers: { "CF-Connecting-IP": "203.0.113.9", ...(init.headers as any ?? {}) } }));
    return { app, req, probeStore };
  };
  it("owner load is owner-only, validates rows, and /v1/check shows the tier with check_first", async () => {
    const s = mk();
    const row = toRow(rollupSeller({ seller: "probe-only.example", endpoints: [ep(evaluateQuote(402, q402()))], ...allGood }), NOW);
    expect((await s.req("/v1/owner/probe-checked", { method: "POST", body: JSON.stringify({ rows: [row] }) })).status).toBe(401);
    const up: any = await (await s.req("/v1/owner/probe-checked", { method: "POST", headers: { Authorization: `Bearer ${OWNER}` }, body: JSON.stringify({ rows: [row, { ...row, seller: "lumitrades.io" }, { seller: "x" }] }) })).json();
    expect(up).toMatchObject({ received: 3, valid: 1, skipped_self: 1, written: 1 });
    const c: any = await (await s.req("/v1/check?url=" + encodeURIComponent("https://api.probe-only.example/v1/x"))).json();
    expect(c.label).toBe("check_first");
    expect(c.free_checks).toMatchObject({ tier: "checked, not test-bought", verified: false, test_bought: false, outcome: "pass" });
    expect(JSON.stringify(c.free_checks)).not.toMatch(/0x[0-9a-f]{40}/i);
    const other: any = await (await s.req("/v1/check?url=" + encodeURIComponent("https://never-seen.example/x"))).json();
    expect(other.free_checks).toBeNull();
    expect(other.label).toBe("no_data");
  });
});
