import { describe, it, expect } from "vitest";
import { createApp, ensureFreshness } from "../src/app";
import { BAZAAR_ROUTES, VENDOR_ID_PATTERN } from "../src/bazaar";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
function setup() {
  const fac = happyFacilitator();
  const app = createApp(ENV, { fetch: makeFetch(fac), log: () => {}, now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  const post = (path: string, body: unknown) => app.fetch(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }));
  return { get, post, fac };
}

describe("v1.1.1 discovery files", () => {
  it("serves an MCP Server Card and agents.json on the API host", async () => {
    const { get } = setup();
    for (const p of ["/.well-known/mcp/server-card.json", "/.well-known/mcp.json"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      const c = await r.json();
      expect(c).toMatchObject({ name: "io.github.cypher-osiris/lumi-trades-mcp", version: "1.1.7", remotes: [{ type: "streamable-http", url: `${BASE}/mcp` }] });
      expect(c.$schema).toMatch(/server-card/);
      expect(c.description).toMatch(/^Lumi Trades/);
    }
    const a = await (await get("/.well-known/agents.json")).json();
    expect(a).toMatchObject({ agentsJson: "0.1.0", sources: [{ id: "lumi", path: `${BASE}/openapi.json` }] });
    expect(a.flows[0].id).toBe("trust_check_flow");
    const oa = await (await get("/openapi.json")).json();
    const ops = new Set(Object.values(oa.paths).flatMap((m: any) => Object.values(m).map((o: any) => o.operationId)));
    for (const f of a.flows) for (const act of f.actions) expect(ops.has(act.operationId), act.operationId).toBe(true);
    const sm = await (await get("/sitemap.xml")).text();
    expect(sm).toContain("/.well-known/mcp/server-card.json");
    expect(sm).toContain("/.well-known/agents.json");
  });

  it("agent card leads with the trust check and advertises signed receipts; /.well-known/x402 attestation is signed-receipts", async () => {
    const { get } = setup();
    const card = await (await get("/.well-known/agent-card.json")).json();
    expect(card.description).toMatch(/^Should I pay this x402 URL\?/);
    expect(card.skills[0].id).toBe("trust_check");
    expect(card.capabilities.extensions[0].params.attestation.type).toBe("signed-receipts");
    const wk = await (await get("/.well-known/x402")).json();
    expect(wk.attestation.type).toBe("signed-receipts");
    expect(wk.attestation.verify).toBe(`${BASE}/v1/trust/receipts/verify`);
  });

  it("MCP tool descriptions carry no repeated boilerplate; the shared note is in the server instructions", async () => {
    const { post } = setup();
    const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const init = await r.json();
    expect(init.result.instructions).toMatch(/Never charged when data is stale/);
    const t = await (await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json();
    for (const tool of t.result.tools) expect(tool.description, tool.name).not.toContain("On this remote MCP server");
  });
});

describe("v1.1.1 policies and metadata", () => {
  it("feed licence and monitoring terms are final (no draft marker) and state the agreed terms", async () => {
    const { get } = setup();
    const J = { Accept: "application/json" };
    const lic = await (await get("/v1/feed/license", J)).json();
    const mon = await (await get("/v1/monitor", J)).json();
    const all = JSON.stringify(lic) + JSON.stringify(mon);
    expect(all).not.toMatch(/draft/i);
    expect(JSON.stringify(lic)).toMatch(/never expire/i);
    expect(JSON.stringify(lic)).toMatch(/attribution/i);
    expect(JSON.stringify(lic)).toMatch(/resale|redistribut/i);
    expect(JSON.stringify(mon)).toMatch(/report_hash and Lumi.s signature/i);
    expect(JSON.stringify(mon)).toMatch(/refund/i);
  });

  it("every route is listed as 'Lumi Trades'; trust check declares url required in Bazaar; no 'Crypto crypto'", async () => {
    const { get } = setup();
    const t = await (await get("/v1/trust/check")).json();
    expect(t.resource.serviceName).toBe("Lumi Trades");
    expect(t.extensions.bazaar.info.input.queryParams?.url ?? t.extensions.bazaar.info.input.queryParams).toBeTruthy();
    expect(JSON.stringify(t.extensions.bazaar.schema)).toContain('"required":["url"]');
    const s = await (await get("/v1/signal/xrp")).json();
    expect(s.resource.serviceName).toBe("Lumi Trades");
    for (const p of ["/v1/signal/btc", "/v1/lite/btc", "/v1/levels/btc", "/v1/scan"]) expect(JSON.stringify(await (await get(p)).json()), p).not.toMatch(/crypto crypto/i);
    for (const r of Object.values(BAZAAR_ROUTES)) expect(r.description.length).toBeLessThanOrEqual(500);
  });

  it("coins are case-insensitive (same quote) and the vendor-id pattern matches openapi", async () => {
    const { get } = setup();
    const strip = (b: any) => b.accepts.map((a: any) => [a.network, a.amount, a.payTo]);
    expect(strip(await (await get("/v1/signal/xrp")).json())).toEqual(strip(await (await get("/v1/signal/XRP")).json()));
    const oa = await (await get("/openapi.json")).json();
    expect(oa.paths["/v1/trust/vendors/{id}/report"].get.parameters[0].schema.pattern).toBe(VENDOR_ID_PATTERN);
    const r = await (await get("/v1/trust/vendors/%7Bid%7D/report")).json();
    expect(JSON.stringify(r.extensions.bazaar)).toContain(JSON.stringify(VENDOR_ID_PATTERN).slice(1, -1));
  });

  it("invalid trust-check inputs: no Solana claim, no ?domain= suggestion, not charged", async () => {
    const { get } = setup();
    const r = await get("/v1/trust/check?url=https://a.example/x&payTo=notanaddress");
    expect(r.status).toBe(400);
    const b = JSON.stringify(await r.json());
    expect(b).not.toMatch(/solana/i);
    const u = await get("/v1/trust/check?url=notaurl");
    expect(u.status).toBe(400);
    expect(JSON.stringify(await u.json())).not.toContain("?domain=");
  });

  it("every paid data response carries as_of, data_age_seconds and next_update; levels carry no scenarios or projection", async () => {
    const { get } = setup();
    for (const p of ["/v1/levels/XRP", "/v1/signal/XRP", "/v1/slate", "/v1/brief"]) {
      const req = (await (await get(p)).json()).accepts[0];
      const r = await get(p, { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
      expect(r.status, p).toBe(200);
      const b = await r.json();
      expect(b, p).toHaveProperty("as_of");
      expect(typeof b.data_age_seconds, p).toBe("number");
      expect(b, p).toHaveProperty("next_update");
      if (p.startsWith("/v1/levels")) {
        expect(b).not.toHaveProperty("scenarios");
        expect(b).not.toHaveProperty("projection");
      }
    }
  });

  it("ensureFreshness fills missing fields and keeps existing ones", () => {
    const t = Date.UTC(2026, 9, 22, 12);
    const out = ensureFreshness({ as_of: new Date(t - 60_000).toISOString(), stale_after: "2026-10-22T13:00:00.000Z" }, t);
    expect(out).toMatchObject({ data_age_seconds: 60, next_update: "2026-10-22T13:00:00.000Z" });
    expect(ensureFreshness({ as_of: "x", data_age_seconds: 5, next_update: "y" }, t)).toMatchObject({ data_age_seconds: 5, next_update: "y" });
  });
});
