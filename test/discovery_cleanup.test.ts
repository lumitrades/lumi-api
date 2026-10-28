import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { BAZAAR_ROUTES } from "../src/bazaar";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

// 2026-10-28 discovery cleanup: retired routes declare their retirement (RFC 8594 Sunset + Link), nothing retired is
// advertised, every discovery surface leads with the free trust check, and MCP tool text carries no prices.
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
function setup() {
  const fac = happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
  const get = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  return { app, get, fac };
}

// Every retired route that still sits in a discovery catalog or was ever listed, plus aliases.
const RETIRED = ["/v1/signal/xrp", "/v1/signal/XRP", "/v1/signals", "/v1/levels/xrp", "/v1/lite/xrp", "/v1/sentiment", "/v1/slate", "/v1/events", "/v1/events/next48h",
  "/v1/macro/yen", "/v1/scan", "/v1/brief", "/v1/coins", "/v1/market", "/v1/funding/btc", "/v1/fear-greed", "/v1/institutional"];
// The fixture clock (NOW) predates the retirement, so "past" is judged against the day this header first ships.
const SHIPS = Date.parse("2026-10-28T00:00:00Z");
const PAST = (v: string | null) => !!v && !Number.isNaN(Date.parse(v)) && Date.parse(v) < SHIPS;
const RETIRED_RE = /\/v1\/(signals?|lite|levels|scan|slate|brief|coins|market|macro\/yen|yen|sentiment|events|funding|fear[-_]?greed|institutional)\b/i;
const TRADING_RE = /strong (buy|sell)|buy\/sell|\bsignals?\b|trade ideas?|market ideas|price targets?|\bentry zone|\bleverage\b|crypto signals|paper trades?/i;

describe("retired routes declare their retirement", () => {
  it("410 with a past Sunset, a Deprecation date, a Link to the current routes and a short JSON body, with or without payment headers", async () => {
    const { get, fac } = setup();
    for (const p of RETIRED) {
      for (const h of [{}, { "PAYMENT-SIGNATURE": "eyJ4NDAyVmVyc2lvbiI6Mn0=" }, { "X-PAYMENT": "eyJ4NDAyVmVyc2lvbiI6MX0=" }] as Record<string, string>[]) {
        for (const method of ["GET", "HEAD", "POST"]) {
          const r = await get(p, { method, headers: h });
          expect(r.status, `${method} ${p}`).toBe(410);
          expect(r.headers.get("Sunset"), p).toBe("Sun, 25 Oct 2026 00:00:00 GMT");
          expect(PAST(r.headers.get("Sunset")), p).toBe(true);
          expect(r.headers.get("Deprecation"), p).toMatch(/^@\d+$/);
          const link = r.headers.get("Link") ?? "";
          expect(link, p).toContain(`<${BASE}/v1/trust/check>; rel="successor-version"`);
          expect(link, p).toContain(`<${BASE}/openapi.json>; rel="service-desc"`);
          expect(link, p).toContain('rel="sunset"');
          expect(r.headers.get("PAYMENT-REQUIRED"), p).toBeNull();
          if (method === "HEAD") continue;
          const text = await r.text();
          expect(text.length, p).toBeLessThan(2500);
          const b = JSON.parse(text);
          expect(b).toMatchObject({ error: "gone", status: 410, retired_on: "2026-10-25", sunset: "Sun, 25 Oct 2026 00:00:00 GMT", note: "Not charged." });
          expect(JSON.stringify(b.current_routes.trust_check)).toContain("/v1/trust/check");
        }
      }
    }
    expect(fac.calls.length).toBe(0);
  });

  it("the retired asksurf vendor report carries its own day (2026-10-26)", async () => {
    const { get } = setup();
    const r = await get("/v1/trust/vendors/asksurf/report", { headers: { "PAYMENT-SIGNATURE": "eyJ4NDAyVmVyc2lvbiI6Mn0=" } });
    expect(r.status).toBe(410);
    expect(r.headers.get("Sunset")).toBe("Mon, 26 Oct 2026 00:00:00 GMT");
    expect(r.headers.get("Link")).toContain('rel="successor-version"');
    expect((await r.json()).retired_on).toBe("2026-10-26");
  });

  it("live routes carry no Sunset header", async () => {
    const { get } = setup();
    for (const p of ["/v1/trust/check?url=https%3A%2F%2Fa.example%2Fx", "/v1/verdict?url=https%3A%2F%2Fa.example%2Fx", "/.well-known/x402"]) expect((await get(p)).headers.get("Sunset"), p).toBeNull();
  });
});

describe("discovery surfaces: no retired route, no trading copy, free trust check first", () => {
  it("no surface advertises a retired route or uses trading/signal wording", async () => {
    const { get } = setup();
    for (const p of ["/", "/.well-known/x402", "/openapi.json", "/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/.well-known/agents.json", "/llms.txt", "/skill.md", "/v1/samples"]) {
      const res = await get(p, { headers: p === "/" ? { Accept: "application/json" } : {} });
      expect(res.status, p).toBe(200);
      const text = await res.text();
      expect(text, p).not.toMatch(RETIRED_RE);
      expect(text, p).not.toMatch(TRADING_RE);
    }
    for (const r of Object.values(BAZAAR_ROUTES)) expect(r.description).not.toMatch(TRADING_RE);
  });

  it("each top-level description leads with the free trust check", async () => {
    const { get } = setup();
    const wk: any = await (await get("/.well-known/x402")).json();
    expect(wk.description).toMatch(/^Lumi Trades \(lumitrades\.io\), an x402 seller trust service: check an x402 seller before you pay\. Start with the free trust check/);
    expect(wk.description).not.toMatch(/, :/);
    const oa: any = await (await get("/openapi.json")).json();
    expect(oa.info.description).toMatch(/Start with the free trust check: GET \/v1\/trust\/check/);
    const card: any = await (await get("/.well-known/agent-card.json")).json();
    expect(card.description).toMatch(/start with the free trust check/);
    expect(card.description).not.toMatch(/financial advice/);
    const skill = await (await get("/skill.md")).text();
    expect(skill).toMatch(/description: Lumi Trades, an x402 seller trust service\. Check an x402 seller before you pay - start with the free GET \/v1\/trust\/check/);
    expect(skill.indexOf("## Start here: the free trust check")).toBeGreaterThan(0);
    expect(skill.indexOf("## Start here: the free trust check")).toBeLessThan(skill.indexOf("## Paid checks"));
    const sc: any = await (await get("/.well-known/mcp/server-card.json")).json();
    expect(sc.websiteUrl).toBe("https://lumitrades.io");
    expect(sc.repository.url).toBe("https://github.com/lumitrades/lumi-api");
  });

  it("remote MCP: trust check first; no prices in tool titles or descriptions", async () => {
    const { app } = setup();
    const r: any = await (await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }))).json();
    const tools = r.result.tools;
    expect(tools[0].name).toBe("lumi_trust_check");
    for (const t of tools) {
      expect(`${t.title} ${t.description}`, t.name).not.toMatch(/\$\s?\d|\d(\.\d+)?\s?%|\d+\s?(XRP|RLUSD|USDC)\b/);
      expect(`${t.title} ${t.description}`, t.name).not.toMatch(TRADING_RE);
    }
  });
});
