import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  CrawlerLimiter, EDGE_STATUS, _resetEdgeState, edgeKey, isEdgeCacheable, maxAgeOf, serveEdgeCached, staleWindowS, type EdgeCacheLike,
} from "../src/edge_cache";
import { PAY_TO, FACILITATOR, DATA, NOW } from "./helpers";

function memCache() {
  const m = new Map<string, Response>();
  const c: EdgeCacheLike & { m: Map<string, Response> } = {
    m,
    match: async (k) => m.get(k)?.clone(),
    put: async (k, r) => { m.set(k, r.clone()); },
  };
  return c;
}
const body = (n: number, cc = "public, max-age=120") => new Response(JSON.stringify({ n }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": cc } });
const req = (p: string, h: Record<string, string> = {}) => new Request(`https://api.lumitrades.io${p}`, { headers: { "CF-Connecting-IP": "203.0.113.9", ...h } });

describe("edge cache: stale-while-revalidate, coalescing, deadline, crawler limit", () => {
  let t = 1_000_000;
  const now = () => t;
  let waits: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => { waits.push(p); };
  const settle = async () => { while (waits.length) await Promise.all(waits.splice(0)); };
  beforeEach(() => { _resetEdgeState(); t = 1_000_000; waits = []; });

  it("fresh hit, then stale served at once with one background refresh, then fresh again", async () => {
    const cache = memCache();
    let calls = 0;
    const produce = async () => body(++calls);
    const r1 = await serveEdgeCached(req("/v1/trust/vendors"), produce, { cache, now, waitUntil });
    await settle();
    expect(r1.headers.get(EDGE_STATUS)).toBe("miss");
    expect(r1.headers.get("Cache-Control")).toBe("public, max-age=120");
    t += 60_000;
    const r2 = await serveEdgeCached(req("/v1/trust/vendors"), produce, { cache, now, waitUntil });
    expect(r2.headers.get(EDGE_STATUS)).toBe("hit");
    expect(r2.headers.get("Cache-Control")).toBe("public, max-age=120");
    expect(r2.headers.has("X-Lumi-Stored-At")).toBe(false);
    expect(await r2.json()).toEqual({ n: 1 });
    t += 120_000; // stale (age 180 s > 120 s), inside the stale window
    const [s1, s2] = await Promise.all([1, 2].map(() => serveEdgeCached(req("/v1/trust/vendors"), produce, { cache, now, waitUntil })));
    expect(s1.headers.get(EDGE_STATUS)).toBe("stale");
    expect(await s2.json()).toEqual({ n: 1 });
    await settle();
    expect(calls).toBe(2); // one refresh for two stale hits
    const r3 = await serveEdgeCached(req("/v1/trust/vendors"), produce, { cache, now, waitUntil });
    expect(r3.headers.get(EDGE_STATUS)).toBe("hit");
    expect(await r3.json()).toEqual({ n: 2 });
    // past max-age + stale window: a normal miss
    t += (120 + staleWindowS(120) + 1) * 1000;
    const r4 = await serveEdgeCached(req("/v1/trust/vendors"), produce, { cache, now, waitUntil });
    expect(r4.headers.get(EDGE_STATUS)).toBe("miss");
    expect(calls).toBe(3);
  });

  it("concurrent misses for one key share a single rebuild; query order does not split the cache", async () => {
    const cache = memCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const produce = async () => { calls++; await gate; return body(calls); };
    const ps = [0, 1, 2, 3, 4].map(() => serveEdgeCached(req("/v1/trust/catalog?b=2&a=1"), produce, { cache, now, waitUntil }));
    const other = serveEdgeCached(req("/v1/trust/catalog?a=1&b=2"), produce, { cache, now, waitUntil });
    release();
    const rs = await Promise.all([...ps, other]);
    expect(calls).toBe(1);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(rs.filter((r) => r.headers.get(EDGE_STATUS) === "shared").length).toBe(5);
    expect(edgeKey(new URL("https://x.io/trust/v/ABC/?v=1"))).toBe("https://x.io/trust/v/abc");
  });

  it("a slow miss answers 503 + Retry-After at the deadline (never hangs), or the stale copy when one exists", async () => {
    const cache = memCache();
    const never = () => new Promise<Response>(() => {});
    const r = await serveEdgeCached(req("/v1/samples"), never, { cache, now, waitUntil, deadlineMs: 20 });
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("30");
    _resetEdgeState();
    waits = []; // the hung rebuild above never settles
    await serveEdgeCached(req("/v1/samples"), async () => body(7, "public, max-age=600"), { cache, now, waitUntil });
    await settle();
    t += (600 + staleWindowS(600) + 5) * 1000; // too old to serve as stale-while-revalidate
    const r2 = await serveEdgeCached(req("/v1/samples"), never, { cache, now, waitUntil, deadlineMs: 20 });
    expect(r2.status).toBe(200);
    expect(r2.headers.get(EDGE_STATUS)).toBe("timeout-stale");
    expect(await r2.json()).toEqual({ n: 7 });
  });

  it("a burst crawler gets 429 + Retry-After; other clients are unaffected; only public 200s are stored", async () => {
    const cache = memCache();
    const limiter = new CrawlerLimiter({ capacity: 20, refillPerS: 1 });
    let calls = 0;
    const produce = async () => body(++calls);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await serveEdgeCached(req(`/v1/trust/vendors?url=https://h${i}.example`), produce, { cache, now, waitUntil, limiter })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
    const limited = await serveEdgeCached(req("/v1/trust/vendors?url=https://h9.example"), produce, { cache, now, waitUntil, limiter });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    const other = await serveEdgeCached(req("/v1/trust/vendors?url=https://h9.example", { "CF-Connecting-IP": "198.51.100.7" }), produce, { cache, now, waitUntil, limiter });
    expect(other.status).toBe(200);
    t += 30_000;
    expect((await serveEdgeCached(req("/v1/trust/vendors?url=https://h9.example"), produce, { cache, now, waitUntil, limiter })).status).toBe(200);
    // not stored: 402, 5xx, private / no-store
    await settle();
    const n = cache.m.size;
    for (const r of [new Response("{}", { status: 402, headers: { "Cache-Control": "public, max-age=60" } }), new Response("{}", { status: 503, headers: { "Cache-Control": "public, max-age=60" } }), body(1, "no-store"), body(1, "private, max-age=60")]) {
      _resetEdgeState();
      await serveEdgeCached(req(`/v1/methodology-${Math.random()}`), async () => r, { cache, now, waitUntil });
    }
    await settle();
    expect(cache.m.size).toBe(n);
    expect(maxAgeOf("public, max-age=3600, s-maxage=3600")).toBe(3600);
    expect(maxAgeOf("public, s-maxage=60")).toBe(null);
  });

  it("paid routes, payment headers and owner requests never use the edge cache", () => {
    const u = (p: string) => new URL(`https://api.lumitrades.io${p}`);
    expect(isEdgeCacheable(req("/v1/trust/vendors"), u("/v1/trust/vendors"))).toBe(true);
    expect(isEdgeCacheable(req("/trust/v/printmoneylab"), u("/trust/v/printmoneylab"))).toBe(true);
    expect(isEdgeCacheable(req("/v1/trust/vendors/x/report"), u("/v1/trust/vendors/x/report"))).toBe(false);
    expect(isEdgeCacheable(req("/v1/trust/check"), u("/v1/trust/check"))).toBe(false);
    expect(isEdgeCacheable(req("/v1/trust/vendors", { "X-PAYMENT": "abc" }), u("/v1/trust/vendors"))).toBe(false);
    expect(isEdgeCacheable(req("/v1/trust/vendors", { "PAYMENT-SIGNATURE": "abc" }), u("/v1/trust/vendors"))).toBe(false);
    expect(isEdgeCacheable(req("/v1/trust/vendors", { Authorization: "Bearer x" }), u("/v1/trust/vendors"))).toBe(false);
    expect(isEdgeCacheable(new Request("https://api.lumitrades.io/v1/trust/vendors", { method: "POST" }), u("/v1/trust/vendors"))).toBe(false);
  });
});

describe("worker: free pages through the edge cache, paid 402s untouched", () => {
  const orig = (globalThis as any).caches;
  let store: Map<string, Response>;
  beforeEach(() => {
    _resetEdgeState();
    store = new Map();
    (globalThis as any).caches = { default: { match: async (k: string) => store.get(String(k))?.clone(), put: async (k: string, r: Response) => { store.set(String(k), r.clone()); } } };
  });
  afterEach(() => { (globalThis as any).caches = orig; });
  const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: "https://api.lumitrades.io" };
  void NOW;

  it("methodology: miss then hit; a paid route still answers 402 with PAYMENT-REQUIRED and is never stored", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    const a = await worker.fetch(new Request("https://api.lumitrades.io/v1/trust/methodology"), ENV as any, ctx);
    await Promise.allSettled(waits);
    expect(a.status).toBe(200);
    expect(a.headers.get(EDGE_STATUS)).toBe("miss");
    const b = await worker.fetch(new Request("https://api.lumitrades.io/v1/trust/methodology"), ENV as any, ctx);
    expect(b.status).toBe(200);
    expect(b.headers.get(EDGE_STATUS)).toBe("hit");
    expect(await b.text()).toBe(await a.text());
    const before = store.size;
    const paid = await worker.fetch(new Request("https://api.lumitrades.io/v1/trust/check?url=https://api.example.com/x"), ENV as any, ctx);
    await Promise.allSettled(waits);
    expect(paid.status).toBe(402);
    expect(paid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(paid.headers.has(EDGE_STATUS)).toBe(false);
    expect(store.size).toBe(before);
  });
});

/**
 * vendor-cache-fix 2026-10-28: the cached copy of /v1/trust/vendors?domain=... sent ~3.7 KB of 15.3 KB and then hung. The
 * stored copy was a tee'd branch of the live response stream, put into the Cache API while the body was still streaming.
 * Now the body is read completely first, checked against Content-Length, and every copy is built from that buffer; hits
 * are read and length-checked before they are served.
 */
describe("edge cache: only complete bodies are stored or served", () => {
  let t = 1_000_000;
  const now = () => t;
  let waits: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => { waits.push(p); };
  const settle = async () => { while (waits.length) await Promise.all(waits.splice(0)); };
  beforeEach(() => { _resetEdgeState(); t = 1_000_000; waits = []; });

  const big = "x".repeat(15_298);
  const chunked = (chunks: string[], cc = "public, max-age=300", extra: Record<string, string> = {}) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        const c = chunks.shift();
        if (c === undefined) { ctl.close(); return; }
        await new Promise((ok) => setTimeout(ok, 1));
        ctl.enqueue(enc.encode(c));
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": cc, ...extra } });
  };

  it("a streamed 15.3 KB body is stored whole; the hit returns every byte with the right length", async () => {
    const cache = memCache();
    const parts = [big.slice(0, 3_700), big.slice(3_700, 9_000), big.slice(9_000)];
    const r1 = await serveEdgeCached(req("/v1/trust/vendors?domain=api.jobsproperty-api.workers.dev"), async () => chunked([...parts], undefined, { "Content-Length": "15298" }), { cache, now, waitUntil });
    expect((await r1.text()).length).toBe(15_298);
    await settle();
    const stored = [...cache.m.values()][0];
    expect(stored.headers.get("X-Lumi-Body-Length")).toBe("15298");
    expect((await stored.clone().arrayBuffer()).byteLength).toBe(15_298);
    t += 10_000;
    const r2 = await serveEdgeCached(req("/v1/trust/vendors?domain=api.jobsproperty-api.workers.dev"), async () => { throw new Error("should not rebuild"); }, { cache, now, waitUntil });
    expect(r2.headers.get(EDGE_STATUS)).toBe("hit");
    expect(r2.headers.has("X-Lumi-Body-Length")).toBe(false);
    expect((await r2.arrayBuffer()).byteLength).toBe(15_298);
  });

  it("concurrent misses all get the full body (one buffer, no tee)", async () => {
    const cache = memCache();
    const rs = await Promise.all([0, 1, 2, 3].map(() => serveEdgeCached(req("/v1/trust/catalog"), async () => chunked([big.slice(0, 5000), big.slice(5000)]), { cache, now, waitUntil })));
    for (const r of rs) expect((await r.text()).length).toBe(15_298);
    await settle();
    expect(cache.m.size).toBe(1);
  });

  it("a body shorter than its Content-Length is served as read but never cached", async () => {
    const cache = memCache();
    const r = await serveEdgeCached(req("/v1/trust/vendors?domain=a.example"), async () => chunked([big.slice(0, 3_700)], undefined, { "Content-Length": "15298" }), { cache, now, waitUntil });
    await settle();
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Length")).not.toBe("15298");
    expect((await r.text()).length).toBe(3_700);
    expect(cache.m.size).toBe(0);
  });

  it("non-200 public responses are not cached", async () => {
    const cache = memCache();
    for (const s of [400, 404, 410]) {
      _resetEdgeState();
      await serveEdgeCached(req(`/trust/v/unknown-${s}`), async () => new Response("{}", { status: s, headers: { "Cache-Control": "public, max-age=300" } }), { cache, now, waitUntil });
    }
    await settle();
    expect(cache.m.size).toBe(0);
  });

  it("a truncated or stalled cached copy is dropped and rebuilt instead of hanging the client", async () => {
    const deleted: string[] = [];
    const m = new Map<string, () => Response>();
    const cache: EdgeCacheLike = {
      match: async (k) => m.get(k)?.(),
      put: async () => {},
      delete: async (k) => { deleted.push(k); m.delete(k); return true; },
    };
    const key = "https://api.lumitrades.io/v1/trust/vendors?domain=api.jobsproperty-api.workers.dev";
    const storedHeaders = { "Cache-Control": "public, max-age=1800", "X-Lumi-Cache-Control": "public, max-age=300", "X-Lumi-Stored-At": String(t - 10_000) };
    // 1) old-style copy: Content-Length 15298, only 3.7 KB present
    m.set(key, () => new Response(big.slice(0, 3_700), { status: 200, headers: { ...storedHeaders, "Content-Length": "15298" } }));
    let calls = 0;
    const produce = async () => { calls++; return new Response(big, { status: 200, headers: { "Cache-Control": "public, max-age=300" } }); };
    const r1 = await serveEdgeCached(req("/v1/trust/vendors?domain=api.jobsproperty-api.workers.dev"), produce, { cache, now, waitUntil });
    expect(r1.headers.get(EDGE_STATUS)).toBe("miss");
    expect((await r1.text()).length).toBe(15_298);
    expect(calls).toBe(1);
    await settle();
    expect(deleted).toEqual([key]);
    // 2) a copy whose body sends 3.7 KB and then never ends
    _resetEdgeState();
    m.set(key, () => {
      const enc = new TextEncoder();
      let sent = false;
      const s = new ReadableStream<Uint8Array>({ pull(ctl) { if (!sent) { sent = true; ctl.enqueue(enc.encode(big.slice(0, 3_700))); } return new Promise(() => {}); } });
      return new Response(s, { status: 200, headers: { ...storedHeaders, "X-Lumi-Body-Length": "15298" } });
    });
    const started = Date.now();
    const r2 = await serveEdgeCached(req("/v1/trust/vendors?domain=api.jobsproperty-api.workers.dev"), produce, { cache, now, waitUntil, hitReadMs: 30 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r2.headers.get(EDGE_STATUS)).toBe("miss");
    expect((await r2.text()).length).toBe(15_298);
    expect(calls).toBe(2);
  });

  it("a rebuild that throws answers 503 + Retry-After, not an exception", async () => {
    const r = await serveEdgeCached(req("/v1/samples"), async () => { throw new Error("d1 down"); }, { cache: memCache(), now, waitUntil });
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("30");
  });
});
