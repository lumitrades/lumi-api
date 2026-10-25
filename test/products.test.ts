import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, NOW, fixture, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json, type FakeFacilitator } from "./helpers";
import { carryRisk, fundingRead } from "../src/products";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PRIVATE_NAMES: "Canaryname" };
const BASE = "http://lumi.test";
const NEW = ["/v1/brief", "/v1/macro/yen", "/v1/sentiment", "/v1/events"];

function setup(opts: { override?: Record<string, unknown>; now?: number; fac?: FakeFacilitator } = {}) {
  const fac = opts.fac ?? happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac, { override: opts.override }), log: () => {}, now: () => opts.now ?? NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { get, fac };
}

async function paid(path: string, headers: Record<string, string> = {}) {
  const { get } = setup();
  const r402 = await get(path);
  expect(r402.status).toBe(402);
  const req = (await r402.json()).accepts[0];
  const r = await get(path, { ...headers, "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
  expect(r.status).toBe(200);
  return r;
}

describe("new endpoints: 402 terms", () => {
  it.each([
    ["/v1/brief", "15000", "0.02"],
    ["/v1/macro/yen", "7500", "0.01"],
    ["/v1/sentiment", "3800", "0.005"],
    ["/v1/events", "3800", "0.005"],
  ])("%s quotes %s drops / %s stable", async (path, drops, stable) => {
    const { get } = setup();
    const r = await get(path);
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
    expect(body.x402Version).toBe(2);
    expect(body.resource.url).toBe(BASE + path);
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: drops, payTo: PAY_TO });
    expect(body.accepts.slice(1).map((a: any) => a.amount)).toEqual([stable, stable]);
  });
});

describe("new endpoints: payloads", () => {
  it("brief: BTC, CMC Fear & Greed, movers, key levels, yen, events, trades, news + markdown, privacy-filtered", async () => {
    const b = await (await paid("/v1/brief")).json();
    expect(b.kind).toBe("brief");
    expect(b.bitcoin.usd).toBeGreaterThan(0);
    expect(b.sentiment.fear_greed).toMatchObject({ source: "CoinMarketCap" });
    expect(b.movers_24h.top).toHaveLength(3);
    expect(b.key_levels.length).toBeGreaterThan(5);
    expect(b.yen.usd_jpy).toBeGreaterThan(100);
    expect(b.events_next_48h.length).toBeGreaterThan(0);
    expect(b.paper_trades.active.length).toBeGreaterThan(0);
    expect(b.markdown).toContain("# Lumi's market brief");
    expect(b.markdown).toContain("Fear & Greed");
    expect(b.disclaimer).toMatch(/Not financial advice/);
    expect(b.payment.transaction).toHaveLength(64);
    const s = JSON.stringify(b);
    expect(s).not.toMatch(/canaryname|my holdings/i);
  });

  it("brief: ?format=md returns text/markdown with the receipt", async () => {
    const r = await paid("/v1/brief?format=md");
    expect(r.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(r.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    const t = await r.text();
    expect(t).toContain("## Key levels");
    expect(t).toContain("Not financial advice");
    expect(t).not.toMatch(/canaryname/i);
  });

  it("macro/yen: USD/JPY + Nikkei, carry-trade risk around 155, Japan events", async () => {
    const b = await (await paid("/v1/macro/yen")).json();
    expect(b.usd_jpy.price).toBeGreaterThan(100);
    expect(b.nikkei_225.price).toBeGreaterThan(1000);
    expect(b.carry_trade_risk.key_level).toBe(155);
    expect(["low", "watch", "elevated"]).toContain(b.carry_trade_risk.level);
    expect(b.carry_trade_risk.reasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(b.japan_events)).toMatch(/Japan|BOJ|Bank of Japan/);
    expect(b.disclaimer).toBeTruthy();
  });

  it("sentiment: Fear & Greed + funding read + breadth", async () => {
    const b = await (await paid("/v1/sentiment")).json();
    expect(b.fear_greed.value).toBeTypeOf("number");
    expect(b.derivatives.funding_read).toBeTruthy();
    expect(b.breadth.coins_tracked).toBe(13);
    expect(b.summary).toMatch(/Fear & Greed/);
  });

  it("events: sourced upcoming + recent + dated catalysts; private rows filtered", async () => {
    const b = await (await paid("/v1/events")).json();
    expect(b.upcoming_timed.length).toBeGreaterThan(0);
    for (const e of b.upcoming_timed) expect(e.at_utc >= "2026-10-22T13:00:00.000Z").toBe(true);
    expect(b.upcoming_by_date.some((c: any) => c.coin === "XLM")).toBe(true);
    expect(JSON.stringify(b)).not.toMatch(/canaryname/i);
  });

  it("/v1/trades is gone (404, not quoted); slate + brief carry current ideas only, no outcomes or P/L", async () => {
    const { get } = setup();
    const r = await get("/v1/trades");
    expect(r.status).toBe(404);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const ids = fixture("ideas").ideas.map((t: any) => t.id);
    const slate = await (await paid("/v1/slate")).json();
    expect(slate.ideas.map((t: any) => t.id)).toEqual(ids);
    for (const t of slate.ideas) expect(["open", "pending"]).toContain(t.status);
    const brief = await (await paid("/v1/brief")).json();
    expect(brief.paper_trades.active.map((t: any) => t.id)).toEqual(ids);
    for (const b of [slate, brief]) {
      const s = JSON.stringify(b);
      expect(s).not.toMatch(/"(pnl_pct|unrealized_pnl_pct|mark_price|exit_price|closed_at|targets_hit|missed_it|cancel_reason|track_record|win_rate|stats)":/);
      expect(s).not.toMatch(/"status":"(stopped|cancelled|closed|win|loss|target|expired)"/);
    }
    expect(brief.markdown).toContain("current paper-trade ideas");
    expect(brief.markdown).not.toMatch(/, now [+-]?\d/);
  });

  it("slate/brief never pass closed ideas or P/L through even if upstream ideas.json had them", async () => {
    const ideas = fixture("ideas");
    const leaky = { ...ideas, ideas: [...ideas.ideas.map((t: any) => ({ ...t, unrealized_pnl_pct: 3.1, mark_price: 9 })), { ...ideas.ideas[0], id: "TX", status: "stopped", pnl_pct: -5, exit_price: 1 }] };
    const fac = happyFacilitator();
    const { get } = setup({ fac, override: { ideas: leaky } });
    for (const path of ["/v1/slate", "/v1/brief"]) {
      const req = (await (await get(path)).json()).accepts[0];
      const s = await (await get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor(req) })).text();
      expect(s).not.toMatch(/pnl|mark_price|exit_price|"TX"|stopped/);
    }
  });
});

describe("you only pay when you get data", () => {
  const ALL = ["/v1/signal/XRP", "/v1/levels/XRP", "/v1/slate", "/v1/market", ...NEW];

  it.each(ALL)("%s: stale inputs -> 503 'Not charged.' and no quote, no facilitator call", async (path) => {
    const fac = happyFacilitator();
    const { get } = setup({ fac, now: NOW + 3 * 86_400_000 }); // fixtures are 3 days old
    const r = await get(path);
    expect(r.status).toBe(503);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const b = await r.json();
    expect(b).toMatchObject({ error: "stale_data", note: "Not charged.", retryable: true, retry_after_seconds: expect.any(Number) });
    expect(typeof b.data_age_seconds === "number" || b.data_age_seconds === null).toBe(true);
    expect(b.data_age_seconds).toBeGreaterThan(86_400);
    // even a (forged) payment header cannot trigger settlement
    const r2 = await get(path, { "PAYMENT-SIGNATURE": paymentHeaderFor({ scheme: "exact", extra: { invoiceId: "x" } }) });
    expect(r2.status).toBe(503);
    expect(fac.calls).toHaveLength(0);
  });

  it("a quote obtained while data was fresh is not settled once the data goes stale", async () => {
    const fac = happyFacilitator();
    let now = NOW;
    const app = createApp(ENV, { fetch: makeFetch(fac), log: () => {}, now: () => now });
    const req = (await (await app.fetch(new Request(BASE + "/v1/sentiment"))).json()).accepts[0];
    now = NOW + 2 * 86_400_000;
    const r = await app.fetch(new Request(BASE + "/v1/sentiment", { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(req) } }));
    expect(r.status).toBe(503);
    expect(fac.calls).toHaveLength(0);
  });

  it("empty or missing data -> 503 before any payment", async () => {
    const ctx = fixture("context");
    const cases: [string, Record<string, unknown>][] = [
      ["/v1/sentiment", { context: { ...ctx, fear_greed: { error: "down" } } }],
      ["/v1/macro/yen", { context: { ...ctx, yen: { usd_jpy: { error: "x" }, nikkei: { error: "y" } } } }],
      ["/v1/market", { prices: {} }],
      ["/v1/events", { events: null, analysis: { ...fixture("analysis"), backdrop: {}, coins: {} } }],
      ["/v1/slate", { ideas: null }],
    ];
    for (const [path, override] of cases) {
      const fac = happyFacilitator();
      const { get } = setup({ fac, override });
      const r = await get(path);
      expect(r.status, path).toBe(503);
      expect((await r.json()).note).toBe("Not charged.");
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect(fac.calls).toHaveLength(0);
    }
  });

  it("optional inputs missing: brief is still sold, without those fields", async () => {
    const { get } = setup({ override: { events: null, brief: null } });
    const r = await get("/v1/brief");
    expect(r.status).toBe(402);
  });
});

describe("rules", () => {
  it("carry-trade risk levels", () => {
    const q = (price: number, change_pct: number) => ({ price, change_pct, change_5d_pct: 0 }) as any;
    expect(carryRisk(q(160, 0.1), q(60000, 0.5))!.level).toBe("low");
    expect(carryRisk(q(157, -0.6), q(60000, -2.6))!.level).toBe("watch");
    expect(carryRisk(q(154.9, 0), null)!.level).toBe("elevated");
    expect(carryRisk(q(158, -1.8), null)!.level).toBe("elevated");
    expect(carryRisk(null, null)).toBeNull();
  });
  it("funding read", () => {
    expect(fundingRead(0.005)).toMatch(/^flat/);
    expect(fundingRead(0.01)).toMatch(/^positive/);
    expect(fundingRead(0.05)).toMatch(/^hot/);
    expect(fundingRead(-0.02)).toMatch(/^negative/);
    expect(fundingRead(null)).toBeNull();
  });
});
