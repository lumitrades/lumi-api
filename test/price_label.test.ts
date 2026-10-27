/**
 * "Priced well above market average": the not-scored reason for listings Lumi's routine test-buys skip for price.
 * Only when the cheapest price is above the $0.05 test-buy limit AND at least PRICE_LABEL_MULTIPLE x the catalog
 * median; everything else untested is the neutral not_yet_test_bought. Never a score, label, tier or badge input.
 */
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryCatalogStore, toListing } from "../src/trust/catalog";
import { createCatalog } from "../src/trust/catalog_service";
import { thresholdsDoc, VERDICT_DEFAULTS } from "../src/trust/verdict";
import {
  histogramFromRows, histogramMedian, listingFamilyPrices, marketFromHistogram, notScoredReason, optionUsd, priceVsMarket,
  NOT_SCORED_CODES, PRICE_LABEL_MULTIPLE, PRICE_MARKET_META, TEST_BUY_MAX_USD, type PriceMarket,
} from "../src/trust/price_market";
import { DATA, FACILITATOR, NOW, PAY_TO, happyFacilitator, makeFetch } from "./helpers";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RLUSD = "524C555344000000000000000000000000000000";
const SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const BASE = "https://api.lumitrades.io";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, VERDICT_PRICING: "free" };
const payTo = (i: number) => "0x" + (0xbee0000 + i).toString(16).padStart(40, "0");
const acc = (usd: number, i = 0) => JSON.stringify([{ n: "eip155:8453", a: USDC, m: String(Math.round(usd * 1e6)), p: payTo(i) }]);
const market = (base: number, overall = base, baseN = 1000): PriceMarket => ({
  computed_at: NOW, overall: { median_usd: overall, listings: 2000 }, families: { base_usdc: { median_usd: base, listings: baseN }, xrpl_rlusd: { median_usd: 0.02, listings: 500 } }, min_family_listings: 30,
});

describe("price_market: families, medians and the label rule", () => {
  it("prices USD-pegged options per family and ignores XRP and other assets", () => {
    expect(optionUsd({ n: "eip155:8453", a: USDC.toLowerCase(), m: "250000" })).toEqual({ fam: "base_usdc", usd: 0.25 });
    expect(optionUsd({ n: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", a: SOL_USDC, m: "10000" })).toEqual({ fam: "solana_usdc", usd: 0.01 });
    expect(optionUsd({ n: "stellar:pubnet", a: SAC, m: "100000" })).toEqual({ fam: "stellar_usdc", usd: 0.01 });
    expect(optionUsd({ n: "xrpl:0", a: RLUSD, m: "0.03" })).toEqual({ fam: "xrpl_rlusd", usd: 0.03 });
    expect(optionUsd({ n: "xrpl:0", a: "XRP", m: "10000" })).toBeNull();
    expect(optionUsd({ n: "eip155:8453", a: "0xdeadbeef", m: "10000" })).toBeNull();
    expect(optionUsd({ n: "eip155:8453", a: USDC, m: "0" })).toBeNull();
    const fp = listingFamilyPrices(JSON.stringify([{ n: "eip155:8453", a: USDC, m: "300000" }, { n: "eip155:8453", a: USDC, m: "200000" }, { n: "xrpl:0", a: RLUSD, m: "0.5" }]));
    expect(fp).toEqual({ base_usdc: 0.2, xrpl_rlusd: 0.5 });
    expect(listingFamilyPrices("not json")).toEqual({});
  });

  it("medians come from a histogram (even totals average the middle pair) and 'overall' uses each listing's cheapest price", () => {
    expect(histogramMedian([{ usd: 0.01, n: 3 }, { usd: 1, n: 2 }])).toEqual({ median_usd: 0.01, listings: 5 });
    expect(histogramMedian([{ usd: 0.01, n: 1 }, { usd: 0.03, n: 1 }])).toEqual({ median_usd: 0.02, listings: 2 });
    expect(histogramMedian([])).toBeNull();
    const rows = [
      { id: 1, accepts: acc(0.01) }, { id: 2, accepts: acc(0.01) }, { id: 3, accepts: acc(5) },
      { id: 4, accepts: JSON.stringify([{ n: "eip155:8453", a: USDC, m: "900000" }, { n: "xrpl:0", a: RLUSD, m: "0.02" }]) },
      { id: 5, accepts: JSON.stringify([{ n: "xrpl:0", a: "XRP", m: "100" }]) },
    ];
    const m = marketFromHistogram(histogramFromRows(rows), NOW);
    expect(m.families.base_usdc).toEqual({ median_usd: 0.455, listings: 4 }); // 0.01, 0.01, 0.9, 5
    expect(m.families.xrpl_rlusd).toEqual({ median_usd: 0.02, listings: 1 });
    expect(m.overall).toEqual({ median_usd: 0.015, listings: 4 }); // 0.01, 0.01, 0.02 (id 4 cheapest), 5
  });

  it("labels only above the $0.05 test-buy limit and at the multiple or more", () => {
    expect(TEST_BUY_MAX_USD).toBe(0.05);
    expect(PRICE_LABEL_MULTIPLE).toBe(10);
    const m = market(0.005);
    // exactly $0.05 is still test-bought (the runner skips only price > 0.05), so never labelled even at 10x
    expect(priceVsMarket(acc(0.05), m)!.priced_well_above_market).toBe(false);
    expect(priceVsMarket(acc(0.05), m)!.multiple_of_median).toBe(10);
    const m1 = market(0.01);
    expect(priceVsMarket(acc(0.06), m1)!.priced_well_above_market).toBe(false); // above the limit, only 6x: neutral
    expect(priceVsMarket(acc(0.0999), m1)!.priced_well_above_market).toBe(false);
    const p = priceVsMarket(acc(0.25), m1)!;
    expect(p).toEqual({ cheapest_price_usd: 0.25, asset_family: "base_usdc", market_median_usd: 0.01, median_basis: "base_usdc", multiple_of_median: 25, priced_well_above_market: true });
    expect(priceVsMarket(acc(0.1), m1)!.priced_well_above_market).toBe(true);
    expect(priceVsMarket(acc(0.06), m1, 5)!.priced_well_above_market).toBe(true); // the multiple is a parameter
    expect(priceVsMarket(acc(0.25), null)).toBeNull();
    expect(priceVsMarket(JSON.stringify([{ n: "xrpl:0", a: "XRP", m: "1" }]), m1)).toBeNull();
  });

  it("compares with the highest median of the accepted families and falls back to overall for a small family", () => {
    const both = JSON.stringify([{ n: "eip155:8453", a: USDC, m: "150000" }, { n: "xrpl:0", a: RLUSD, m: "0.15" }]);
    const p = priceVsMarket(both, market(0.01))!; // xrpl median 0.02 is higher: 7.5x, below 10x
    expect(p.market_median_usd).toBe(0.02);
    expect(p.median_basis).toBe("xrpl_rlusd");
    expect(p.priced_well_above_market).toBe(false);
    const small = priceVsMarket(acc(0.25), market(0.001, 0.05, 10))!; // base family has 10 listings (< 30): overall 0.05
    expect(small.median_basis).toBe("overall");
    expect(small.multiple_of_median).toBe(5);
    expect(small.priced_well_above_market).toBe(false);
  });

  it("notScoredReason: exact listing, whole host, and test-bought listings", () => {
    const hi = { price_vs_market: priceVsMarket(acc(0.25), market(0.01)) };
    const mid = { price_vs_market: priceVsMarket(acc(0.06), market(0.01)) };
    const r = notScoredReason({ exact: hi });
    expect(r.not_scored_reason).toBe(NOT_SCORED_CODES.priced);
    expect(r.not_scored_note).toBe("Priced well above market average: the cheapest price for this listing is $0.25 per call, 25x the $0.01 median for Base USDC listings in Lumi's catalog. Lumi has not test-bought it yet. Not a finding about the seller, and never a score input.");
    expect(notScoredReason({ exact: mid }).not_scored_reason).toBe(NOT_SCORED_CODES.untested);
    expect(notScoredReason({}).not_scored_reason).toBe(NOT_SCORED_CODES.untested);
    // a host: every listing must qualify and the list must be complete
    expect(notScoredReason({ domainEntries: [hi, hi], complete: true }).not_scored_reason).toBe(NOT_SCORED_CODES.priced);
    expect(notScoredReason({ domainEntries: [hi, hi], complete: true }).not_scored_note).toMatch(/lowest price among this host's listings is \$0\.25/);
    expect(notScoredReason({ domainEntries: [hi, mid], complete: true }).not_scored_reason).toBe(NOT_SCORED_CODES.untested);
    expect(notScoredReason({ domainEntries: [hi, hi], complete: false }).not_scored_reason).toBe(NOT_SCORED_CODES.untested);
    // test-bought (a manual buy above the limit) is never "not test-bought"
    expect(notScoredReason({ exact: { ...hi, purchases: [{ conclusive: true }] } }).not_scored_reason).toBe(NOT_SCORED_CODES.curatedOnly);
    expect(notScoredReason({ exact: { ...hi, test_buys: { count: 1 } } }).not_scored_reason).toBe(NOT_SCORED_CODES.curatedOnly);
    expect(notScoredReason({ exact: hi, conclusiveBuys: 2 }).not_scored_reason).toBe(NOT_SCORED_CODES.curatedOnly);
  });

  it("notes never use accusatory words", () => {
    const notes = [notScoredReason({ exact: { price_vs_market: priceVsMarket(acc(1000), market(0.01)) } }).not_scored_note, notScoredReason({}).not_scored_note, thresholdsDoc(VERDICT_DEFAULTS).not_scored];
    for (const n of notes) expect(n).not.toMatch(/scam|fraud|overpric|gouge|rip.?off|suspicious|avoid|warning/i);
  });
});

// ---------------- end to end through the app

const PRICEY = "https://api.pricey.example/v1/q";
const MID = "https://api.midprice.example/v1/q";
const EDGE = "https://api.atlimit.example/v1/q";
const item = (resource: string, usd: number, i: number) => ({
  resource, type: "http", description: "d", accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: String(Math.round(usd * 1e6)), payTo: payTo(i) }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 0, l30DaysUniquePayers: 0, lastCalledAt: new Date(NOW - 3_600_000).toISOString() }, lastUpdated: new Date(NOW).toISOString(),
});

async function setup(withMarket = true) {
  const catalogStore = new MemoryCatalogStore();
  const items = [
    ...Array.from({ length: 40 }, (_, i) => item(`https://api.cheap${i}.example/v1/q`, 0.01, i + 10)),
    item(PRICEY, 0.25, 1), item("https://api.pricey.example/v1/other", 0.5, 1), item(MID, 0.06, 2), item(EDGE, 0.05, 3),
  ];
  await catalogStore.upsert(items.map(toListing).filter((x): x is NonNullable<typeof x> => !!x), NOW);
  if (withMarket) await catalogStore.setMeta(PRICE_MARKET_META, JSON.stringify(marketFromHistogram(await catalogStore.priceHistogram(NOW), NOW)));
  const app = createApp(ENV as any, { catalogStore, now: () => NOW, fetch: makeFetch(happyFacilitator()), log: () => {} } as any);
  const get = async (p: string) => (await app.fetch(new Request(BASE + p))).json() as Promise<any>;
  const text = async (p: string) => (await app.fetch(new Request(BASE + p))).text();
  return { catalogStore, get, text };
}
const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (["not_scored_reason", "not_scored_note", "price_vs_market", "receipt", "check_receipt", "signature", "generated_at"].includes(k) ? undefined : v)));

describe("not_scored_reason in /v1/check, /v1/verdict and lookups", () => {
  it("a listing priced 25x the median is labelled; $0.06 and exactly $0.05 are neutral", async () => {
    const s = await setup();
    const c = await s.get(`/v1/check?url=${encodeURIComponent(PRICEY)}`);
    expect(c.score).toMatchObject({ scored: false, status: "not_scored", value: null, not_scored_reason: "priced_well_above_market" });
    expect(c.score.not_scored_note).toMatch(/^Priced well above market average: the cheapest price for this listing is \$0\.25 per call, 25x the \$0\.01 median/);
    for (const u of [MID, EDGE]) {
      const n = await s.get(`/v1/check?url=${encodeURIComponent(u)}`);
      expect(n.score).toMatchObject({ status: "not_scored", value: null, not_scored_reason: "not_yet_test_bought" });
    }
    const v = await s.get(`/v1/verdict?url=${encodeURIComponent(PRICEY)}`);
    expect(v.score).toBeNull();
    expect(v.score_status).toBe("not_scored");
    expect(v.not_scored_reason).toBe("priced_well_above_market");
    expect(v.not_scored_note).toBe(c.score.not_scored_note);
    // the bare host: both of its listings qualify, so the host does too
    const h = await s.get(`/v1/verdict?url=${encodeURIComponent("https://api.pricey.example")}`);
    expect(h.not_scored_reason).toBe("priced_well_above_market");
    expect(h.not_scored_note).toMatch(/lowest price among this host's listings is \$0\.25/);
    const l = await s.get(`/v1/trust/vendors?url=${encodeURIComponent(PRICEY)}`);
    expect(l.catalog.entries[0].price_vs_market).toMatchObject({ cheapest_price_usd: 0.25, market_median_usd: 0.01, multiple_of_median: 25, priced_well_above_market: true });
  });

  it("without a cached market reference everything untested is neutral (no request-time computation)", async () => {
    const s = await setup(false);
    const c = await s.get(`/v1/check?url=${encodeURIComponent(PRICEY)}`);
    expect(c.score.not_scored_reason).toBe("not_yet_test_bought");
    expect(s.catalogStore.meta.has(PRICE_MARKET_META)).toBe(false);
  });

  it("the label never changes the decision, label, tier, score or badge", async () => {
    const a = await setup(true);
    const b = await setup(false);
    for (const p of [`/v1/check?url=${encodeURIComponent(PRICEY)}`, `/v1/verdict?url=${encodeURIComponent(PRICEY)}`]) {
      const x = await a.get(p);
      const y = await b.get(p);
      expect(strip(x)).toEqual(strip(y));
    }
    const x = await a.get(`/v1/check?url=${encodeURIComponent(PRICEY)}`);
    expect(x.score.value).toBeNull();
    expect(await a.text("/v1/badge/api.pricey.example.svg")).toBe(await b.text("/v1/badge/api.pricey.example.svg"));
    expect(x.score.confidence).toBeNull();
  });
});

describe("market reference refresh", () => {
  it("is cached in meta and recomputed at most every 12 h", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert([item(PRICEY, 0.25, 1), item(MID, 0.01, 2), item(EDGE, 0.01, 3)].map(toListing).filter((x): x is NonNullable<typeof x> => !!x), NOW);
    let t = NOW;
    const cat = createCatalog({ store, now: () => t, fetch: (async () => new Response("{}")) as any, log: () => {}, xrplRpc: [], baseRpc: "", buyers: { xrpl: [], evm: [] }, self: { name: "Lumi", domains: [], pay_to: [], url: BASE }, isOwner: async () => false });
    const m1 = (await cat.refreshPriceMarket())!;
    expect(m1.overall).toEqual({ median_usd: 0.01, listings: 3 });
    expect(JSON.parse((await store.getMeta(PRICE_MARKET_META))!).computed_at).toBe(NOW);
    await store.upsert([item("https://api.more.example/v1/q", 0.9, 4), item("https://api.more2.example/v1/q", 0.9, 5)].map(toListing).filter((x): x is NonNullable<typeof x> => !!x), t);
    t += 3600_000;
    expect((await cat.refreshPriceMarket())!.computed_at).toBe(NOW); // still fresh
    t += 12 * 3600_000;
    const m2 = (await cat.refreshPriceMarket())!;
    expect(m2.computed_at).toBe(t);
    expect(m2.overall).toEqual({ median_usd: 0.25, listings: 5 });
  });
});
