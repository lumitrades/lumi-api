import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { PAID_ENDPOINTS } from "../src/catalog";
import { EXAMPLE_RECEIPTS_SELLER, RECEIPTS_EXAMPLE, receiptsResourceUrl } from "../src/config";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { MemoryActivityStore } from "../src/trust/activity";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json } from "./helpers";

const BASE = "https://api.lumitrades.io";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = EXAMPLE_RECEIPTS_SELLER;
const RESOURCE = `https://${SELLER}/api/v1/xrpl/kimchi-premium`;
const PAY = "0x" + "a".repeat(40);

const ITEM = {
  resource: RESOURCE, type: "http", description: "d",
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "2000", payTo: PAY }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 6, lastCalledAt: new Date(NOW - 3_600_000).toISOString() },
  lastUpdated: new Date(NOW).toISOString(),
};

const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  PUBLIC_BASE_URL: BASE, XRPL_RPC_URLS: "https://xrpl.rpc.test/",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532",
  EVM_FACILITATOR_URL: "https://evm-fac.test", EVM_CDP_ONLY_ROUTES: "none", BASE_RPC_URL: "https://base-rpc.test",
};

async function setup(withBuy = false) {
  const catalogStore = new MemoryCatalogStore();
  const ev = new MemoryEvidenceStore();
  ev.resources = new Set([RESOURCE]);
  const fallback = makeFetch(happyFacilitator());
  const doFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"))
      return new Response(JSON.stringify({ items: [ITEM], pagination: { limit: 30, offset: 0, total: 1 } }));
    if (url.startsWith("https://base-rpc.test")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
    if (url === "https://xrpl.rpc.test/") return new Response(JSON.stringify({ result: { transactions: [] } }));
    return fallback(input, init);
  }) as typeof fetch;
  const app = createApp(ENV as any, {
    fetch: doFetch, log: () => {}, now: () => NOW, catalogStore, evidenceStore: ev,
    trialStore: new MemoryTrialStore(), activityStore: new MemoryActivityStore(),
    trustStore: new MemoryTrustStore(SEED_OBSERVATIONS),
  } as any);
  await app.scheduled();
  if (withBuy) {
    await catalogStore.addBuy({
      resource: RESOURCE, domain: SELLER, ts: NOW - 86_400_000, network: "eip155:8453",
      tx_hash: "0x" + (NOW - 86_400_000).toString(16).padStart(64, "0"), amount: "0.002", asset: "USDC",
      pay_to: PAY, facilitator: null, http_status: 200, data_returned: true, latency_ms: 80, summary: "ok",
    } as any);
  }
  const req = (p: string, init: RequestInit = {}) => app.fetch(new Request(BASE + p, init));
  return { app, req };
}

describe("receiptsResourceUrl", () => {
  it("uses the listed example when the request has no seller, and keeps the request query when it does", () => {
    expect(receiptsResourceUrl(BASE)).toBe(`${BASE}${RECEIPTS_EXAMPLE}`);
    expect(receiptsResourceUrl(BASE, "")).toBe(`${BASE}${RECEIPTS_EXAMPLE}`);
    expect(receiptsResourceUrl(BASE, "?seller=api.example.com")).toBe(`${BASE}/v1/trust/receipts?seller=api.example.com`);
    expect(receiptsResourceUrl(BASE, "?seller=https%3A%2F%2Fa.example%2Fx&x=1")).toBe(`${BASE}/v1/trust/receipts?seller=https%3A%2F%2Fa.example%2Fx&x=1`);
  });
});

describe("receipts listings carry a usable seller query", () => {
  it("catalog, well-known x402 and OpenAPI example URLs include ?seller=api.printmoneylab.com", async () => {
    const receipts = PAID_ENDPOINTS.find((e) => e.route === "receipts")!;
    expect(receipts.example).toBe(RECEIPTS_EXAMPLE);
    expect(receipts.example).toContain(`seller=${SELLER}`);
    const { req } = await setup();
    const wk = await (await req("/.well-known/x402")).json() as any;
    const listed = wk.resources.find((r: any) => String(r.url).includes("/v1/trust/receipts"));
    expect(listed.url).toBe(`${BASE}${RECEIPTS_EXAMPLE}`);
    expect(listed.url).toContain(`seller=${SELLER}`);
    const oa = await (await req("/openapi.json")).json() as any;
    const seller = oa.paths["/v1/trust/receipts"].get.parameters.find((p: any) => p.name === "seller");
    expect(seller.example).toBe(SELLER);
    expect(oa.paths["/v1/trust/receipts"].get["x-example-url"]).toBe(`${BASE}${RECEIPTS_EXAMPLE}`);
  });

  it("a bare /v1/trust/receipts 402 quotes resource.url as the listed example, not the bare path", async () => {
    const { req } = await setup();
    const r = await req("/v1/trust/receipts");
    expect(r.status).toBe(402);
    const body: any = await r.json();
    const hdr = decodeB64Json(r.headers.get("PAYMENT-REQUIRED"));
    expect(body.resource.url).toBe(`${BASE}${RECEIPTS_EXAMPLE}`);
    expect(hdr.resource.url).toBe(`${BASE}${RECEIPTS_EXAMPLE}`);
    expect(body.resource.url).not.toBe(`${BASE}/v1/trust/receipts`);
  });

  it("a 402 for a real ?seller= query quotes resource.url as that requested URL", async () => {
    const { req } = await setup(true);
    const path = `/v1/trust/receipts?seller=${encodeURIComponent(SELLER)}`;
    const r = await req(path);
    expect(r.status).toBe(402);
    const body: any = await r.json();
    const hdr = decodeB64Json(r.headers.get("PAYMENT-REQUIRED"));
    expect(body.resource.url).toBe(`${BASE}${path}`);
    expect(hdr.resource.url).toBe(`${BASE}${path}`);
  });

  it("paying the listed example URL is charged and delivers receipts when Lumi has test-buys of that seller", async () => {
    const { req } = await setup(true);
    const path = RECEIPTS_EXAMPLE;
    const r = await req(path);
    expect(r.status).toBe(402);
    const q: any = await r.json();
    expect(q.resource.url).toBe(`${BASE}${path}`);
    const opt = q.accepts.find((a: any) => a.network.startsWith("xrpl:") && (a.extra?.symbol ?? a.asset) === "RLUSD") ?? q.accepts.find((a: any) => a.network.startsWith("xrpl:"));
    const r2 = await req(path, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(opt) } });
    expect(r2.status).toBe(200);
    const body: any = await r2.json();
    expect(body.kind).toBe("lumi_seller_receipts");
    expect(body.count).toBe(1);
  });
});
