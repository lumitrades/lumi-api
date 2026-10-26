import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { toListing, normalizeUrl, normalizeDomain, registrableDomain, MemoryCatalogStore, probeRow, LABELS, INGEST_PAGE, INGEST_PASS_RUNS } from "../src/trust/catalog";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52) };
const BASE = "http://lumi.test";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0xAbCdEf0000000000000000000000000000000001";
const BUYER = "0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const item = (i: number, extra: Record<string, unknown> = {}) => ({
  resource: `https://API.Seller${i % 2}.com/v1/thing/${i}`,
  type: "http",
  description: `thing ${i}`,
  serviceName: `Seller ${i % 2}`,
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: SELLER }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 100 - i, l30DaysUniquePayers: 3 },
  lastUpdated: new Date().toISOString(),
  ...extra,
});
const ITEMS = [item(1), item(2), item(3), { ...item(4), type: "mcp" }];

function b64(o: unknown) {
  return btoa(JSON.stringify(o));
}

function catalogFetch(base: typeof fetch, calls: string[] = []): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources")) {
      const u = new URL(url);
      // like CDP: limit forced to 30, offset snapped down to a multiple of 30
      const lim = 30, off = Math.floor(Number(u.searchParams.get("offset")) / 30) * 30;
      return new Response(JSON.stringify({ items: ITEMS.slice(off, off + lim), pagination: { limit: lim, offset: off, total: ITEMS.length } }), { headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://api.seller0.com/")) {
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [{ network: "eip155:8453", asset: USDC, amount: "10000", payTo: SELLER }] }) } });
    }
    if (url.startsWith("https://api.seller1.com/")) return new Response("ok", { status: 200 });
    if (url.startsWith("https://rdap.org/domain/")) return new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }] }));
    if (url === "https://base.rpc.test/") {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_getTransactionReceipt")
        return new Response(JSON.stringify({ result: { status: "0x1", blockNumber: "0x10", logs: [{ address: USDC, topics: [TOPIC, "0x" + "0".repeat(24) + BUYER.slice(2), "0x" + "0".repeat(24) + SELLER.slice(2)], data: "0x" + (10000).toString(16) }] } }));
      return new Response(JSON.stringify({ result: { timestamp: "0x" + Math.floor(NOW / 1000).toString(16) } }));
    }
    return base(input, init);
  }) as typeof fetch;
}

function mkApp(store = new MemoryCatalogStore(), calls: string[] = [], now = NOW) {
  const app = createApp({ ...ENV, BASE_RPC_URL: "https://base.rpc.test/" } as any, { fetch: catalogFetch(makeFetch(happyFacilitator()), calls), now: () => now, catalogStore: store });
  return { app, store };
}
const get = (app: any, path: string) => app.fetch(new Request(BASE + path)).then(async (r: Response) => ({ status: r.status, body: await r.json() as any }));
const owner = { Authorization: "Bearer " + "k".repeat(52), "Content-Type": "application/json" };

describe("catalog parsing", () => {
  it("normalizes urls, domains and registrable domains", () => {
    expect(normalizeUrl("https://API.X.com/a/")).toBe("https://api.x.com/a");
    expect(normalizeUrl("ftp://x")).toBeNull();
    expect(normalizeDomain("https://www.Example.com/x")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("foo.workers.dev")).toBe("foo.workers.dev");
    expect(registrableDomain("api.seller.com")).toBe("seller.com");
  });
  it("toListing: lowercased payTo, USD price, MCP method, signature ignores quality", () => {
    const l = toListing(item(1))!;
    expect(l.domain).toBe("api.seller1.com");
    expect(l.pay_tos).toEqual([SELLER.toLowerCase()]);
    expect(l.price_usd).toBe("0.01");
    expect(toListing({ ...item(1), type: "mcp" })!.method).toBe("MCP");
    expect(toListing({ ...item(1), quality: { l30DaysTotalCalls: 5 } })!.sig).toBe(l.sig);
    expect(toListing({ resource: "nope" })).toBeNull();
  });
  it("probeRow: valid quote with matching payTo and price; non-402 is not valid", async () => {
    const s = new MemoryCatalogStore();
    await s.upsert([toListing(item(2))!, toListing(item(1))!], NOW);
    const f = catalogFetch(fetch);
    const ok = await probeRow(f, s.rows[0], NOW);
    expect(ok).toMatchObject({ valid: true, pay_to_match: true, price_match: true, price_usd: "0.01", status: 402, hist: "1" });
    const bad = await probeRow(f, s.rows[1], NOW);
    expect(bad).toMatchObject({ valid: false, status: 200, hist: "0" });
    expect(bad.error).toContain("HTTP 200");
  });
});

describe("catalog pipeline", () => {
  it("owner ingest (inline without a queue), cron probes, lookups by url/domain/payTo", async () => {
    const calls: string[] = [];
    const { app, store } = mkApp(new MemoryCatalogStore(), calls);
    expect((await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST" }))).status).toBe(401);
    const r = await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST", headers: owner }));
    expect(r.status).toBe(200);
    expect(store.rows).toHaveLength(4);
    await app.scheduled();
    expect(store.rows.filter((x) => x.probe_ts != null)).toHaveLength(3); // MCP entry not probed
    expect(calls.some((c) => c.startsWith("https://rdap.org/domain/seller0.com"))).toBe(true);

    const byUrl = await get(app, "/v1/trust/vendors?url=" + encodeURIComponent("https://api.seller0.com/v1/thing/2"));
    expect(byUrl.status).toBe(200);
    expect(byUrl.body.observed).toBe(true);
    expect(byUrl.body.catalog.entries[0].tier).toBe(LABELS.quote_verified);
    expect(byUrl.body.catalog.entries[0].last_quote_check).toMatchObject({ valid_quote: true, pays_listed_address: true });
    expect(byUrl.body.catalog.entries[0].domain_age).toBeUndefined(); // free lookup is answer-only
    expect(byUrl.body.evidence.paid).toContain("/v1/trust/check?url=");
    const byDom = await get(app, "/v1/trust/vendors?domain=seller1.com");
    expect(byDom.body.catalog.total_matches).toBe(2);
    expect(byDom.body.catalog.entries[0].tier).toBe(LABELS.quote_failed);
    const byPay = await get(app, "/v1/trust/vendors?payTo=" + SELLER.toUpperCase().replace("0X", "0x"));
    expect(byPay.body.catalog.total_matches).toBe(4);
    const none = await get(app, "/v1/trust/vendors?domain=unknown.example");
    expect(none.body).toMatchObject({ observed: false });
    expect(none.body.note).toContain("not a negative finding");
    expect(JSON.stringify([byUrl, byDom, byPay, none])).not.toMatch(/\bscam\b/i);
  });

  it("self entry is 'self, not scored'", async () => {
    const { app } = mkApp();
    const r = await get(app, "/v1/trust/vendors?domain=api.lumitrades.io");
    expect(r.body.self.label).toBe("self, not scored");
    const p = await get(app, "/v1/trust/vendors?payTo=" + PAY_TO);
    expect(p.body.self.label).toBe("self, not scored");
    const list = await get(app, "/v1/trust/vendors");
    expect(list.body.self.label).toBe("self, not scored");
    expect(list.body.catalog.lookup).toContain("payTo");
  });

  it("owner observation: verified on Base, from a Lumi buyer to a listed payTo -> test-bought", async () => {
    const { app, store } = mkApp();
    await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST", headers: owner }));
    const body = { resource: "https://api.seller0.com/v1/thing/2", network: "eip155:8453", tx_hash: "0x" + "a".repeat(64), data_returned: true, http_status: 200, summary: "returned JSON with 3 fields", facilitator: "cdp" };
    const post = (b: unknown) => app.fetch(new Request(BASE + "/v1/trust/catalog/observations", { method: "POST", headers: owner, body: JSON.stringify(b) }));
    expect((await post({ ...body, summary: "total scam" })).status).toBe(400);
    expect((await post({ ...body, resource: "https://nope.example/x" })).status).toBe(404);
    const r = await post(body);
    expect(r.status).toBe(201);
    expect((await post(body)).status).toBe(200);
    expect(store.buys).toHaveLength(1);
    const look = await get(app, "/v1/trust/vendors?url=" + encodeURIComponent(body.resource));
    expect(look.body.catalog.entries[0].tier).toBe("test-bought");
    expect(look.body.catalog.entries[0].test_buys).toMatchObject({ count: 1, last_data_returned: true });
    expect(JSON.stringify(look.body)).not.toMatch(/0xa{64}|basescan|"tx_hash"|"explorer"/);
    const pop = await get(app, "/v1/trust/catalog?popular=1&max_usd=0.05");
    expect(pop.body.entries.length).toBe(3);
  });

  it("cron schedules probe jobs on a queue and the consumer processes them", async () => {
    const sent: any[] = [];
    const store = new MemoryCatalogStore();
    await store.upsert(ITEMS.map(toListing).filter(Boolean) as any, NOW);
    const app = createApp(ENV as any, { fetch: catalogFetch(makeFetch(happyFacilitator())), now: () => NOW, catalogStore: store, queue: { sendBatch: async (m) => { sent.push(...m); } } });
    await app.scheduled();
    expect(sent.map((m: any) => m.body).filter((b: any) => b.kind === "ingest" || b.kind === "probe")).toEqual([{ kind: "ingest", offset: 0 }, { kind: "probe", after: 0 }]);
    expect(await store.getMeta("ingest_cursor")).toBe(String(INGEST_PAGE));
    expect(store.rows.every((r) => r.probe_ts == null)).toBe(true);
    await app.queue(sent[1].body);
    expect(store.rows.filter((r) => r.probe_ts != null)).toHaveLength(3);
    expect(await store.getMeta("probe_cursor")).toBe("36");
    expect(Number(await store.getMeta("writes:2026-10-22"))).toBeGreaterThan(0);
  });

  it("daily D1 write budget: jobs are skipped once it is used up", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert(ITEMS.map(toListing).filter(Boolean) as any, NOW);
    await store.setMeta("writes:2026-10-22", "200000");
    const app = createApp(ENV as any, { fetch: catalogFetch(makeFetch(happyFacilitator())), now: () => NOW, catalogStore: store, queue: { sendBatch: async () => {} } });
    expect(await app.queue({ kind: "probe", after: 0 })).toEqual({ skipped: "daily write budget" });
    expect(await app.queue({ kind: "ingest", offset: 0 })).toEqual({ skipped: "daily write budget" });
    expect(store.rows.every((r) => r.probe_ts == null)).toBe(true);
  });
});

describe("lookup via MCP and A2A", () => {
  it("lumi_vendor_scores takes url/domain/payTo; A2A vendor_trust takes data.payTo", async () => {
    const { app } = mkApp();
    await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST", headers: owner }));
    const mcp = await app.fetch(new Request(BASE + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lumi_vendor_scores", arguments: { domain: "seller0.com" } } }),
    }));
    const doc = JSON.parse(((await mcp.json()) as any).result.content[0].text);
    expect(doc).toMatchObject({ kind: "trust_lookup", observed: true });
    const tools = await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }));
    const t = ((await tools.json()) as any).result.tools.find((x: any) => x.name === "lumi_vendor_scores");
    expect(Object.keys(t.inputSchema.properties)).toEqual(["url", "domain", "payTo", "vendor_id"]);
    const a2a = await app.fetch(new Request(BASE + "/a2a", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "a", method: "message/send", params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "data", data: { payTo: SELLER.toLowerCase() } }] } } }),
    }));
    const s = JSON.stringify(await a2a.json());
    expect(s).toContain("trust_lookup");
    expect(s).toContain("catalog match");
  });
});

describe("ingest paging", () => {
  it("INGEST_PAGE-aligned offsets read every entry when CDP snaps offsets down to a multiple of the limit", () => {
    const total = 75799, seen = new Set<number>();
    for (let o = 0; o < total + INGEST_PAGE; o += INGEST_PAGE) {
      const snapped = Math.floor(o / INGEST_PAGE) * INGEST_PAGE;
      for (let i = snapped; i < Math.min(total, snapped + INGEST_PAGE); i++) seen.add(i);
    }
    expect(seen.size).toBe(total);
    expect(INGEST_PAGE).toBeLessThanOrEqual(1000);
    // a full pass fits in INGEST_PASS_RUNS cron runs (every 30 min)
    expect(Math.ceil(total / INGEST_PAGE / INGEST_PASS_RUNS) * INGEST_PASS_RUNS * INGEST_PAGE).toBeGreaterThanOrEqual(total);
  });
});

describe("external free directories (ext:* sources)", () => {
  const ext = (resource: string, payTo?: string, amount = "10000") => ({
    resource, description: "ext item", accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount, ...(payTo ? { payTo } : {}) }],
  });
  it("an ext source adds new rows but never overwrites a CDP row; CDP takes over an ext row", async () => {
    const store = new MemoryCatalogStore();
    await store.upsert([toListing(ext("https://cdp.example.org/a", "0x" + "1".repeat(40)))!], NOW);
    expect(await store.upsert([toListing(ext("https://cdp.example.org/a", "0x" + "2".repeat(40), "20000"))!], NOW + 1000, "ext:payai")).toBe(0);
    expect(store.rows[0].pay_tos).toBe("0x" + "1".repeat(40));
    expect(store.rows[0].source).toBe("cdp_bazaar");
    expect(await store.upsert([toListing(ext("https://new.example.org/b", "0x" + "3".repeat(40)))!], NOW, "ext:thirdweb")).toBe(1);
    expect(store.rows[1].source).toBe("ext:thirdweb");
    expect(await store.upsert([toListing(ext("https://new.example.org/b", "0x" + "3".repeat(40)))!], NOW + 1000)).toBe(1);
    expect(store.rows[1].source).toBe("cdp_bazaar");
  });
  it("POST /v1/trust/catalog/external is owner-only, checks the source, drops lumitrades.io", async () => {
    const store = new MemoryCatalogStore();
    const app = createApp(ENV as any, { fetch: catalogFetch(makeFetch(happyFacilitator())), now: () => NOW, catalogStore: store, queue: { sendBatch: async () => {} } });
    const body = { source: "ext:402index", items: [ext("https://svc.example.net/x"), ext("https://api.lumitrades.io/v1/x")] };
    const call = (b: unknown, h: Record<string, string> = owner) => app.fetch(new Request(BASE + "/v1/trust/catalog/external", { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(b) }));
    expect((await call(body, {})).status).toBe(401);
    expect((await call({ ...body, source: "x402scan" })).status).toBe(400);
    const r = await call(body);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, received: 2, valid: 1, written: 1 });
    expect(store.rows.map((x) => [x.domain, x.source])).toEqual([["svc.example.net", "ext:402index"]]);
  });
  it("a listing without a payTo gets no pay-to signal from a quote check", async () => {
    const row: any = { id: 1, resource: "https://svc.example.net/x", domain: "svc.example.net", method: "GET", body: null, pay_tos: "", price_usd: "0.01" };
    const f = async () => new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000", payTo: "0x" + "4".repeat(40) }] }), { status: 402, headers: { "Content-Type": "application/json" } });
    const p = await probeRow(f as any, row, NOW);
    expect(p.valid).toBe(true);
    expect(p.pay_to_match).toBeNull();
    expect(p.error).toBeNull();
  });
});

describe("free catalog teaser (v1.0.1)", () => {
  function bigStore(n: number) {
    const store = new MemoryCatalogStore();
    const ls = Array.from({ length: n }, (_, i) =>
      toListing({
        resource: `https://api.seller${i}.com/v1/x`, type: "http",
        accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000", payTo: "0x" + String(i).padStart(40, "1") }],
        metadata: { calls30d: i },
      })!,
    );
    store.upsert(ls, NOW);
    for (const [i, r] of store.rows.entries()) Object.assign(r, { calls_30d: i, probe_ts: NOW - 1000, probe_valid: 1, probe_status: 402, probe_pay_to_match: 1, probe_price_match: 1 });
    store.buys.push({ resource: store.rows[n - 1].resource, domain: store.rows[n - 1].domain, ts: NOW - 5000, network: "eip155:8453", tx_hash: "0x" + "b".repeat(64), amount: "0.01", asset: "USDC", pay_to: "0x1", facilitator: "cdp", http_status: 200, data_returned: true, latency_ms: 300, summary: "ok" });
    // Stale stats from long ago: the summary must be recomputed, not served as-is.
    store.meta.set("stats", JSON.stringify({ catalogued: 1, active: 1, quote_checked: 1, quote_checked_24h: 1, quote_verified: 1, purchase_verified: 0, test_buys: 0, domains: 1, computed_at: NOW - 10 * 3_600_000 }));
    return store;
  }
  const getIp = (app: any, path: string, ip: string) => app.fetch(new Request(BASE + path, { headers: { "CF-Connecting-IP": ip } })).then(async (r: Response) => ({ status: r.status, body: await r.json() as any }));

  it("serves only the top 100 most-used, 25 per page, answer-only, with fresh counts", async () => {
    const { app } = mkApp(bigStore(150));
    const p1 = await getIp(app, "/v1/trust/catalog?limit=500", "203.0.113.1");
    expect(p1.status).toBe(200);
    expect(p1.body.entries).toHaveLength(25);
    expect(p1.body.entries[0].resource).toBe("https://api.seller149.com/v1/x"); // most-used first
    expect(p1.body.entries[0].test_buys).toMatchObject({ count: 1, last_data_returned: true });
    expect(JSON.stringify(p1.body)).not.toMatch(/b{64}|basescan|"tx_hash"|"explorer"|"purchases"|median_latency/);
    expect(p1.body.next).toContain("page=2");
    expect(p1.body.summary.counts).toMatchObject({ catalogued: 150, quote_verified: 150, purchase_verified: 1 });
    const p4 = await getIp(app, "/v1/trust/catalog?page=4", "203.0.113.1");
    expect(p4.body.entries).toHaveLength(25);
    expect(p4.body.next).toBeNull();
    const p5 = await getIp(app, "/v1/trust/catalog?page=5", "203.0.113.1");
    expect(p5.body.entries).toHaveLength(0);
    expect(p5.body.free_tier.beyond_free_pages).toBeTruthy();
    const after = await getIp(app, "/v1/trust/catalog?after=100&limit=100", "203.0.113.1");
    expect(after.body.free_tier.ignored).toMatch(/after=/);
    expect(after.body.entries[0].resource).toBe("https://api.seller149.com/v1/x");
    const seen = new Set<string>();
    for (const page of [1, 2, 3, 4, 5, 6]) (await getIp(app, `/v1/trust/catalog?page=${page}`, "203.0.113.2")).body.entries.forEach((e: any) => seen.add(e.resource));
    expect(seen.size).toBe(100); // full paging of 150 is not possible
  });

  it("rate-limits free catalog browsing per hashed IP per day; lookups stay free", async () => {
    const { app } = mkApp(bigStore(30));
    const codes: number[] = [];
    let t = NOW;
    const app2 = createApp({ ...ENV, BASE_RPC_URL: "https://base.rpc.test/" } as any, { fetch: catalogFetch(makeFetch(happyFacilitator()), []), now: () => (t += 61_000), catalogStore: bigStore(30) });
    for (let i = 0; i < 42; i++) codes.push((await getIp(app2, "/v1/trust/catalog", "198.51.100.7")).status);
    expect(codes.slice(0, 40).every((c) => c === 200)).toBe(true);
    expect(codes[40]).toBe(429);
    expect((await getIp(app2, "/v1/trust/catalog", "198.51.100.8")).status).toBe(200); // other client unaffected
    const look = await getIp(app, "/v1/trust/vendors?url=" + encodeURIComponent("https://api.seller3.com/v1/x"), "198.51.100.7");
    expect(look.status).toBe(200);
    expect(look.body.catalog.entries[0]).toMatchObject({ tier: LABELS.quote_verified, last_quote_check: { valid_quote: true } });
    const burst: number[] = [];
    for (let i = 0; i < 31; i++) burst.push((await getIp(app, "/v1/trust/vendors?domain=api.seller3.com", "198.51.100.9")).status);
    expect(burst[30]).toBe(429);
  });
});

describe("test-bought split by chain", () => {
  it("counts Base catalog buys and curated XRPL buys separately; XRPL rows answer-only when free", async () => {
    const { app } = mkApp();
    await app.fetch(new Request(BASE + "/v1/trust/catalog/ingest?now=1", { method: "POST", headers: owner }));
    await app.fetch(new Request(BASE + "/v1/trust/catalog/observations", { method: "POST", headers: owner, body: JSON.stringify({ resource: "https://api.seller0.com/v1/thing/2", network: "eip155:8453", tx_hash: "0x" + "c".repeat(64), data_returned: true, http_status: 200, summary: "ok", facilitator: "cdp" }) }));
    const cat = await get(app, "/v1/trust/catalog?page=1");
    const split = cat.body.summary.purchase_verified_by_chain;
    expect(split.base_usdc).toMatchObject({ network: "eip155:8453", purchase_verified_resources: 1, test_buys: 1 });
    expect(split.xrpl.network).toBe("xrpl:0");
    expect(split.xrpl.test_buys).toBeGreaterThan(0);
    expect(split.xrpl.purchase_verified_endpoints).toBeGreaterThan(0);
    expect(cat.body.summary.coverage).toMatch(/1 test-bought on Base \(USDC\).*separately, \d+ XRPL endpoints/);
    const look = await get(app, "/v1/trust/vendors?domain=asksurf.ai");
    const cur = look.body.curated[0];
    expect(cur).toMatchObject({ id: "asksurf", network: "xrpl:0", tier: "test-bought (XRPL, curated list)" });
    expect(cur.xrpl_test_buys.count).toBeGreaterThan(0);
    expect(cur.purchases).toBeUndefined();
    expect(JSON.stringify(look.body)).not.toMatch(/"tx_hash"|"explorer"/);
  });
});
