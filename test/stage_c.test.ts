import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryLiveStore, LIVE_UNIVERSE, fetchCandles } from "../src/live";
import { MemoryFeedStore, dueFeed, FEEDS, band } from "../src/feeds";
import { trustVerdict, events48View, fundingView, scanView, fearGreedFromContext } from "../src/quick";
import { seededStores, liveRows } from "./stage_c_fixtures";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor, fixture } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";

function setup(opts: { liveStore?: MemoryLiveStore; feedStore?: MemoryFeedStore; fetch?: typeof fetch; override?: Record<string, unknown> } = {}) {
  let t = NOW;
  const seeded = seededStores(NOW);
  const liveStore = opts.liveStore ?? seeded.liveStore;
  const feedStore = opts.feedStore ?? seeded.feedStore;
  const logs: any[] = [];
  const app = createApp(ENV, { fetch: opts.fetch ?? makeFetch(happyFacilitator(), { override: opts.override }), log: (e: any) => logs.push(e), now: () => t, liveStore, feedStore });
  const get = (p: string, h: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: h }));
  const buy = async (p: string) => {
    const q = await get(p);
    expect(q.status).toBe(402);
    const j: any = await q.json();
    return get(p, { "PAYMENT-SIGNATURE": paymentHeaderFor(j.accepts[0]) });
  };
  return { app, get, buy, liveStore, feedStore, logs, setNow: (x: number) => (t = x) };
}

describe("Stage C: /v1/scan", () => {
  it("quotes $0.02 and delivers all coins sorted by score with breadth", async () => {
    const { get, buy } = setup();
    const q: any = await (await get("/v1/scan")).json();
    expect(q.accepts.length).toBeGreaterThan(0);
    const r = await buy("/v1/scan");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.kind).toBe("scan");
    expect(j.count).toBe(49);
    const scores = j.coins.map((c: any) => c.score);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
    expect(j.breadth.positive + j.breadth.neutral + j.breadth.negative).toBe(49);
    expect(j.coins.map((c: any) => c.symbol)).not.toContain("SOL");
    expect(j.stale_after).toMatch(/Z$/);
    expect(j.coins[0].computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is not sold with fewer than 40 fresh coins (503, not charged)", async () => {
    const liveStore = new MemoryLiveStore();
    for (const r of liveRows(NOW, 30)) liveStore.rows.set(r.id, r);
    const { get } = setup({ liveStore });
    const r = await get("/v1/scan");
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).toMatch(/Not charged/);
  });

  it("scanView lists missing coins", () => {
    const v: any = scanView(liveRows(NOW, 45), LIVE_UNIVERSE as any);
    expect(v.count).toBe(45);
    expect(v.missing).toHaveLength(4);
  });
});

describe("Stage C: /v1/lite/{coin}", () => {
  it("returns the lite view for a live coin", async () => {
    const { buy } = setup();
    const r = await buy("/v1/lite/AVAX");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.kind).toBe("signal_lite");
    expect(j.coin.symbol).toBe("AVAX");
    expect(j.timeframes["1h"].indicators).toBeUndefined();
    expect(j.timeframes["1h"].label).toBeTruthy();
    expect(j.full_read).toMatch(/\/v1\/signal\/AVAX/);
  });

  it("template path quotes unpaid but refuses payment; an unknown coin 404s before any quote", async () => {
    const { get } = setup();
    const q = await get("/v1/lite/%7Bcoin%7D");
    expect(q.status).toBe(402);
    const j: any = await q.json();
    const paid = await get("/v1/lite/%7Bcoin%7D", { "PAYMENT-SIGNATURE": paymentHeaderFor(j.accepts[0]) });
    expect(paid.status).toBe(400);
    expect((await get("/v1/lite/NOPECOIN")).status).toBe(404);
  });
});

describe("Stage C: /v1/trust/check", () => {
  it("bare probe without url: standard 402 quote; a payment without url is refused 400 (not charged)", async () => {
    const { get, buy } = setup();
    const r = await get("/v1/trust/check");
    expect(r.status).toBe(402);
    const q: any = await r.json();
    expect(q.accepts.length).toBeGreaterThan(0);
    expect(q.extensions.bazaar).toBeTruthy();
    expect(q.extensions["sign-in-with-x"]).toBeUndefined();
    expect(q.note).toMatch(/\?url=/);
    const paid = await buy("/v1/trust/check");
    expect(paid.status).toBe(400);
    const j: any = await paid.json();
    expect(j.error).toBe("invalid_query");
    expect(j.note).toMatch(/Not charged/);
    expect((await get("/v1/trust/check?url=https://x.test/a&amount=abc")).status).toBe(400);
  });

  it("allows Lumi itself", async () => {
    const { buy } = setup();
    const r = await buy(`/v1/trust/check?url=${encodeURIComponent("https://api.lumitrades.io/v1/signal/BTC")}`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.kind).toBe("trust_check");
    expect(j.verdict).toBe("allow");
    expect(j.reasons[0].code).toBe("lumi_itself");
    expect(j.as_of).toMatch(/Z$/);
  });

  it("an unknown URL is no_data (legal review M2), not a warning", async () => {
    const { buy } = setup();
    const j: any = await (await buy(`/v1/trust/check?url=${encodeURIComponent("https://unknown-seller.test/v1/x")}`)).json();
    expect(j.verdict).toBe("unknown");
    expect(j.label).toBe("no_data");
    expect(j.reasons.map((r: any) => r.code)).toContain("not_observed");
  });

  const entry = (over: any = {}) => ({
    resource: "https://seller.test/v1/data", domain: "seller.test", tier: "quote-verified, low confidence", listed_price_usd: "0.01",
    pay_to: [{ pay_to: "0xAbC0000000000000000000000000000000000001", network: "eip155:8453" }],
    quote_checks: { last_checked_at: "2026-10-22T12:00:00Z", last_valid_quote: true, checks_recorded: 5, valid_quote_rate: 1, median_latency_ms: 300 },
    domain_age: { age_days: 400 },
    ...over,
  });
  const doc = (e: any) => ({ catalog: { entries: [e] }, curated: [] });

  it("blocks a payTo mismatch and a price far above the listing; allows a matching quote", () => {
    const url = "https://seller.test/v1/data";
    const mismatch: any = trustVerdict({ url, payTo: "0xdead000000000000000000000000000000000002" }, doc(entry()), null, BASE);
    expect(mismatch.verdict).toBe("block");
    expect(mismatch.reasons.map((r: any) => r.code)).toContain("pay_to_mismatch");
    const pricey: any = trustVerdict({ url, amountUsd: 0.5 }, doc(entry()), null, BASE);
    expect(pricey.verdict).toBe("block");
    expect(pricey.reasons.map((r: any) => r.code)).toContain("price_above_listing");
    const ok: any = trustVerdict({ url, payTo: "0xabc0000000000000000000000000000000000001", amountUsd: 0.01 }, doc(entry()), null, BASE);
    expect(ok.verdict).toBe("allow");
    expect(ok.reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(["pay_to_matches", "quote_verified"]));
  });

  it("paid_no_data only after the M1 bar; warns on unreliable, slow, young domains and domain-only matches", () => {
    const url = "https://seller.test/v1/data";
    const T = Date.parse("2026-10-24T12:00:00Z");
    const fail = (at: string) => ({ data_returned: false, at, tx_hash: "AB", http_status: 500 });
    const one: any = trustVerdict({ url }, doc(entry({ purchases: [fail("2026-10-22T10:00:00Z")] })), null, BASE, undefined, T);
    expect(one.verdict).toBe("warn");
    expect(one.reasons.map((r: any) => r.code)).toContain("recent_buy_failed");
    expect(one.confirm_rebuy).toBe(true);
    const nodata: any = trustVerdict({ url }, doc(entry({ purchases: [fail("2026-10-15T10:00:00Z"), fail("2026-10-18T10:00:00Z"), fail("2026-10-22T10:00:00Z")] })), null, BASE, undefined, T);
    expect(nodata.verdict).toBe("block");
    expect(nodata.reasons[0].code).toBe("paid_no_data");
    const flaky: any = trustVerdict({ url }, doc(entry({ quote_checks: { checks_recorded: 6, valid_quote_rate: 0.2, median_latency_ms: 9000 }, domain_age: { age_days: 3 } })), null, BASE);
    expect(flaky.verdict).toBe("warn");
    expect(flaky.reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(["unreliable_quotes", "slow", "young_domain"]));
    const domOnly: any = trustVerdict({ url: "https://seller.test/other" }, { catalog: { entries: [] } }, doc(entry()), BASE);
    expect(domOnly.verdict).toBe("warn");
    expect(domOnly.reasons.map((r: any) => r.code)).toContain("resource_not_listed");
    expect(domOnly.matched.exact).toBe(false);
  });

  it("curated vendor match links the $0.02 report as the upsell", () => {
    const v: any = trustVerdict({ url: "https://curated.test/x" }, { catalog: { entries: [] }, curated: [{ id: "printmoneylab", name: "PrintMoneyLab", detail: `${BASE}/v1/trust/vendors/printmoneylab`, xrpl_test_buys: { count: 3, delivered: 3 }, purchases: [{ at: "2026-10-22T10:00:00.000Z", network: "xrpl:0", amount: "0.001", asset: "RLUSD", tx_hash: "AB".repeat(32), http_status: 200, data_returned: true }] }] }, null, BASE);
    expect(v.verdict).toBe("allow");
    expect(v.reasons.find((r: any) => r.code === "xrpl_purchase_verified").detail ?? JSON.stringify(v.reasons)).toContain("AB".repeat(32));
    const none: any = trustVerdict({ url: "https://curated.test/x" }, { catalog: { entries: [] }, curated: [{ id: "printmoneylab", name: "PrintMoneyLab", detail: "d", xrpl_test_buys: { count: 0, delivered: 0 }, purchases: [] }] }, null, BASE);
    expect(none.verdict).toBe("warn");
    expect(none.reasons.map((r: any) => r.code)).toContain("no_recent_xrpl_buy");
    expect(v.next_steps.full_report.url).toMatch(/printmoneylab\/report$/);
    expect(v.reasons.map((r: any) => r.code)).not.toContain("quote_verified");
  });
});

describe("Stage C: feeds", () => {
  it("funding: view with reads; stale feed -> 503 not charged", async () => {
    const s = setup();
    const j: any = await (await s.buy("/v1/funding")).json();
    expect(j.kind).toBe("funding");
    expect(j.btc.symbol).toBe("BTC");
    expect(j.coins).toHaveLength(3);
    s.setNow(NOW + FEEDS.funding.stale_ms + 60_000);
    // keep scan/lite inputs irrelevant: funding only reads its feed
    const r = await s.get("/v1/funding");
    expect(r.status).toBe(503);
  });

  it("fundingView reads positive/negative funding", () => {
    const v: any = fundingView({ venue: "x", coins: [{ symbol: "A", rate_8h_pct: 0.08 }, { symbol: "B", rate_8h_pct: -0.06 }, { symbol: "BTC", rate_8h_pct: 0.01 }] });
    expect(v.most_positive[0].symbol).toBe("A");
    expect(v.most_negative[0].symbol).toBe("B");
  });

  it("fear & greed: live feed, then the CoinMarketCap context fallback when stale", async () => {
    const s = setup();
    const j: any = await (await s.buy("/v1/fear-greed")).json();
    expect(j.kind).toBe("fear_greed");
    expect(j.value).toBe(38);
    expect(j.change.vs_yesterday).toBe(-4);
    const empty = setup({ feedStore: new MemoryFeedStore() });
    const r = await empty.get("/v1/fear-greed");
    const ctx = fixture("context") as any;
    if (ctx?.fear_greed?.source === "CoinMarketCap" && !ctx.fear_greed.stale) expect(r.status).toBe(402);
    else expect(r.status).toBe(503);
    expect(fearGreedFromContext({ fear_greed: { source: "alternative.me", value: 50 } })).toBeNull();
    expect(band(10)).toBe("Extreme fear");
    expect(band(85)).toBe("Extreme greed");
  });

  it("dueFeed picks the most overdue feed, or none", () => {
    expect(dueFeed({}, NOW)).not.toBeNull();
    expect(dueFeed({ funding: NOW - 60_000, fear_greed: NOW - 60_000 }, NOW)).toBeNull();
    expect(dueFeed({ funding: NOW - FEEDS.funding.every_ms - 1, fear_greed: NOW - 60_000 }, NOW)).toBe("funding");
  });

  it("a cron run with a due feed refreshes only that feed; a failure backs off without faking freshness", async () => {
    const calls: string[] = [];
    const inner = makeFetch(happyFacilitator());
    const f = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (url.includes("okx.com/api/v5/public/funding-rate")) {
        calls.push("funding");
        return Response.json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", fundingRate: "0.0001", fundingTime: String(NOW + 3_600_000), prevFundingTime: String(NOW - 7 * 3_600_000) }] });
      }
      if (url.includes("coinmarketcap.com")) { calls.push("cmc"); return new Response("no", { status: 500 }); }
      if (url.includes("coinbase.com") || url.includes("kraken.com") || url.includes("okx.com")) calls.push("candles");
      return inner(input, init);
    }) as typeof fetch;
    const feedStore = new MemoryFeedStore();
    feedStore.rows.set("fear_greed", { id: "fear_greed", fetched_at: NOW - FEEDS.fear_greed.every_ms - 10_000, doc: { source: "CoinMarketCap", now: { value: 50 } } });
    feedStore.rows.set("funding", { id: "funding", fetched_at: NOW - FEEDS.funding.every_ms - 1_000, doc: { coins: [] } });
    const s = setup({ fetch: f, feedStore, liveStore: new MemoryLiveStore() });
    await s.app.liveRefresh(); // most overdue: fear_greed (fails)
    expect(calls).toEqual(["cmc"]);
    const fg = await feedStore.get("fear_greed");
    expect(fg!.fetched_at).toBe(NOW - FEEDS.fear_greed.every_ms - 10_000);
    await s.app.liveRefresh(); // fear_greed backed off -> funding
    expect(calls).toEqual(["cmc", "funding"]);
    const fund = await feedStore.get("funding");
    expect(fund!.fetched_at).toBe(NOW);
    expect(fund!.doc.coins[0].rate_8h_pct).toBeCloseTo(0.01, 5);
    await s.app.liveRefresh(); // nothing due -> coin slice
    expect(calls.slice(2).every((c) => c === "candles")).toBe(true);
    expect(calls.length).toBeGreaterThan(2);
  });
});

describe("Stage C: /v1/events/next48h", () => {
  it("keeps only the next 48 hours", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    const ev = { events: [
      { at_utc: "2026-10-22T10:00:00Z", title: "past", source: "s" },
      { at_utc: "2026-10-23T12:30:00Z", title: "in", source: "s" },
      { at_utc: "2026-10-25T12:30:00Z", title: "out", source: "s" },
    ] };
    const v: any = events48View(ev, null, [], now);
    expect(v.timed.map((e: any) => e.title)).toEqual(["in"]);
    expect(v.next.title).toBe("in");
    const none: any = events48View({ events: [] }, null, [], now);
    expect(none.count).toBe(0);
  });

  it("is sold from events.json", async () => {
    const { buy } = setup();
    const r = await buy("/v1/events/next48h");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.kind).toBe("events_48h");
    expect(typeof j.count).toBe("number");
  });
});

describe("Stage C: OKX candle fallback", () => {
  it("falls back to OKX when the primary venue fails", async () => {
    const coin = LIVE_UNIVERSE.find((c) => c.symbol === "AVAX")!;
    const seen: string[] = [];
    const f = (async (input: any) => {
      const url = String(input?.url ?? input);
      seen.push(url);
      if (url.includes("okx.com")) {
        const rows = Array.from({ length: 5 }, (_, i) => [String((NOW - i * 3_600_000)), "1", "2", "0.5", "1.5", "100", "0", "0", "1"]);
        return Response.json({ code: "0", data: rows });
      }
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;
    const c = await fetchCandles(f, coin, "1h");
    expect(seen.some((u) => u.includes("okx.com/api/v5/market/candles?instId=AVAX-USDT"))).toBe(true);
    expect(c).toHaveLength(5);
    expect(c[0][0]).toBeLessThan(c[4][0]);
    expect(c[0][4]).toBe(1.5);
  });
});
