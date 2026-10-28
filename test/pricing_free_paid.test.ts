/**
 * Pricing change 2026-10-28: the basic trust check is free and rate-limited (DO counter, no D1 writes); the high-value check is
 * paid at 0.5% of the stated amount (min $0.005, max $0.25); paying never changes a verdict or score; 410s point to the
 * current trust routes; discovery examples have no literal {id}/{coin} placeholders.
 */
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { MemoryQuotaCounter, type QuotaCounter } from "../src/free_quota";
import { HIGH_VALUE, highValuePriceUsd, FREE_TRUST_CHECK_LIMITS } from "../src/config";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const BASE = "https://api.lumitrades.io";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "https://api.s1.com/v1/q";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  PUBLIC_BASE_URL: BASE, XRPL_RPC_URLS: "https://xrpl.rpc.test/",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: "https://evm-fac.test", BASE_RPC_URL: "https://base-rpc.test",
};
const enc = encodeURIComponent;
const b64 = (s: string | null) => JSON.parse(Buffer.from(s ?? "", "base64").toString("utf8"));

async function setup(opts: { quotaCounter?: QuotaCounter; now?: number } = {}) {
  const t = opts.now ?? NOW;
  const fallback = makeFetch(happyFacilitator());
  const ITEMS = [{
    resource: SELLER, type: "http", description: "d",
    accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: "0x" + "ab".repeat(20) }],
    extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
    quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 6, lastCalledAt: new Date(t - 3_600_000).toISOString() }, lastUpdated: new Date(t).toISOString(),
  }];
  const doFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: ITEMS, pagination: { limit: 30, offset: 0, total: 1 } }));
    if (url === "https://xrpl.rpc.test/") return new Response(JSON.stringify({ result: { transactions: [] } }));
    if (url.startsWith("https://base-rpc.test")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
    if (url.startsWith("https://api.s1.com/")) {
      const pr = { x402Version: 2, accepts: ITEMS[0].accepts };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
    }
    return fallback(input, init);
  }) as typeof fetch;
  const ev = new MemoryEvidenceStore();
  ev.resources = new Set([SELLER]);
  const app = createApp(ENV as any, {
    fetch: doFetch, log: () => {}, now: () => t, catalogStore: new MemoryCatalogStore(), evidenceStore: ev, trialStore: new MemoryTrialStore(),
    trustStore: new MemoryTrustStore(SEED_OBSERVATIONS), ...(opts.quotaCounter ? { quotaCounter: opts.quotaCounter } : {}),
  } as any);
  await app.scheduled();
  const req = (p: string, headers: Record<string, string> = {}, ip = "203.0.113.7") =>
    app.fetch(new Request(BASE + p, { headers: { "CF-Connecting-IP": ip, ...headers } }));
  return { app, req };
}

describe("high-value price math", () => {
  it("0.5% of the amount, rounded up to $0.0001, floor $0.005, cap $0.25", () => {
    expect(HIGH_VALUE).toMatchObject({ rate: 0.005, minUsd: 0.005, maxUsd: 0.25 });
    const cases: [number, string][] = [[0.01, "0.005"], [1, "0.005"], [1.01, "0.0051"], [3.33, "0.0167"], [4, "0.02"], [10, "0.05"], [50, "0.25"], [50.01, "0.25"], [1_000_000, "0.25"]];
    for (const [amt, usd] of cases) expect(highValuePriceUsd(amt), String(amt)).toBe(usd);
  });
});

describe("GET /v1/trust/check/high-value: x402 v2 quote", () => {
  it.each([["1", "0.005", "5000"], ["4", "0.02", "20000"], ["100", "0.25", "250000"]])("amount=%s quotes $%s in every rail, XRPL as decimals", async (amount, usd, atomic) => {
    const { req } = await setup();
    const r = await req(`/v1/trust/check/high-value?amount=${amount}&url=${enc(SELLER)}`);
    expect(r.status).toBe(402);
    const body: any = await r.json();
    const hdr = b64(r.headers.get("PAYMENT-REQUIRED"));
    expect(hdr.x402Version).toBe(2);
    expect(body.x402Version).toBe(2);
    for (const q of [body, hdr]) {
      expect(q.accepts.length).toBeGreaterThan(1);
      for (const a of q.accepts) {
        expect(a.scheme).toBe("exact");
        expect(typeof a.payTo).toBe("string");
        if (a.network.startsWith("eip155:")) expect(a.amount).toBe(atomic);
        if (a.network.startsWith("xrpl:")) {
          const sym = a.extra?.symbol ?? a.asset;
          if (sym === "XRP") expect(Number(a.amount)).toBeGreaterThan(0); else expect(a.amount).toBe(usd);
          expect(String(a.amount)).toMatch(/^\d+(\.\d+)?$/);
        }
      }
    }
  });

  it("rejects a missing or out-of-range amount with 400 (never quoted, never charged)", async () => {
    const { req } = await setup();
    for (const q of ["", "&amount=0", "&amount=-1", "&amount=abc", `&amount=${HIGH_VALUE.maxAmountUsd * 10}`]) {
      const r = await req(`/v1/trust/check/high-value?url=${enc(SELLER)}${q}`);
      expect(r.status, q).toBe(400);
    }
  });

  it("the invoice is bound to the stated amount: a payment for amount=1 does not unlock amount=100", async () => {
    const { req } = await setup();
    const q1: any = await (await req(`/v1/trust/check/high-value?amount=1&url=${enc(SELLER)}`)).json();
    const opt = q1.accepts.find((a: any) => a.network.startsWith("xrpl:"));
    const cheap = await req(`/v1/trust/check/high-value?amount=100&url=${enc(SELLER)}`, { "PAYMENT-SIGNATURE": paymentHeaderFor(opt) });
    expect(cheap.status).not.toBe(200);
    const ok = await req(`/v1/trust/check/high-value?amount=1&url=${enc(SELLER)}`, { "PAYMENT-SIGNATURE": paymentHeaderFor(opt) });
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body.kind).toBe("trust_check");
  });
});

describe("free GET /v1/trust/check", () => {
  it("free: 200 with RateLimit headers, no 402, access.mode free", async () => {
    const { req } = await setup();
    const r = await req(`/v1/trust/check?url=${enc(SELLER)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(r.headers.get("RateLimit-Limit")).toBe(String(FREE_TRUST_CHECK_LIMITS.perDay));
    expect(r.headers.get("RateLimit-Remaining")).toBe(String(FREE_TRUST_CHECK_LIMITS.perDay - 1));
    const b: any = await r.json();
    expect(b.access).toMatchObject({ mode: "free", charged: false, free_limit_per_day: FREE_TRUST_CHECK_LIMITS.perDay });
  });

  it("over the per-minute burst: 429 free_limit_reached naming the paid route, with headers, not charged", async () => {
    const { req } = await setup();
    for (let i = 0; i < FREE_TRUST_CHECK_LIMITS.perMinute; i++) expect((await req(`/v1/trust/check?url=${enc(SELLER)}`)).status).toBe(200);
    const r = await req(`/v1/trust/check?url=${enc(SELLER)}&amount=20`);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(r.headers.get("RateLimit-Remaining")).toBe("0");
    expect(r.headers.get("X-Lumi-Paid-Route")).toContain("/v1/trust/check/high-value?");
    expect(r.headers.get("Link")).toMatch(/rel="payment"/);
    const b: any = await r.json();
    expect(b.error).toBe("free_limit_reached");
    expect(b.limit.window).toBe("minute");
    expect(b.paid_route).toMatchObject({ name: "high_value_check", method: "GET", price_usd: "0.1" });
    expect(b.paid_route.url).toContain("amount=20");
    expect(b.other_paid_routes).toHaveProperty("vendor_report");
    expect(b.note).toMatch(/Not charged/);
    // another IP is not affected
    expect((await req(`/v1/trust/check?url=${enc(SELLER)}`, {}, "198.51.100.9")).status).toBe(200);
  });

  it("daily limit per key: one X-Lumi-Key across many IPs is still capped", async () => {
    const counter = new MemoryQuotaCounter(() => NOW);
    const { req } = await setup({ quotaCounter: counter });
    let last = 0;
    for (let i = 0; i <= FREE_TRUST_CHECK_LIMITS.perDay; i++) last = (await req(`/v1/trust/check?url=${enc(SELLER)}`, { "X-Lumi-Key": "agent-1" }, `10.0.${i >> 8}.${i & 255}`)).status;
    expect(last).toBe(429);
  });

  it("fails open when the counter is down: served, no RateLimit headers", async () => {
    const { req } = await setup({ quotaCounter: { take: async () => { throw new Error("DO down"); } } });
    const r = await req(`/v1/trust/check?url=${enc(SELLER)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("paying never changes the verdict or score: free and paid high-value answers agree", async () => {
    const { req } = await setup();
    const free: any = await (await req(`/v1/trust/check?url=${enc(SELLER)}&amount=4`)).json();
    const q: any = await (await req(`/v1/trust/check/high-value?amount=4&url=${enc(SELLER)}`)).json();
    const opt = q.accepts.find((a: any) => a.network.startsWith("xrpl:"));
    const paid: any = await (await req(`/v1/trust/check/high-value?amount=4&url=${enc(SELLER)}`, { "PAYMENT-SIGNATURE": paymentHeaderFor(opt) })).json();
    expect(paid.verdict).toBe(free.verdict);
    expect(paid.reasons).toEqual(free.reasons);
    expect(paid.score ?? null).toEqual(free.score ?? null);
    expect(paid.label ?? null).toEqual(free.label ?? null);
  });
});

describe("410 hints and discovery placeholders", () => {
  it("a retired route answers 410 with working current_routes (no placeholders)", async () => {
    const { req } = await setup();
    const r = await req("/v1/signal/XRP");
    expect(r.status).toBe(410);
    const b: any = await r.json();
    expect(Object.keys(b.current_routes)).toEqual(expect.arrayContaining(["trust_check", "high_value_check", "vendor_report"]));
    for (const v of Object.values(b.current_routes) as any[]) {
      const u = typeof v === "string" ? v : v.url;
      expect(u).toMatch(/^https:\/\/api\.lumitrades\.io\//);
      expect(u).not.toMatch(/[{}<>]/);
    }
  });

  it("no literal {id} / {coin} in any example URL of the discovery documents", async () => {
    const { req } = await setup();
    const urls: string[] = [];
    const walk = (v: unknown, k = "") => {
      if (typeof v === "string") { if (/^https?:\/\//.test(v) && !/^(path|template|\$ref)$/.test(k)) urls.push(v); }
      else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
      else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
    };
    for (const p of ["/openapi.json", "/.well-known/x402", "/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/.well-known/agents.json", "/v1/samples", "/"]) {
      const r = await req(p, { Accept: "application/json" });
      if (!(r.headers.get("content-type") ?? "").includes("json")) continue;
      walk(await r.json());
    }
    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) expect(u, u).not.toMatch(/\{(id|coin)\}|%7B(id|coin)%7D/i);
    for (const p of ["/llms.txt", "/skill.md"]) {
      const t = await (await req(p)).text();
      for (const m of t.match(/https?:\/\/\S+/g) ?? []) expect(m, p).not.toMatch(/\{(id|coin)\}|%7B(id|coin)%7D/i);
    }
  });
});
