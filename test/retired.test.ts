import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { BAZAAR_ROUTES } from "../src/bazaar";
import { PAID_TOOLS } from "../src/mcp";
import { RETIRED_TOOLS, RETIRED_SKILLS, isRetiredPath } from "../src/retired";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
function setup() {
  const fac = happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { app, get, fac };
}

const RETIRED = [
  "/v1/signal/XRP", "/v1/signal/btc", "/v1/signal/{coin}", "/v1/signal/%7Bcoin%7D", "/v1/signal/:coin", "/v1/signals",
  "/v1/lite/XRP", "/v1/lite/{coin}", "/v1/levels/XRP", "/v1/levels/{coin}", "/v1/levels/",
  "/v1/scan", "/v1/slate", "/v1/slate/", "/v1/brief", "/v1/brief?format=md", "/v1/coins", "/v1/trades", "/V1/SIGNAL/XRP",
  "/v1/market", "/v1/market/", "/V1/MARKET", "/v1/macro/yen", "/v1/macro/yen/", "/v1/sentiment", "/v1/events", "/v1/events/",
  "/v1/events/next48h", "/v1/events/next48h/", "/v1/Events/Next48h",
  // v1.2.0 (trust-only): market data and the policy brief, with their aliases
  "/v1/funding", "/v1/funding/", "/v1/funding/BTC", "/V1/FUNDING", "/v1/fear-greed", "/v1/fear-greed/", "/v1/fear_greed", "/v1/feargreed",
  "/v1/fear-greed?format=md", "/v1/Fear-Greed", "/v1/institutional", "/v1/institutional/", "/v1/institutional?format=md", "/v1/institutional/brief", "/V1/INSTITUTIONAL",
];
// An oversized but syntactically plausible header must not turn a 410 into a 431/402 either.
const PAY_HEADERS = [
  {},
  { "PAYMENT-SIGNATURE": "eyJ4NDAyVmVyc2lvbiI6Mn0=" },
  { "X-PAYMENT": "eyJ4NDAyVmVyc2lvbiI6MX0=" },
  { "PAYMENT-SIGNATURE": "A".repeat(40_000) },
  { "X-Lumi-Trial": "1" },
];

describe("retired trading routes (2026-10-25)", () => {
  it("answer 410 Gone with JSON pointing to /v1/check, never a 402, with or without payment headers", async () => {
    const { get, fac } = setup();
    for (const p of RETIRED) {
      for (const h of PAY_HEADERS) {
        const r = await get(p, h as Record<string, string>);
        expect(r.status, `${p} ${Object.keys(h)}`).toBe(410);
        expect(r.headers.get("PAYMENT-REQUIRED"), p).toBeNull();
        expect(r.headers.get("PAYMENT-RESPONSE"), p).toBeNull();
        const b: any = await r.json();
        expect(b.error).toBe("gone");
        expect(b.use).toBe(`${BASE}/v1/check`);
        expect(b.note).toBe("Not charged.");
        expect(JSON.stringify(b)).not.toMatch(/accepts|x402Version/);
      }
    }
    expect(fac.calls.length).toBe(0);
  });

  it("HEAD and POST also get 410; OPTIONS still answers CORS preflight", async () => {
    const { app } = setup();
    expect((await app.fetch(new Request(BASE + "/v1/slate", { method: "HEAD" }))).status).toBe(410);
    expect((await app.fetch(new Request(BASE + "/v1/signal/XRP", { method: "POST" }))).status).toBe(410);
    expect((await app.fetch(new Request(BASE + "/v1/slate", { method: "OPTIONS" }))).status).not.toBe(410);
  });

  it("live routes are not caught by the retired matcher", () => {
    for (const p of ["/v1/check", "/v1/trust/check", "/v1/trust/vendors/x/report", "/v1/verdict", "/v1/trust/vendors", "/v1/samples", "/v1/check/keys", "/v1/fundingx", "/v1/institutionalize", "/v1/marketplace", "/v1/macro", "/v1/events/other", "/v1/monitor/packs"])
      expect(isRetiredPath(p), p).toBe(false);
  });

  it("are gone from well-known, OpenAPI, the root list, llms.txt, skill.md, the agent card, MCP, samples, bazaar and sitemap", async () => {
    const { get } = setup();
    const re = /\/v1\/(signal|lite|levels|scan|slate|brief|coins|market|macro\/yen|sentiment|events|funding|fear[-_]?greed|institutional)\b/;
    const wk: any = await (await get("/.well-known/x402")).json();
    for (const r of wk.resources ?? []) expect(String(r), "well-known").not.toMatch(re);
    const oa: any = await (await get("/openapi.json")).json();
    for (const p of Object.keys(oa.paths)) expect(p, "openapi").not.toMatch(re);
    const idx: any = await (await get("/", { Accept: "application/json" })).json();
    for (const e of [...(idx.endpoints ?? []), ...(idx.free_endpoints ?? [])]) expect(e.path, "root").not.toMatch(re);
    const card: any = await (await get("/.well-known/agent-card.json")).json();
    for (const s of card.skills) expect(RETIRED_SKILLS, s.id).not.toContain(s.id);
    for (const t of PAID_TOOLS) expect(RETIRED_TOOLS, t.name).not.toContain(t.name);
    for (const r of Object.keys(BAZAAR_ROUTES)) expect(RETIRED_SKILLS).not.toContain(r);
    const samples: any = await (await get("/v1/samples")).json();
    expect(JSON.stringify(samples)).not.toMatch(re);
    const sm = await get("/sitemap.xml");
    if (sm.status === 200) expect(await sm.text()).not.toMatch(re);
    // skill.md and llms.txt mention the retired paths only in the retirement notice.
    for (const p of ["/skill.md", "/llms.txt"]) {
      const res = await get(p);
      if (res.status !== 200) continue;
      for (const line of (await res.text()).split("\n")) if (re.test(line)) expect(line, p).toMatch(/retired|410/i);
    }
  });

  it("MCP: retired tools are not listed and a call to one says gone, not charged", async () => {
    const { app } = setup();
    const rpc = (method: string, params: unknown) => app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).then((r) => r.json() as any);
    const list = await rpc("tools/list", {});
    const names = list.result.tools.map((t: any) => t.name);
    for (const t of RETIRED_TOOLS) expect(names).not.toContain(t);
    for (const t of RETIRED_TOOLS) {
      const r = await rpc("tools/call", { name: t, arguments: { coin: "XRP" } });
      expect(r.result.isError, t).toBe(true);
      const body = JSON.parse(r.result.content[0].text);
      expect(body.error, t).toBe("gone");
      expect(body.note).toBe("Not charged.");
    }
  });

  it("A2A: a retired skill answers gone, with no x402 terms", async () => {
    const { app } = setup();
    for (const skill of RETIRED_SKILLS) {
      const r: any = await (await app.fetch(new Request(BASE + "/a2a", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "data", data: { skill, coin: "XRP" } }] } } }) }))).json();
      const s = JSON.stringify(r);
      expect(s, skill).toMatch(/gone/);
      expect(s, skill).not.toMatch(/"accepts"/);
    }
  });

  it("the cron no longer recomputes per-coin readings", async () => {
    const { app } = setup();
    const r: any = await app.liveRefresh();
    expect(r.skipped ?? r.feed).toBeTruthy();
  });

  it("v1.2.0: a valid-looking payment built from an old market-data quote never settles", async () => {
    const { get, fac } = setup();
    // the last sold quote shape for /v1/fear-greed (an XRPL payment); the route is gone, so nothing is verified or settled
    const q = await get("/v1/verdict?url=https%3A%2F%2Fa.example%2Fx");
    const req = (await q.json()).accepts[0];
    for (const p of ["/v1/funding", "/v1/fear-greed", "/v1/institutional"]) {
      const r = await get(p, { "PAYMENT-SIGNATURE": paymentHeaderFor({ ...req, resource: BASE + p }) });
      expect(r.status, p).toBe(410);
    }
    expect(fac.calls.length).toBe(0);
  });

  it("v1.2.0: retired routes are absent from every manifest, also as Bazaar routes and MCP/A2A names", async () => {
    const { get } = setup();
    const re = /\/v1\/(funding|fear[-_]?greed|institutional)\b|lumi_(funding|fear_greed|institutional_brief)|fear (and|&) greed|funding rates|institutional (&|and) policy/i;
    for (const p of ["/", "/.well-known/x402", "/openapi.json", "/.well-known/agent-card.json", "/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/agents.json", "/v1/samples", "/skill.md", "/llms.txt", "/catalog", "/sitemap.xml"]) {
      const res = await get(p);
      if (res.status === 404) continue;
      expect(res.status, p).toBe(200);
      const text = await res.text();
      for (const line of text.split(/\n|(?<=[,}])/)) if (re.test(line)) expect(line, p).toMatch(/retired|410|gone/i);
    }
    for (const r of Object.keys(BAZAAR_ROUTES)) expect(r).not.toMatch(/funding|fear|institutional/);
    for (const t of PAID_TOOLS) expect(t.name).not.toMatch(/funding|fear|institutional/);
  });
});
