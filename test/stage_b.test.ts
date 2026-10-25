import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { analyze, resample, refreshLive, isFresh, priceFrom1h, MemoryLiveStore, LIVE_UNIVERSE, LIVE_CHUNK, type Candle } from "../src/live";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";

/** Deterministic synthetic candles ending at `end` (seconds), uptrend with oscillation. */
function candles(n: number, step: number, end: number, base = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const t = end - (n - 1 - i) * step;
    const c = base * (1 + i * 0.002 + 0.03 * Math.sin(i / 7));
    out.push([t, c * 0.998, c * 1.01, c * 0.99, c, 1000 + (i % 10) * 50]);
  }
  return out;
}

/** Fake Coinbase/Kraken candle endpoints; everything else goes to the normal test fetch. */
function candleFetch(inner: typeof fetch, calls: string[], fail: string[] = []): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const endS = Math.floor(NOW / 1000 / 3600) * 3600;
    if (url.startsWith("https://api.exchange.coinbase.com/")) {
      calls.push(url);
      if (fail.some((f) => url.includes(f))) return new Response("nope", { status: 404 });
      const day = url.includes("granularity=86400");
      const rows = candles(300, day ? 86400 : 3600, endS).reverse().map(([t, o, h, l, c, v]) => [t, l, h, o, c, v]);
      return Response.json(rows);
    }
    if (url.startsWith("https://api.kraken.com/")) {
      calls.push(url);
      const day = url.includes("interval=1440");
      const rows = candles(720, day ? 86400 : 3600, endS, 0.3).map(([t, o, h, l, c, v]) => [t, String(o), String(h), String(l), String(c), String(c), String(v), 5]);
      return Response.json({ error: [], result: { PAIR: rows, last: endS } });
    }
    return inner(input, init);
  }) as typeof fetch;
}

describe("live signal engine", () => {
  it("analyze scores within [-1,1] and labels it; resample makes 4h bars", () => {
    const c = candles(300, 3600, 1_800_000_000 - (1_800_000_000 % 14400));
    const a = analyze(c, "1h");
    expect(a.score).toBeGreaterThanOrEqual(-1);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(a.max_points).toBeGreaterThan(0);
    expect(Object.keys(a.indicators)).toEqual(expect.arrayContaining(["rsi", "macd", "ema", "bb", "stochrsi"]));
    const h4 = resample(c, 14400);
    expect(h4.length).toBeGreaterThanOrEqual(74);
    expect(h4.every((b) => b[0] % 14400 === 0)).toBe(true);
    const p = priceFrom1h(c);
    expect(p.usd).toBeCloseTo(c[c.length - 1][4], 3);
    expect(typeof p.change_24h_pct).toBe("number");
  });

  it("universe: 49 unique coins (SOL excluded), no political tokens", () => {
    expect(LIVE_UNIVERSE).toHaveLength(49);
    expect(LIVE_UNIVERSE.map((c) => c.symbol)).not.toContain("SOL");
    expect(new Set(LIVE_UNIVERSE.map((c) => c.id)).size).toBe(49);
    expect(LIVE_UNIVERSE.map((c) => c.symbol)).not.toContain("WLFI");
    expect(LIVE_UNIVERSE.map((c) => c.symbol)).not.toContain("TRUMP");
  });

  it("refreshLive stays inside the Workers Free subrequest budget and rotates stalest-first", async () => {
    const store = new MemoryLiveStore();
    const calls: string[] = [];
    const f = candleFetch(makeFetch(happyFacilitator()), calls);
    const r1 = await refreshLive(store, f, NOW);
    expect(r1.refreshed).toHaveLength(LIVE_CHUNK);
    expect(calls.length).toBeLessThanOrEqual(LIVE_CHUNK * 2);
    expect(calls.length).toBeLessThan(45);
    const first = new Set(r1.refreshed);
    const r2 = await refreshLive(store, f, NOW + 60_000);
    expect(r2.refreshed.some((s) => first.has(s))).toBe(false);
    const row = await store.get(LIVE_UNIVERSE.find((c) => c.symbol === r1.refreshed[0])!.id);
    expect(isFresh(row, NOW + 60_000)).toBe(true);
    expect(isFresh(row, NOW + 80 * 60_000)).toBe(false);
  });

  it("a failing coin is retried later, not every slice", async () => {
    const store = new MemoryLiveStore();
    const calls: string[] = [];
    const f = candleFetch(makeFetch(happyFacilitator()), calls, ["BTC-USD"]);
    const r1 = await refreshLive(store, f, NOW);
    expect(r1.errors.join()).toMatch(/BTC/);
    const r2 = await refreshLive(store, f, NOW + 60_000);
    expect(r2.errors.join()).not.toMatch(/BTC/);
    expect(isFresh(await store.get("bitcoin"), NOW + 60_000)).toBe(false);
  });
});

describe("/v1/signal with live rows", () => {
  async function setup() {
    const fac = happyFacilitator();
    const calls: string[] = [];
    const f = candleFetch(makeFetch(fac), calls);
    const liveStore = new MemoryLiveStore();
    let t = NOW;
    const app = createApp(ENV, { fetch: f, log: () => {}, now: () => t, liveStore });
    const get = (p: string, h: Record<string, string> = {}) => app.fetch(new Request(BASE + p, { headers: h }));
    const buy = async (p: string) => {
      const q = await (await get(p)).json();
      return get(p, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[0]) });
    };
    return { app, get, buy, liveStore, setNow: (x: number) => (t = x) };
  }

  it("lists 50 coins; levels only for site coins", async () => {
    const { get } = await setup();
    const j: any = await (await get("/v1/coins")).json();
    expect(j.count).toBe(49);
    const avax = j.coins.find((c: any) => c.symbol === "AVAX");
    expect(avax.levels).toBeNull();
    expect(avax.signal).toMatch(/\/v1\/signal\/AVAX$/);
    expect(j.coins.find((c: any) => c.symbol === "BTC").levels).toMatch(/levels\/BTC$/);
  });

  it("serves a fresh live row (with live freshness meta) for a top-50 coin", async () => {
    const { app, buy } = await setup();
    // Fill the whole universe.
    for (let i = 0; i < 13; i++) await app.liveRefresh();
    const r = await buy("/v1/signal/AVAX");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.kind).toBe("signal");
    expect(j.computed).toBe("live");
    expect(j.coin.symbol).toBe("AVAX");
    expect(["positive bias", "neutral bias", "negative bias"]).toContain(j.label);
    expect(j.timeframes["1h"].indicators.rsi.value).toBeTypeOf("number");
    expect(j.timeframes["4h"]).toBeTruthy();
    expect(j.price.usd).toBeTypeOf("number");
    expect(Date.parse(j.as_of)).toBe(NOW);
    expect(Date.parse(j.stale_after)).toBe(NOW + 75 * 60_000);
    expect(j.disclaimer).toBeTruthy();
  });

  it("non-site coin without a fresh row: 503, not charged; site coin falls back to the site file", async () => {
    const { get, buy } = await setup();
    const q = await get("/v1/signal/AVAX");
    expect(q.status).toBe(503);
    expect((await q.json()).note).toMatch(/Not charged/);
    const r = await buy("/v1/signal/BTC");
    expect(r.status).toBe(200);
    expect((await r.json()).computed).toBeUndefined();
  });

  it("levels for a non-site coin: 404 no_data_for_coin before any quote", async () => {
    const { get } = await setup();
    const r = await get("/v1/levels/AVAX");
    expect(r.status).toBe(404);
    const j: any = await r.json();
    expect(j.error).toBe("no_data_for_coin");
    expect(j.levels_coins).toContain("BTC");
  });
});
