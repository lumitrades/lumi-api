import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrustStore, type ProbeRow } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { FACILITATOR, DATA, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json } from "./helpers";

const KEY = "k".repeat(20) + "0123456789abcdef0123456789abcdef";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  OWNER_MCP_KEY: KEY, EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532",
};
const BASE = "http://lumi.test";
const DAY = 86_400_000;
const PATH = "/v1/trust/vendors/heurist-mesh/report";
const BANNED = /\b(scam\w*|fraud\w*|untrustworthy|rip-?off|thie(f|ves)|steal\w*)\b/i;

function probes(vendor: string, days: number, every = 3_600_000): ProbeRow[] {
  const out: ProbeRow[] = [];
  for (let t = NOW - days * DAY; t <= NOW - 60_000; t += every) {
    const i = out.length;
    const recent = t > NOW - 7 * DAY;
    out.push({
      vendor_id: vendor, endpoint: "https://api.asksurf.ai/x402/test", ts: t, http_status: i % 10 === 0 ? 500 : 402, ok: i % 10 !== 0,
      price: i < 100 ? "0.001" : "0.002", asset: "RLUSD", pay_to: "rTest", source_tag: false, latency_ms: recent ? 900 : 300, error: i % 10 === 0 ? "HTTP 500" : null,
    });
  }
  return out;
}

function setup(opts: { now?: number; store?: MemoryTrustStore } = {}) {
  const fac = happyFacilitator();
  const store = opts.store ?? new MemoryTrustStore(SEED_OBSERVATIONS);
  const app = createApp(ENV, { fetch: makeFetch(fac), log: () => {}, now: () => opts.now ?? NOW, trustStore: store });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  let n = 0;
  const mcp = async (name: string, args: unknown = {}, headers: Record<string, string> = {}) => {
    const r = await app.fetch(new Request(BASE + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
    }));
    return (await r.json()).result;
  };
  const a2a = async (parts: unknown[]) => {
    const r = await app.fetch(new Request(BASE + "/a2a", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts } } }),
    }));
    return (await r.json()).result.message.parts;
  };
  return { get, mcp, a2a, fac, store };
}

describe("paid vendor report: x402 terms", () => {
  it("quotes $0.02 on every rail: 0.015 XRP, 0.02 RLUSD, 0.02 USDC (XRPL), 20000 USDC units on Base", async () => {
    const { get, fac } = setup();
    const r = await get(PATH);
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
    expect(body.resource.url).toBe(`${BASE}${PATH}`);
    expect(body.accepts.map((a: any) => [a.network, a.extra?.symbol ?? a.asset, a.amount])).toEqual([
      ["eip155:84532", "USDC", "20000"], ["xrpl:1", "XRP", "15000"], ["xrpl:1", "RLUSD", "0.02"], ["xrpl:1", "USDC", "0.02"],
    ]);
    expect(fac.calls).toHaveLength(0);
  });

  it("unknown vendor: 404 before any 402; stale (no observation in 48 h): 503 not charged", async () => {
    const { get } = setup();
    const u = await get("/v1/trust/vendors/nope/report");
    expect(u.status).toBe(404);
    expect(u.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(await u.json()).toMatchObject({ error: "unknown_vendor", note: "Not charged." });
    const late = setup({ now: NOW + 3 * DAY });
    const s = await late.get(PATH);
    expect(s.status).toBe(503);
    expect(s.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(await s.json()).toMatchObject({ error: "stale_data", note: "Not charged.", last_observed_at: expect.any(String) });
    // a vendor never observed at all
    expect((await setup().get("/v1/trust/vendors/monid/report")).status).toBe(503);
  });

  it("a paid call settles and returns the report with the payment receipt", async () => {
    const { get, fac } = setup();
    const q = await (await get(PATH)).json();
    const r = await get(PATH, { "PAYMENT-SIGNATURE": paymentHeaderFor(q.accepts[2]) });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.kind).toBe("trust_vendor_report");
    expect(b.payment).toMatchObject({ asset: "RLUSD", amount: "0.02" });
    expect(fac.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
  });

  it("owner bearer gets it free; a wrong bearer still gets the 402", async () => {
    const { get, fac } = setup();
    const r = await get(PATH, { Authorization: `Bearer ${KEY}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ kind: "trust_vendor_report", access: { mode: "owner", charged: false } });
    expect((await get(PATH, { Authorization: "Bearer wrong-key-wrong-key-wrong-key-wrong" })).status).toBe(402);
    expect(fac.calls).toHaveLength(0);
  });
});

describe("paid vendor report: content", () => {
  it("has the full history, stats, trend, labels and neutral wording", async () => {
    const store = new MemoryTrustStore(SEED_OBSERVATIONS);
    await store.addProbes(probes("heurist-mesh", 20));
    await store.addProbes(probes("heurist-mesh", 120).filter((p) => p.ts < NOW - 100 * DAY)); // beyond retention: excluded
    const { get } = setup({ store });
    const b = await (await get(PATH, { Authorization: `Bearer ${KEY}` })).json();
    expect(b).toMatchObject({ kind: "trust_vendor_report", id: "heurist-mesh", methodology: `${BASE}/v1/trust/methodology`, label: expect.stringContaining("not a rating") });
    expect(b.confidence_label).toMatch(/^LOW CONFIDENCE/);
    expect(b.score.confidence).toBe("low");
    const n = probes("heurist-mesh", 20).length;
    expect(b.quote_checks.rows).toHaveLength(n);
    expect(b.quote_checks.columns[0]).toBe("checked_at");
    expect(b.windows.map((w: any) => w.window)).toEqual(["24h", "7d", "30d", "90d"]);
    const w30 = b.windows.find((w: any) => w.window === "30d");
    expect(w30.probes).toBe(n);
    expect(w30.uptime_pct).toBeCloseTo(90, 0);
    expect(w30.quote_latency).toMatchObject({ min_ms: 300, max_ms: 900 });
    expect(b.trend.quote_latency).toMatchObject({ recent_median: 900, previous_median: 300, direction: "higher" });
    expect(b.paid_test_buys.count).toBe(1)  // heurist-mesh has one seeded test-buy (asksurf report retired 2026-10-26);
    expect(b.paid_test_buys.history[0]).toMatchObject({ tx_hash: expect.any(String), delivered: expect.stringMatching(/^(yes|no)$/), explorer: expect.stringContaining("http") });
    const ep = b.endpoints.find((e: any) => e.url === "https://api.asksurf.ai/x402/test");
    expect(ep.listed).toBe(false);
    expect(b.quote_checks.rows[0][1]).toBe(b.endpoints.indexOf(ep));
    expect(ep.quoted_price_history.map((p: any) => p.price)).toEqual(["0.001", "0.002"]);
    expect(ep.probe_results_without_valid_quote[0]).toMatchObject({ result: "HTTP 500" });
    expect(b.daily.length).toBeGreaterThan(19);
    expect(b.right_to_reply.email).toBe("hello@lumitrades.io");
    expect(JSON.stringify(b)).not.toMatch(BANNED);
  });

  it("leaves the free summary endpoints unchanged", async () => {
    const { get } = setup();
    const one = await get("/v1/trust/vendors/heurist-mesh");
    expect(one.status).toBe(200);
    const d = await one.json();
    expect(d.kind).toBe("trust_vendor");
    expect(d.quote_checks).toBeUndefined();
    expect((await get("/v1/trust/vendors")).status).toBe(200);
  });
});

describe("paid vendor report: docs, MCP and A2A", () => {
  it("is in the catalog, OpenAPI (with the id parameter) and skill.md", async () => {
    const { get } = setup();
    const idx = await (await get("/")).json();
    expect(idx.paid_endpoints.find((p: any) => p.path === "/v1/trust/vendors/{id}/report")).toMatchObject({ price_xrp: "0.015", price_drops: "15000", price_rlusd: "0.02", price_usdc: "0.02", price_base_usdc: "0.02" });
    const oa = await (await get("/openapi.json")).json();
    const op = oa.paths["/v1/trust/vendors/{id}/report"].get;
    expect(op.parameters[0]).toMatchObject({ name: "id", in: "path", required: true });
    expect(oa.paths["/v1/trust/vendors/{id}"]).toBeDefined();
    const skill = await (await get("/skill.md")).text();
    expect(skill).toContain("/v1/trust/vendors/{id}/report");
    expect(skill).toContain("lumi_vendor_report");
  });

  it("MCP: public gets price and how to pay; owner gets the report; vendor_id is required", async () => {
    const { mcp, fac } = setup();
    const pub = await mcp("lumi_vendor_report", { vendor_id: "heurist-mesh" });
    expect(pub.isError).toBe(true);
    expect(pub.content[0].text).toMatch(/0\.02 USDC on Base Sepolia, or 0\.015 XRP or 0\.02 RLUSD or 0\.02 USDC on the XRP Ledger/);
    expect(pub.content[0].text).toContain(`${BASE}${PATH}`);
    const own = await mcp("lumi_vendor_report", { vendor_id: "heurist-mesh" }, { Authorization: `Bearer ${KEY}` });
    expect(own.isError).toBeUndefined();
    expect(JSON.parse(own.content[0].text)).toMatchObject({ kind: "trust_vendor_report", access: { mode: "owner", charged: false } });
    expect((await mcp("lumi_vendor_report", {})).content[0].text).toContain("vendor_id");
    const unk = await mcp("lumi_vendor_report", { vendor_id: "nope" }, { Authorization: `Bearer ${KEY}` });
    expect(unk.isError).toBe(true);
    expect(fac.calls).toHaveLength(0);
  });

  it("A2A: vendor_report skill returns live terms for the vendor's report URL", async () => {
    const { a2a } = setup();
    const p = await a2a([{ text: "vendor report heurist-mesh" }]);
    expect(p[1].data.url).toBe(`${BASE}${PATH}`);
    expect(p[1].data.options.map((o: any) => o.amount)).toEqual(["0.02", "0.015", "0.02", "0.02"]);
    expect((await a2a([{ data: { skill: "vendor_report", vendor_id: "heurist-mesh" } }]))[1].data.url).toBe(`${BASE}${PATH}`);
    expect((await a2a([{ data: { skill: "vendor_report" } }]))[1].data.error).toBe("missing_vendor_id");
    expect((await a2a([{ text: "vendor trust scores" }]))[0].text).toMatch(/observations/);
  });
});
