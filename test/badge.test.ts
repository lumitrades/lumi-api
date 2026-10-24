import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/app";
import worker, { badgeCacheKey } from "../src/index";
import { MemoryTrustStore, type ObservationRow } from "../src/trust/store";
import { MemoryCatalogStore, type BuyRow } from "../src/trust/catalog";
import { normalizeKey, usDate, badgeSvg, badgeMessage, BADGE_CACHE_CONTROL, createBadges } from "../src/trust/badge";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: "https://api.lumitrades.io" };
const D = 86_400_000;
const obs = (vendor_id: string, ts: number, o: Partial<ObservationRow> = {}): ObservationRow => ({
  vendor_id, endpoint: `https://api.${vendor_id}.com/x`, ts, network: "xrpl:0", tx_hash: `${vendor_id}${ts}`.padEnd(64, "0"), amount: "1000", asset: "XRP",
  http_status: 200, data_returned: true, latency_ms: 100, summary: "ok", source: "test", ...o,
});
const buy = (domain: string, ts: number, o: Partial<BuyRow> = {}): BuyRow => ({
  resource: `https://${domain}/v1/x`, domain, ts, network: "eip155:8453", tx_hash: `0x${domain.replace(/\W/g, "")}${ts}`, amount: "10000", asset: "USDC",
  pay_to: "0xabc0000000000000000000000000000000000001", facilitator: null, http_status: 200, data_returned: true, latency_ms: 90, summary: "ok", ...o,
});

function mkApp() {
  const trustStore = new MemoryTrustStore([
    obs("printmoneylab", NOW - 3 * D, { data_returned: false, http_status: 500 }),
    obs("printmoneylab", NOW - D, {}),
    obs("cryptobuddy", NOW - 2 * D, { data_returned: false, http_status: 402 }),
  ]);
  const catalogStore = new MemoryCatalogStore();
  catalogStore.buys.push(
    buy("1gateway.dev", NOW - 5 * D),
    buy("alpha.example.com", NOW - 4 * D, { http_status: null, data_returned: false, inconclusive: "no_response" }),
  );
  const app = createApp(ENV as any, { trustStore, catalogStore, now: () => NOW, fetch: makeFetch(happyFacilitator()), log: () => {} } as any);
  return { app, trustStore, catalogStore };
}
const get = (app: any, path: string, init?: RequestInit) => app.fetch(new Request(`https://api.lumitrades.io${path}`, init));

describe("badge helpers", () => {
  it("normalises keys and rejects junk", () => {
    expect(normalizeKey("PrintMoneyLab")).toBe("printmoneylab");
    expect(normalizeKey("API.Example.com.")).toBe("api.example.com");
    expect(normalizeKey("%20foo.dev")).toBe("foo.dev");
    for (const bad of ["", "*", "a b", "x%", "../etc", "-foo", "http:%2F%2Fx.com", "%", "a".repeat(70)]) expect(normalizeKey(bad)).toBeNull();
  });
  it("dates are MM-DD-YYYY in UTC", () => {
    expect(usDate(Date.parse("2026-10-03T23:59:00Z"))).toBe("10-03-2026");
  });
});

const page = async (app: any, key: string) => (await get(app, `/trust/v/${key}`)).text();

describe("result page summary (/trust/v/{key})", () => {
  it("delivered vendor: latest date and chain", async () => {
    const { app } = mkApp();
    const r = await get(app, "/trust/v/printmoneylab");
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe(BADGE_CACHE_CONTROL);
    expect(await r.text()).toMatch(new RegExp(`Latest paid test-buy: <strong class="v delivered">delivered</strong> on ${usDate(NOW - D)} \\(XRPL\\)`));
  });
  it("not delivered vendor", async () => {
    expect(await page(mkApp().app, "cryptobuddy")).toContain('class="v not_delivered"');
  });
  it("host key: catalog buys (Base) and inconclusive", async () => {
    const { app } = mkApp();
    expect(await page(app, "1gateway.dev")).toContain(`on ${usDate(NOW - 5 * D)} (Base)`);
    expect(await page(app, "alpha.example.com")).toContain('class="v inconclusive"');
  });
  it("host of a curated vendor endpoint maps to that vendor", async () => {
    expect(await page(mkApp().app, "api.printmoneylab.com")).toContain('class="v delivered"');
  });
  it("unknown keys say not yet tested; invalid keys are a 400 without lookups; Lumi itself is never scored", async () => {
    const { app } = mkApp();
    for (const k of ["not-a-real-vendor", "nothing.example.org"]) expect(await page(app, k)).toContain("Not yet tested");
    expect((await get(app, "/trust/v/%2A")).status).toBe(400);
    expect(await page(app, "api.lumitrades.io")).toContain("Lumi does not test or score its own API.");
  });
  it("HEAD works; non-GET is refused", async () => {
    const { app } = mkApp();
    const h = await get(app, "/trust/v/printmoneylab", { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe("");
    expect((await app.badge(new Request("https://api.lumitrades.io/trust/v/printmoneylab", { method: "POST" })))!.status).toBe(405);
  });
  it("escapes everything it renders", () => {
    const svg = badgeSvg({ key: "x", kind: "unknown", name: "<x>", vendor_id: null, homepage: null, verdict: "not_tested", verdict_text: "", latest: null, chain: null, tests: [], pay_tos: [] });
    expect(svg).not.toContain("<x>");
    expect(badgeMessage({ kind: "invalid" } as any)).toBe("invalid key");
  });
});

describe("legacy /badge retired: 301 to the signed /v1/badge route", () => {
  it("redirects svg, json and docs, keeping the query string", async () => {
    const { app } = mkApp();
    for (const [from, to] of [
      ["/badge/printmoneylab.svg", "/v1/badge/printmoneylab.svg"],
      ["/badge/printmoneylab.svg?style=flat&v=2", "/v1/badge/printmoneylab.svg?style=flat&v=2"],
      ["/badge/api.example.com.JSON?x=1", "/v1/badge/api.example.com.json?x=1"],
      ["/badge", "/v1/badge"],
      ["/badge/?ref=readme", "/v1/badge?ref=readme"],
    ]) {
      const r = await get(app, from);
      expect(r.status, from).toBe(301);
      expect(r.headers.get("Location")).toBe(`https://api.lumitrades.io${to}`);
    }
    const long = await get(app, `/badge/printmoneylab.svg?q=${"a".repeat(2000)}`);
    expect(long.headers.get("Location")).toBe("https://api.lumitrades.io/v1/badge/printmoneylab.svg");
    expect((await get(app, "/badge/printmoneylab.svg", { method: "HEAD" })).status).toBe(301);
    expect((await app.badge(new Request("https://api.lumitrades.io/badge/x.svg", { method: "POST" })))!.status).toBe(405);
  });
  it("the worker redirects before the edge cache (query kept) and the target serves the signed badge", async () => {
    const r = await worker.fetch(new Request("https://api.lumitrades.io/badge/printmoneylab.svg?cb=7"), ENV as any, { waitUntil: () => {} });
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe("https://api.lumitrades.io/v1/badge/printmoneylab.svg?cb=7");
    const { app } = mkApp();
    const svg = await get(app, "/v1/badge/printmoneylab.svg?cb=7");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toContain("image/svg+xml");
    const j = await (await get(app, "/v1/badge/printmoneylab.json")).json();
    expect(j.kind).toBe("tested_badge_verdict");
    expect(j.threshold).toMatchObject({ min_score: 80, min_paid_test_buys: 3 });
    expect(j.signed).toBeDefined();
  });
  it("GET /v1/badge documents the signed badge; embeds and the result page point at /v1/badge", async () => {
    const { app } = mkApp();
    const d = await (await get(app, "/v1/badge")).json();
    expect(d.kind).toBe("lumi_badge_docs");
    expect(d.endpoints.svg).toBe("https://api.lumitrades.io/v1/badge/{key}.svg");
    expect(d.threshold).toEqual({ min_score: 80, min_paid_test_buys: 3, latest_test_buy: "delivered" });
    expect(d.legacy).toMatch(/301/);
    expect(d.example.markdown).toBe("[![Tested by Lumi (live score, earned only)](https://api.lumitrades.io/v1/badge/printmoneylab.svg)](https://api.lumitrades.io/trust/v/printmoneylab)");
    expect(JSON.stringify(d)).not.toContain("cryptobuddy");
    const h = await page(app, "printmoneylab");
    expect(h).toContain("/v1/badge/printmoneylab.svg");
    expect(h).not.toMatch(/api\.lumitrades\.io\/badge/);
  });
});

describe("result page", () => {
  it("result page shows dated tests, how-it-works, right to reply, disclaimer", async () => {
    const r = await get(mkApp().app, "/trust/v/printmoneylab");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    expect(r.headers.get("Cache-Control")).toBe(BADGE_CACHE_CONTROL);
    const h = await r.text();
    expect(h).toContain(usDate(NOW - D));
    expect(h).toContain("https://lumitrades.io/how-it-works/");
    expect(h).toContain("hello@lumitrades.io");
    expect(h).toContain("not an endorsement");
    expect(h).toContain("Paying Lumi never changes a result");
    expect(h).toContain("not delivered");
    expect(h).not.toMatch(/tx_hash|printmoneylab\d{10}/);
    const un = await (await get(mkApp().app, "/trust/v/nothing.example.org")).text();
    expect(un).toContain("Not yet tested");
    expect(un).toContain("noindex");
  });
  it("there is no listing or wildcard: /trust/v needs a key", async () => {
    expect((await get(mkApp().app, "/trust/v")).status).not.toBe(200);
  });
  it("caps tests per key at 10", async () => {
    const trustStore = new MemoryTrustStore(Array.from({ length: 30 }, (_, i) => obs("printmoneylab", NOW - i * 1000)));
    const b = createBadges({ now: () => NOW, latestObservations: (i, n) => trustStore.latestObservations(i, n), buysByDomain: async () => [], selfDomains: [] });
    expect((await b.summary("printmoneylab")).tests).toHaveLength(10);
  });
});

/** A fake D1 that records every statement. */
function fakeD1(rows: Record<string, unknown[]>) {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      const pick = () => Object.entries(rows).find(([k]) => q.includes(k))?.[1] ?? [];
      const st: any = {
        bind: () => st,
        all: async () => ({ results: pick() }),
        first: async () => pick()[0] ?? null,
        run: async () => ({ meta: { changes: 0 } }),
        raw: async () => [],
      };
      return st;
    },
    batch: async (s: unknown[]) => s.map(() => ({ results: [] })),
    exec: async () => ({}),
  };
  return { db, sql };
}

describe("D1 budget: badge paths never write", () => {
  const orig = (globalThis as any).caches;
  let store: Map<string, Response>;
  beforeEach(() => {
    store = new Map();
    (globalThis as any).caches = {
      default: {
        match: async (k: string) => store.get(String(k))?.clone(),
        put: async (k: string, r: Response) => { store.set(String(k), r.clone()); },
      },
    };
  });
  afterEach(() => { (globalThis as any).caches = orig; });

  it("only SELECTs on a miss, nothing on a hit, and query strings / case share one cache entry", async () => {
    const { db, sql } = fakeD1({
      "FROM observations": [obs("printmoneylab", NOW - D)],
      "FROM catalog_buys": [],
    });
    const env = { ...ENV, XRP_PRICING: "live", TRUST_DB: db };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    const paths = ["/trust/v/printmoneylab", "/trust/v/PrintMoneyLab?v=1", "/trust/v/printmoneylab/?cb=2", "/trust/v/api.example.com", "/trust/v/api.example.com"];
    for (const p of paths) {
      const r = await worker.fetch(new Request(`https://api.lumitrades.io${p}`), env as any, ctx);
      expect(r.status).toBe(200);
      await Promise.all(waits);
    }
    const writes = sql.filter((q) => !/^\s*SELECT/i.test(q));
    expect(writes).toEqual([]);
    // printmoneylab page once (+ read-only disclosure lookups), example host once; legacy /badge never touches D1.
    expect(sql.filter((q) => q.includes("FROM observations")).length).toBe(1);
    expect(sql.filter((q) => q.includes("FROM catalog_buys")).length).toBe(1);
    expect(store.size).toBe(2);
    expect(badgeCacheKey(new URL("https://api.lumitrades.io/trust/v/X/?a=1"))).toBe("https://api.lumitrades.io/trust/v/x");
    const n = sql.length;
    expect((await worker.fetch(new Request("https://api.lumitrades.io/badge/printmoneylab.svg?v=1"), env as any, ctx)).status).toBe(301);
    expect(sql.length).toBe(n);
  });
});
