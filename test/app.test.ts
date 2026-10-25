import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, fakeDurableObjectNamespace, happyFacilitator, jsonResponse, makeFetch, paymentHeaderFor, decodeB64Json, type FakeFacilitator , NOW } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PRIVATE_NAMES: "Canaryname" };
const BASE = "http://lumi.test";

function setup(fac: FakeFacilitator = happyFacilitator(), opts: { dataDown?: boolean } = {}) {
  const logs: any[] = [];
  const app = createApp(ENV, { fetch: makeFetch(fac, opts), log: (e) => logs.push(e), now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { app, get, fac, logs };
}

async function challenge(get: (p: string) => Promise<Response>, path: string) {
  const r = await get(path);
  expect(r.status).toBe(402);
  const header = decodeB64Json(r.headers.get("PAYMENT-REQUIRED"));
  const body = await r.json();
  expect(header).toEqual(body);
  return body.accepts[0];
}

describe("free endpoints", () => {
  it("serves a human quickstart at / for browsers and JSON otherwise", async () => {
    const { get } = setup();
    const r = await get("/", { Accept: "text/html,application/xhtml+xml" });
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toMatch(/<title>Lumi API: x402 seller checks before you pay, plus crypto market data \(pay on XRPL, Base or Stellar\)/);
    expect(html).toContain('<meta name="description"');
    expect(html).toContain("/v1/trust/vendors");
    expect(html).toContain("/v1/market");
    expect(html).toContain("lumi-trades-mcp");
    expect(html).toContain("x402Fetch");
    expect(html).not.toMatch(/win rate|track record/i);
    // brand restyle: dark theme, logo, site nav, agent quick-links, price table, JSON-LD, keywords; inline CSS only
    expect(html).toContain("--bg:#070a10");
    expect(html).toContain("https://lumitrades.io/assets/icon-512.png");
    for (const href of ["https://lumitrades.io/", "https://lumitrades.io/agents/", "https://lumitrades.io/trust/"]) expect(html).toContain(`href="${href}"`);
    for (const p of ["/skill.md", "/openapi.json", "/.well-known/x402", "/mcp", "/.well-known/agent-card.json"]) expect(html).toContain(`href="${BASE}${p}"`);
    expect(html).toContain('<meta name="keywords"');
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
    expect(ld["@type"]).toBe("WebAPI");
    expect(ld.offers.length).toBeGreaterThan(5);
    expect(html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1]).toContain("/v1/market");
    expect(html).not.toMatch(/<link[^>]+stylesheet|<script src=/);
    const j = await get("/", { Accept: "application/json" });
    expect(j.headers.get("content-type")).toMatch(/json/);
    expect(j.headers.get("vary")).toBe("Accept");
  });
  it("serves index, health, skill.md, discovery, openapi and coins", async () => {
    const { get } = setup();
    const index = await (await get("/")).json();
    expect(index.paid_endpoints.map((p: any) => [p.path, p.price_xrp])).toEqual([
      ["/v1/market", "0.01"], ["/v1/macro/yen", "0.0075"], ["/v1/sentiment", "0.0038"], ["/v1/events", "0.0038"],
      ["/v1/funding", "0.0023"], ["/v1/fear-greed", "0.0023"], ["/v1/events/next48h", "0.0023"],
      ["/v1/institutional", "0.077"], ["/v1/trust/check", "0.015"], ["/v1/trust/vendors/{id}/report", "0.015"],
      ["/v1/verdict", "0.0075"],
    ]);
    expect(index.guarantee).toMatch(/only pay when you get data/i);
    expect((await get("/health")).status).toBe(200);
    const skill = await (await get("/skill.md")).text();
    expect(skill).toContain("PAYMENT-SIGNATURE");
    expect(skill).toContain("x402Fetch");
    expect(skill).toContain("You only pay when you get data");
    expect(skill).toContain("/v1/market");
    const wk = await (await get("/.well-known/x402")).json();
    expect(wk).toMatchObject({ x402Version: 2, kind: "resource-server" });
    expect(wk.resources).toHaveLength(18); // 2026-10-25: per-coin readings, slate, scan and brief retired (410); Monitor and Monitor Plus no longer sold
    expect(wk.resources.filter((r: any) => r.plan).map((r: any) => r.url)).toEqual(["watch", "watch_plus", "watch_pro", "audit"].map((p) => `${BASE}/v1/monitor/subscribe/${p}`).concat([`${BASE}/v1/feed/subscribe/feed`, `${BASE}/v1/feed/subscribe/feed_pro`, `${BASE}/v1/feed/credits`]));
    expect(wk.resources.map((r: any) => r.url)).toContain(`${BASE}/v1/macro/yen`);
    const oa = await (await get("/openapi.json")).json();
    expect(oa.paths["/v1/macro/yen"].get["x-payment-info"].price).toEqual({ mode: "fixed", currency: "USD", amount: "0.010000" });
    expect(oa.paths["/v1/macro/yen"].get["x-payment-info"].protocols).toEqual([{ x402: {} }]);
    expect(oa.paths["/v1/macro/yen"].get["x-payment-info"].xrp_price).toEqual({ mode: "fixed", currency: "XRP", amount: "0.0075" });
    expect((await get("/v1/coins")).status).toBe(410); // retired 2026-10-25
  });

  it("per-coin paths are retired: 410 without a payment challenge, any coin", async () => {
    const { get, fac } = setup();
    const r = await get("/v1/signal/NOPE");
    expect(r.status).toBe(410);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(fac.calls).toHaveLength(0);
  });
});

describe("x402 paywall", () => {
  it("challenges unpaid requests with x402 v2 requirements", async () => {
    const { get } = setup();
    for (const [path, amount] of [["/v1/macro/yen", "7500"], ["/v1/sentiment", "3800"], ["/v1/market", "10000"], ["/v1/institutional", "77000"]]) {
      const req = await challenge(get, path);
      expect(req).toMatchObject({ scheme: "exact", network: "xrpl:1", asset: "XRP", amount, payTo: PAY_TO, maxTimeoutSeconds: 300 });
      expect(req.extra.sourceTag).toBe(5864);
      expect(req.extra.invoiceId).toMatch(/^lumi1\./);
    }
  });

  it("verifies, settles, serves data with a receipt, and refuses replay", async () => {
    const { get, fac, logs } = setup();
    const req = await challenge(get, "/v1/macro/yen");
    const header = paymentHeaderFor(req);
    const r = await get("/v1/macro/yen", { "PAYMENT-SIGNATURE": header });
    expect(r.status).toBe(200);
    expect(fac.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    expect(fac.calls[0].body.paymentRequirements).toEqual(req);
    const receipt = decodeB64Json(r.headers.get("PAYMENT-RESPONSE"));
    expect(receipt).toMatchObject({ success: true, transaction: "A".repeat(64), network: "xrpl:1" });
    const body = await r.json();
    expect(body).toMatchObject({ kind: "macro_yen", source: "lumitrades.io" });
    expect(body.usd_jpy.price).toBeGreaterThan(100);
    expect(body.disclaimer).toBeTruthy();
    expect(body.timestamp).toBeTruthy();
    expect(body.payment.explorer).toBe(`https://testnet.xrpl.org/transactions/${"A".repeat(64)}`);
    expect(logs[0]).toMatchObject({ event: "x402_settled", route: "yen", amountDrops: "7500" });

    const replay = await get("/v1/macro/yen", { "PAYMENT-SIGNATURE": header });
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe("invoice_already_used");
    expect(fac.calls).toHaveLength(2);
  });

  it("blocks replay across isolates via the Durable Object guard (facilitator would re-confirm the same tx)", async () => {
    const ns = fakeDurableObjectNamespace();
    const fac = happyFacilitator(); // like T54: settle of an already-settled blob returns success again
    const mk = () => createApp({ ...ENV, INVOICE_GUARD: ns }, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
    const isolateA = mk();
    const isolateB = mk();
    const r402 = await isolateA.fetch(new Request(BASE + "/v1/market"));
    const req = (await r402.json()).accepts[0];
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(req) };
    expect((await isolateA.fetch(new Request(BASE + "/v1/market", { headers: h }))).status).toBe(200);
    const replay = await isolateB.fetch(new Request(BASE + "/v1/market", { headers: h }));
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe("invoice_already_used");
  });

  it("rejects an invoice issued for another route or a tampered amount without calling the facilitator", async () => {
    const { get, fac } = setup();
    const req = await challenge(get, "/v1/sentiment");
    const r1 = await get("/v1/events", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) }); // same price, other route
    expect(r1.status).toBe(402);
    expect((await r1.json()).error).toBe("invoice_route_mismatch");
    const r2 = await get("/v1/sentiment", { "PAYMENT-SIGNATURE": paymentHeaderFor({ ...req, amount: "1" }) });
    expect(r2.status).toBe(402);
    expect((await r2.json()).error).toBe("payment_requirements_mismatch");
    const r3 = await get("/v1/macro/yen", { "PAYMENT-SIGNATURE": "%%%not-base64" });
    expect(r3.status).toBe(402);
    const b3 = await r3.json();
    expect(b3.error).toBe("invalid_payment_signature_header");
    expect(b3.accepts.length).toBeGreaterThan(0);
    const h3 = JSON.parse(Buffer.from(r3.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));
    expect(h3).toEqual(b3);
    for (const bad of [Buffer.from(JSON.stringify({ x402Version: 1, accepted: req })).toString("base64"), Buffer.from(JSON.stringify({ x402Version: 2, accepted: { ...req, extra: {} }, payload: {} })).toString("base64")]) {
      const r = await get("/v1/macro/yen", { "X-PAYMENT": bad });
      expect(r.status).toBe(402);
      expect(["invalid_x402_version", "missing_invoiceId"]).toContain((await r.json()).error);
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    }
    expect(fac.calls).toHaveLength(0);
  });

  it("re-quotes when the facilitator says the payment is invalid", async () => {
    const fac: FakeFacilitator = { ...happyFacilitator(), verify: () => jsonResponse(200, { isValid: false, invalidReason: "amount_mismatch" }) };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/market");
    const r = await get("/v1/market", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("verify_failed:amount_mismatch");
    expect(fac.calls.map((c) => c.path)).toEqual(["/verify"]);
  });

  it("returns a typed retryable 503 when verify is unavailable, and the same header works afterwards", async () => {
    let down = true;
    const base = happyFacilitator();
    const fac: FakeFacilitator = { ...base, verify: (b) => (down ? jsonResponse(502, { error: "bad gateway" }) : base.verify(b)) };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/market");
    const h = paymentHeaderFor(req);
    const r = await get("/v1/market", { "PAYMENT-SIGNATURE": h });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ retryable: true, phase: "verify", settlementAttempted: false });
    down = false;
    const ok = await get("/v1/market", { "PAYMENT-SIGNATURE": h });
    expect(ok.status).toBe(200);
  });

  it("reports settlement_status_unknown (409) when settle cannot be confirmed", async () => {
    const fac: FakeFacilitator = { ...happyFacilitator(), settle: () => { throw new Error("socket hang up"); } };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/sentiment");
    const r = await get("/v1/sentiment", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "settlement_status_unknown", settlementAttempted: true });
  });

  it("re-quotes when settlement fails on ledger", async () => {
    const fac: FakeFacilitator = { ...happyFacilitator(), settle: () => jsonResponse(200, { success: false, errorReason: "tecUNFUNDED_PAYMENT", transaction: "", network: "xrpl:1" }) };
    const { get } = setup(fac);
    const req = await challenge(get, "/v1/events");
    const r = await get("/v1/events", { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("settle_failed:tecUNFUNDED_PAYMENT");
  });

  it("never asks for money when upstream data is unavailable", async () => {
    const { get, fac } = setup(happyFacilitator(), { dataDown: true });
    const r = await get("/v1/market");
    expect(r.status).toBe(503);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(fac.calls).toHaveLength(0);
  });
});

describe("paid payloads", () => {
  async function paid(path: string) {
    const { get } = setup();
    const req = await challenge(get, path);
    const r = await get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
    expect(r.status).toBe(200);
    return r.json();
  }

  it("market: BTC backdrop, macro with yen note, breadth", async () => {
    const b = await paid("/v1/market");
    expect(b.btc_backdrop.coin.symbol).toBe("BTC");
    expect(b.btc_backdrop).not.toHaveProperty("projection");
    expect(b.macro.yen_note).toMatch(/yen|USD\/JPY/i);
    expect(b.breadth.coins_tracked).toBe(12); // fixture site coins minus SOL
  });
});

describe("openapi scanner hints", () => {
  it("has contact email, security: [] on free endpoints and path-param examples", async () => {
    const { get } = setup();
    const oa = await (await get("/openapi.json")).json();
    expect(oa.info.contact.email).toBe("hello@lumitrades.io");
    expect(oa.paths["/v1/coins"]).toBeUndefined();
    expect(oa.paths["/v1/trust/vendors"].get.security).toEqual([]);
    // Not products: documented without `security: []` so x402scan does not list them as free resources.
    for (const [p, m] of [["/health", "get"], ["/v1/reports", "post"], ["/v1/tips", "post"], ["/v1/trust/replies", "post"], ["/v1/trust/vendors/{id}", "get"]]) {
      expect(oa.paths[p][m], p).toBeDefined();
      expect(oa.paths[p][m].security, p).toBeUndefined();
    }
    for (const p of ["/v1/samples", "/v1/trust/catalog", "/v1/trust/methodology"]) expect(oa.paths[p].get.security).toEqual([]);
    expect(oa.paths["/v1/trust/observations"]).toBeUndefined();
    const wk = await (await get("/.well-known/x402")).json();
    const paid = Object.entries(oa.paths).flatMap(([p, ops]: any) => Object.values(ops).filter((o: any) => o["x-payment-info"]).map(() => BASE + p));
    expect(paid.sort()).toEqual(wk.resources.map((r: any) => r.template).sort());
    expect(oa.info.version).toBe((await (await get("/health")).json()).version);
    expect(oa.components.securitySchemes.bearer.scheme).toBe("bearer");
    expect(oa.paths["/v1/trust/vendors/{id}/report"].get.parameters[0].example).toBe("printmoneylab");
  });

  it("quotes an unpaid literally probed paid template (402, same rails/prices/payTo), refuses a paid one with 400 and no facilitator call", async () => {
    const { get, fac } = setup();
    const strip = (a: any[]) => a.map((x) => ({ network: x.network, asset: x.asset, amount: x.amount, payTo: x.payTo, scheme: x.scheme }));
    for (const [p, ex, concrete] of [["/v1/trust/vendors/%7Bid%7D/report", "/v1/trust/vendors/printmoneylab/report", "/v1/trust/vendors/printmoneylab/report"]]) {
      const q = await get(p);
      expect(q.status, p).toBe(402);
      const body = await q.json();
      expect(decodeB64Json(q.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
      expect(body.resource.url).toBe(BASE + new URL(BASE + p).pathname);
      expect(body.note).toContain(BASE + ex);
      const c = await get(concrete);
      const cb = await c.json();
      if (c.status === 402) expect(strip(body.accepts)).toEqual(strip(cb.accepts));
      expect(body.accepts.length).toBeGreaterThan(0);

      // Junk header and a well-formed payload built from the template quote: both refused, nothing verified or settled.
      const forged = Buffer.from(JSON.stringify({ x402Version: 2, accepted: body.accepts[0], payload: { signedTxBlob: "00" } })).toString("base64");
      for (const h of [{ "PAYMENT-SIGNATURE": "junk" }, { "X-PAYMENT": forged }] as Record<string, string>[]) {
        const r = await get(p, h);
        expect(r.status, p).toBe(400);
        expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
        const b = await r.json();
        expect(b).toMatchObject({ error: "path_template_not_filled", note: "Not charged." });
        expect(b.example).toBe(BASE + ex);
      }
    }
    expect(fac.calls).toHaveLength(0);
  });

  it("other placeholder styles and a /v1/trust/check without url are a 400 (no quote, never charged); the bare probe keeps its 402", async () => {
    const { get, fac } = setup();
    for (const p of ["/v1/signal/{coin}", "/v1/levels/%7Bcoin%7D", "/v1/signal/:coin", "/v1/levels/:COIN", "/v1/signal/%3Ccoin%3E", "/v1/signal/%7B%7Bcoin%7D%7D", "/v1/signal/$%7Bcoin%7D", "/v1/lite/{coin}"]) {
      for (const h of [{}, { "PAYMENT-SIGNATURE": "junk" }] as Record<string, string>[]) {
        const r = await get(p, h);
        expect(r.status, p).toBe(410); // retired per-coin templates: never quoted, never charged
        expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      }
    }
    for (const [p, ex] of [["/v1/trust/vendors/:id/report", "/v1/trust/vendors/printmoneylab/report"]]) {
      const r = await get(p);
      expect(r.status, p).toBe(400);
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      const b = await r.json();
      expect(b).toMatchObject({ error: "path_template_not_filled", note: "Not charged." });
      expect(b.example).toBe(BASE + ex);
    }
    for (const p of ["/v1/trust/check?domain=a.example", "/v1/trust/check?url="]) {
      const r = await get(p);
      expect(r.status, p).toBe(400);
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect(JSON.stringify(await r.json())).not.toContain("?domain=");
    }
    expect((await get("/v1/trust/check")).status).toBe(402);
    expect(fac.calls).toHaveLength(0);
  });

  it("keeps the free /v1/trust/vendors/{id} template a 400 (no quote)", async () => {
    const { get } = setup();
    for (const p of ["/v1/trust/vendors/%7Bid%7D", "/v1/trust/vendors/:id", "/v1/trust/vendors/%3Cvendor_id%3E"]) {
      const r = await get(p);
      expect(r.status).toBe(400);
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      const b = await r.json();
      expect(b.error).toBe("path_template_not_filled");
      expect(b.example).toBe(BASE + "/v1/trust/vendors/printmoneylab");
    }
  });
});
