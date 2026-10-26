/**
 * Sub-cent paid routes (branch paid-subcent-endpoints, NOT deployed): GET /v1/trust/receipts ($0.005) and GET /v1/check/batch
 * ($0.008). 402 quotes with Bazaar metadata, never charged on bad input, same check core and signing key as /v1/check.
 */
import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { verifySignedResponse } from "../src/trust/lumi_sign";
import { MemoryActivityStore } from "../src/trust/activity";
import { BAZAAR_ROUTES, ROUTE_TAGS } from "../src/bazaar";
import { DEFAULT_PRICES } from "../src/config";
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
  return { app, req, owner, buy, verdict, check, catalogStore, activityStore, advance: (ms: number) => (t += ms), rescan: () => app.scheduled() };
}


const paid = async (s: Awaited<ReturnType<typeof setup>>, p: string) => {
  const r = await s.req(p);
  if (r.status !== 402) return { status: r.status, body: (await r.json()) as any };
  const q: any = await r.json();
  const opt = q.accepts.find((a: any) => a.network.startsWith("xrpl:") && (a.extra?.symbol ?? a.asset) === "RLUSD") ?? q.accepts.find((a: any) => a.network.startsWith("xrpl:"));
  const r2 = await s.req(p, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(opt) } });
  return { status: r2.status, body: (await r2.json()) as any, quote: q };
};

describe("sub-cent prices", () => {
  it("receipts $0.005 and batch_check $0.008, below every existing route", () => {
    expect(DEFAULT_PRICES.receipts.usd).toBe("0.005");
    expect(DEFAULT_PRICES.batch_check.usd).toBe("0.008");
    for (const r of ["receipts", "batch_check"] as const) expect(Number(DEFAULT_PRICES[r].usd)).toBeLessThan(0.01);
  });
});

describe("402 quotes and Bazaar metadata", () => {
  for (const [path, route, atomic, key] of [["/v1/trust/receipts", "receipts", "5000", "seller"], ["/v1/check/batch", "batch_check", "8000", "urls"]] as const) {
    it(`${path} bare: normal 402 at the sub-cent price with input/output examples`, async () => {
      const s = await setup();
      const r = await s.req(path);
      expect(r.status).toBe(402);
      const q: any = await r.json();
      const base = q.accepts.find((a: any) => a.network.startsWith("eip155:"));
      expect(base.amount).toBe(atomic);
      expect(q.resource.description).toBe(BAZAAR_ROUTES[route].description);
      expect(q.resource.tags).toEqual(ROUTE_TAGS[route]);
      const bz = q.extensions.bazaar;
      expect(bz.info.output.example.kind).toBe(BAZAAR_ROUTES[route].example.kind);
      expect(Object.keys(bz.info.input.queryParams)).toEqual([key]);
      expect(bz.schema.properties.input.properties.queryParams.required).toEqual([key]);
      expect(JSON.stringify(q)).not.toMatch(/\b(scam\w*|fraud\w*|partner\w*|solana)\b/i);
    });
  }
});

describe("GET /v1/trust/receipts", () => {
  it("bad input is 400 and unknown seller is 404, both before any payment", async () => {
    const s = await setup();
    const a = await s.req("/v1/trust/receipts?seller=" + enc("not a domain"));
    expect(a.status).toBe(400);
    expect((await a.json() as any).note).toBe("Not charged.");
    const b = await s.req("/v1/trust/receipts?seller=nobody-here.example");
    expect(b.status).toBe(404);
    expect((await b.json() as any).note).toBe("Not charged.");
  });
  it("returns Lumi's test-buys for the seller, newest first, signed", async () => {
    const s = await setup();
    await s.buy(1, NOW - 3 * DAY, false);
    await s.buy(1, NOW - 2 * DAY, true);
    for (const seller of ["api.s1.com", R(1), payTo(1)]) {
      const r = await paid(s, "/v1/trust/receipts?seller=" + enc(seller));
      expect(r.status, seller).toBe(200);
      expect(r.body.kind).toBe("lumi_seller_receipts");
      expect(r.body.count).toBe(2);
      expect(r.body.delivered).toBe(1);
      expect(r.body.not_delivered).toBe(1);
      expect(Date.parse(r.body.receipts[0].at)).toBeGreaterThan(Date.parse(r.body.receipts[1].at));
      expect(r.body.receipts[0].tx_hash).toBe("0x" + (NOW - 2 * DAY).toString(16).padStart(64, "0"));
      expect(r.body.verify).toBe(BASE + "/v1/trust/receipts/verify");
      expect((await verifySignedResponse(r.body.lumi_receipt, { trusted: [PUB], now: NOW })).ok).toBe(true);
    }
  });
});

describe("GET /v1/check/batch", () => {
  it("rejects empty, oversize and malformed lists before payment", async () => {
    const s = await setup();
    const many = Array.from({ length: 11 }, (_, i) => `https://h${i}.example/x`).join(",");
    for (const q of ["urls=", "urls=" + enc(many), "urls=" + enc("https://a.example/x,not a url")]) {
      const r = await s.req("/v1/check/batch?" + q);
      expect(r.status, q).toBe(400);
      expect((await r.json() as any).note).toBe("Not charged.");
    }
  });
  it("labels match the free /v1/check for every entry and the answer verifies against the same key", async () => {
    const s = await setup();
    await s.buy(1, NOW - 2 * DAY, true);
    const list = [R(1), R(2), "nobody-here.example"];
    const r = await paid(s, "/v1/check/batch?urls=" + enc(list.join(",")));
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("lumi_batch_check");
    expect(r.body.count).toBe(3);
    for (const [i, u] of list.entries()) {
      const c = await s.check(u.startsWith("http") ? u : `https://${u}`);
      expect(r.body.results[i].label, u).toBe(c.label);
      expect(r.body.results[i].decision, u).toBe(c.decision);
    }
    expect(r.body.results[0].n_conclusive).toBe(1);
    expect((await verifySignedResponse(r.body.receipt, { trusted: [PUB], now: NOW })).ok).toBe(true);
  });
});
