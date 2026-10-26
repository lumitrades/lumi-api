import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { BAZAAR_ROUTES, resourceDescription } from "../src/bazaar";
import { PAID_ENDPOINTS } from "../src/catalog";
import { PLANS, planQuote, type PlanId } from "../src/commerce/plans";
import { VENDORS } from "../src/vendors";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { seededStores } from "./stage_c_fixtures";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, decodeB64Json } from "./helpers";

/** A "$" followed by a digit, e.g. "$0.003" or "$ 9": a price embedded in listing text. */
const PRICE = /\$\s?\d/;
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532" };
const BASE = "http://lumi.test";
const app = () => createApp(ENV, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, ...seededStores(NOW), trustStore: new MemoryTrustStore(SEED_OBSERVATIONS) });

describe("paid-route discovery descriptions carry no embedded price", () => {
  it("resource.description is the v2 listing text for every paid route, with no price", () => {
    for (const route of Object.keys(BAZAAR_ROUTES) as (keyof typeof BAZAAR_ROUTES)[]) {
      for (const usd of [undefined, "0.003", "0.02", "0.25"]) {
        const d = resourceDescription(route, "Lumi API x: y", { usd, subject: "XRP" });
        expect(d, route).toBe(BAZAAR_ROUTES[route].description);
        expect(d, route).not.toMatch(PRICE);
        expect(d.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("every live 402 (body and PAYMENT-REQUIRED header) uses the v2 text without a price", async () => {
    const a = app();
    for (const e of PAID_ENDPOINTS) {
      const path = e.route === "trust_check" ? `${e.example}?url=${encodeURIComponent("https://api.example.com/v1/data")}` : e.route === "vendor_report" ? "/v1/trust/vendors/heurist-mesh/report" : e.route === "receipts" ? e.path : e.example;
      const r = await a.fetch(new Request(BASE + path));
      expect(r.status, path).toBe(402);
      const body = await r.json();
      const hdr = decodeB64Json(r.headers.get("PAYMENT-REQUIRED"));
      for (const q of [body, hdr]) {
        expect(q.resource.description, path).toBe(BAZAAR_ROUTES[e.route].description);
        expect(q.resource.description, path).not.toMatch(PRICE);
        for (const acc of q.accepts) if (acc.description) expect(acc.description, path).not.toMatch(PRICE);
      }
    }
  });

  it("openapi summary/description of every x-payment-info operation has no price, and data routes use the v2 text", async () => {
    const oa = await (await app().fetch(new Request(BASE + "/openapi.json"))).json();
    let n = 0;
    for (const [p, methods] of Object.entries<any>(oa.paths)) {
      for (const op of Object.values<any>(methods)) {
        if (!op["x-payment-info"]) continue;
        n++;
        expect(op.summary ?? "", p).not.toMatch(PRICE);
        expect(op.description ?? "", p).not.toMatch(PRICE);
        const e = PAID_ENDPOINTS.find((x) => x.template === p);
        if (e) expect(op.description, p).toBe(BAZAAR_ROUTES[e.route].description);
      }
    }
    expect(n).toBeGreaterThanOrEqual(PAID_ENDPOINTS.length);
  });

  it("/.well-known/x402 resource descriptions have no price", async () => {
    const wk = await (await app().fetch(new Request(BASE + "/.well-known/x402"))).json();
    const list: any[] = wk.resources ?? [];
    expect(list.length).toBeGreaterThan(0);
    for (const r of list) expect(r.description ?? "", r.url).not.toMatch(PRICE);
  });

  it("plan 402 descriptions (list and test price) have no price", () => {
    const cfg = { xrpUsdFallback: 2, ious: [], network: "xrpl:1", payTo: PAY_TO } as any;
    for (const id of Object.keys(PLANS) as PlanId[]) {
      for (const test of [false, true]) {
        const q: any = planQuote(cfg, id, "sub", test ? "0.01" : PLANS[id].usd, `${BASE}${PLANS[id].path}`, test);
        expect(q.description, id).not.toMatch(PRICE);
        if (test && !PLANS[id].pack) expect(q.description).toMatch(/TEST price/); // packs: one exact price for everyone
      }
    }
  });
});

describe("vendors.ts listing fixes (2026-10-23 test-buys)", () => {
  it("emerge-digital uses base_url (the seller rejects url=) and bitbooth echo is POST with a JSON body", () => {
    const em = VENDORS.find((v) => v.id === "emerge-digital")!.endpoints[0];
    expect(em.url).toContain("/api/xrpl/utm-build?base_url=");
    expect(em.url).not.toMatch(/[?&]url=/);
    const bb = VENDORS.find((v) => v.id === "bitbooth")!.endpoints[0];
    expect(bb).toMatchObject({ url: "https://app.heinrichstech.com/v1/cdp/echo", method: "POST", body: { message: "hello bitbooth" }, listed_price: "0.001", listed_asset: "RLUSD" });
    expect(VENDORS.find((v) => v.id === "bitbooth")!.pay_to.xrpl).toEqual(["rfryheo6yzFdLWj8qUQtZc7zG9MKkBkUEy"]);
    expect(VENDORS.find((v) => v.id === "emerge-digital")!.pay_to.xrpl).toEqual(["rERHPAkbSH8bEHYJWKDERJJ9meDab8Zb1N"]);
  });
});

describe("dated XRPL Bazaar sweep wording", () => {
  it("states the exact dated counts and never claims every XRPL site", async () => {
    const { XRPL_BAZAAR_SWEEP, chainSplit, coverageLine } = await import("../src/trust/catalog_service");
    const S = "93 of 98 XRPL Bazaar hosts bought, 82 delivered, 2 not delivered, 9 inconclusive (Lumi-side, no response recorded), checked 98 of 98, as of Oct 23 2026";
    expect(XRPL_BAZAAR_SWEEP.delivered + XRPL_BAZAAR_SWEEP.not_delivered + XRPL_BAZAAR_SWEEP.inconclusive).toBe(XRPL_BAZAAR_SWEEP.hosts_bought);
    expect(XRPL_BAZAAR_SWEEP.statement).toBe(S);
    const split = chainSplit(null, null);
    expect(split.xrpl.bazaar_sweep.statement).toBe(S);
    expect(split.note).toContain(S);
    const line = coverageLine({ catalogued: 10, domains: 2, quote_verified: 1, purchase_verified: 1 }, null);
    expect(line).toContain(S);
    const all = JSON.stringify(split) + line;
    expect(all).not.toMatch(/every XRPL (site|host|seller)/i);
    expect(all).not.toMatch(/\bscam\w*|fraud\w*/i);
  });
});
