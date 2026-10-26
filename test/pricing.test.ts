import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { createXrpPricer, usdToDrops, median } from "../src/pricing";
import { MemorySalesStore } from "../src/sales";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, jsonResponse, makeFetch, paymentHeaderFor, decodeB64Json } from "./helpers";

const BASE = "http://lumi.test";

function rateFetch(rates: { coinbase?: number; kraken?: number; bitstamp?: number; coingecko?: number }, fallthrough: typeof fetch) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.coinbase.com")) return rates.coinbase ? jsonResponse(200, { data: { amount: String(rates.coinbase) } }) : new Response("x", { status: 500 });
    if (url.includes("api.kraken.com")) return rates.kraken ? jsonResponse(200, { result: { XXRPZUSD: { c: [String(rates.kraken), "1"] } } }) : new Response("x", { status: 500 });
    if (url.includes("bitstamp.net")) return rates.bitstamp ? jsonResponse(200, { last: String(rates.bitstamp) }) : new Response("x", { status: 500 });
    if (url.includes("coingecko.com")) return rates.coingecko ? jsonResponse(200, { ripple: { usd: rates.coingecko } }) : new Response("x", { status: 500 });
    return fallthrough(input, init);
  }) as typeof fetch;
}

describe("live XRP pricing", () => {
  it("rounds XRP up to 0.0001 so XRP is never worth less than the USD price", () => {
    expect(usdToDrops("0.03", 2)).toBe("15000");
    expect(usdToDrops("0.01", 1.31)).toBe("7700"); // 0.007633.. -> 0.0077
    expect(usdToDrops("0.25", 1.31)).toBe("190900");
    expect(Number(usdToDrops("0.01", 1.31)) / 1e6 * 1.31).toBeGreaterThanOrEqual(0.01);
    expect(median([3, 1, 2])).toBe(2);
  });

  it("takes the median of sources, drops outliers, falls back to last-known then static", async () => {
    let t = NOW;
    const memo = new Map<string, string>();
    const store = { get: async () => memo.get("r") ?? null, set: async (v: string) => void memo.set("r", v) };
    let rates: any = { coinbase: 1.3, kraken: 1.32, bitstamp: 1.31, coingecko: 9 };
    const p = createXrpPricer({ fetch: ((i: any, n: any) => rateFetch(rates, async () => new Response("", { status: 404 }))(i, n)) as any, fallback: 1.5, memo: store, now: () => t });
    const r1 = await p.rate();
    expect(r1.usd).toBe(1.31);
    expect(r1.source).not.toContain("coingecko");
    rates = {};
    t += 6 * 60_000; // past the 5 min TTL: stale value served, refresh fails over to last-known
    expect((await p.rate()).usd).toBe(1.31);
    t += 40 * 60_000;
    const r3 = await p.rate();
    expect(r3.usd).toBe(1.31);
    expect(r3.source).toMatch(/last-known/);
    const p2 = createXrpPricer({ fetch: (async () => new Response("", { status: 500 })) as any, fallback: 1.5, now: () => t });
    expect((await p2.rate()).usd).toBe(1.5);
  });

  it("quotes XRP from the live rate, binds the amount into the invoice and values the sale at the XRP received", async () => {
    const fac = happyFacilitator();
    const salesStore = new MemorySalesStore();
    const app = createApp(
      { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", XRP_PRICING: "live" } as any,
      { fetch: rateFetch({ coinbase: 2, kraken: 2, bitstamp: 2 }, makeFetch(fac)), log: () => {}, now: () => NOW, salesStore },
    );
    const r = await app.fetch(new Request(BASE + "/v1/institutional"));
    expect(r.status).toBe(402);
    const q = await r.json();
    expect(q.accepts[0]).toMatchObject({ asset: "XRP", amount: "50000" }); // $0.10 / $2
    expect(q.accepts[1].amount).toBe("0.1");
    expect(q.samples).toBe(BASE + "/v1/samples");
    const inv = q.accepts[0].extra.invoiceId as string;
    expect(inv.split(".")).toHaveLength(6);
    expect(inv.split(".")[4]).toBe("50000");

    // The rate moves before the paid retry: the issued invoice still settles at its own amount.
    app.pricer.set({ usd: 3, source: "test", at: NOW });
    const paid = await app.fetch(new Request(BASE + "/v1/institutional", { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) } }));
    expect(paid.status).toBe(200);
    expect(decodeB64Json(paid.headers.get("PAYMENT-RESPONSE"))).toBeTruthy();
    expect(salesStore.rows[0]).toMatchObject({ asset: "XRP", amount: "0.05" });
    expect(salesStore.rows[0].usd).toBeCloseTo(0.15, 6); // 0.05 XRP valued at the rate when it was received ($3)

    // A tampered amount fails the MAC.
    const q2 = await (await app.fetch(new Request(BASE + "/v1/institutional"))).json();
    expect(q2.accepts[0].amount).toBe("33400"); // $0.10 / $3, rounded up to 100 drops
    const parts = q2.accepts[0].extra.invoiceId.split(".");
    parts[4] = "100";
    const forged = { ...q2.accepts[0], amount: "100", extra: { ...q2.accepts[0].extra, invoiceId: parts.join(".") } };
    const bad = await app.fetch(new Request(BASE + "/v1/institutional", { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(forged) } }));
    expect(bad.status).toBe(402);
    expect(JSON.stringify(await bad.json())).toMatch(/invalid_invoice/);
  });
});
