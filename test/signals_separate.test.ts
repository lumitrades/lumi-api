import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { BAZAAR_ROUTES, BAZAAR_MAX_DESCRIPTION } from "../src/bazaar";
import { PAID_TOOLS, TRUST_CHECK_TOOL_DESCRIPTION, VENDOR_REPORT_TOOL_DESCRIPTION, VENDOR_LOOKUP_DESCRIPTION } from "../src/mcp";
import { MARKET_IDEAS_NAME, MARKET_IDEAS_NOTICE, MARKET_IDEAS_ROUTES } from "../src/lines";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
function setup() {
  const app = createApp(ENV, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
  return (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
}
const IDEAS = ["/v1/signal/XRP", "/v1/lite/XRP", "/v1/scan", "/v1/slate", "/v1/levels/XRP"];

describe("Lumi Market Ideas is separated from the trust brand", () => {
  it("market-ideas responses carry the notice (body fields + headers), additively; 402s too", async () => {
    const get = setup();
    expect(MARKET_IDEAS_NOTICE).toBe("Paper-trade analysis, not investment advice. Lumi does not trade real money.");
    for (const p of IDEAS) {
      const q = await get(p);
      expect(q.headers.get("X-Lumi-Product-Line"), p).toBe(MARKET_IDEAS_NAME);
      expect(q.headers.get("X-Lumi-Notice"), p).toBe(MARKET_IDEAS_NOTICE);
      if (p === "/v1/scan") continue; // the fixture lacks all 50 coins, so scan is "not for sale" (503) here; headers still apply
      expect(q.status, p).toBe(402);
      const req = (await q.json()).accepts[0];
      const r = await get(p, { "PAYMENT-SIGNATURE": paymentHeaderFor(req) });
      expect(r.status, p).toBe(200);
      expect(r.headers.get("X-Lumi-Notice"), p).toBe(MARKET_IDEAS_NOTICE);
      const b = await r.json();
      expect(b.product_line, p).toBe(MARKET_IDEAS_NAME);
      expect(b.notice, p).toBe(MARKET_IDEAS_NOTICE);
      expect(b, p).toHaveProperty("disclaimer");
      expect(b, p).toHaveProperty("as_of");
    }
  });

  it("trust and market-data responses are not labelled as market ideas", async () => {
    const get = setup();
    for (const p of ["/v1/brief", "/v1/trust/check?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fdata", "/v1/trust/vendors", "/health"]) {
      const r = await get(p);
      expect(r.headers.get("X-Lumi-Product-Line"), p).toBeNull();
    }
  });

  it("trust surfaces do not mention or upsell signals", async () => {
    const get = setup();
    for (const d of [TRUST_CHECK_TOOL_DESCRIPTION, VENDOR_REPORT_TOOL_DESCRIPTION]) expect(d).not.toMatch(/\/v1\/(signal|lite|scan|slate|trades|levels)|trading signal|lumi_signal/i);
    expect(VENDOR_LOOKUP_DESCRIPTION).not.toMatch(/\/v1\/signal|lumi_signal|trading signal/i);
    const tc = JSON.stringify(await (await get("/v1/trust/check?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fdata")).json());
    expect(tc).not.toMatch(/\/v1\/(signal|lite|scan|slate|trades|levels)/);
    const vendors = JSON.stringify(await (await get("/v1/trust/vendors")).json());
    expect(vendors).not.toMatch(/\/v1\/(signal|lite|scan|slate|trades|levels)/);
    const samples = await (await get("/v1/samples")).json();
    expect(JSON.stringify(samples)).not.toContain("url=https%3A%2F%2Fapi.lumitrades.io%2Fv1%2Fsignal");
  });

  it("docs group the market ideas under their own label", async () => {
    const get = setup();
    const oa = await (await get("/openapi.json")).json();
    expect(oa.tags.map((t: any) => t.name)).toContain(MARKET_IDEAS_NAME);
    for (const [path, ops] of Object.entries(oa.paths) as [string, any][]) {
      const tags = ops.get?.tags ?? [];
      if (/^\/v1\/(signal|lite|levels)\/|^\/v1\/(scan|slate|trades)$/.test(path)) expect(tags, path).toEqual([MARKET_IDEAS_NAME]);
      else if (path.startsWith("/v1/trust")) expect(tags, path).not.toContain(MARKET_IDEAS_NAME);
    }
    const skill = await (await get("/skill.md")).text();
    expect(skill).toContain(`### ${MARKET_IDEAS_NAME}`);
    expect(skill).toContain(MARKET_IDEAS_NOTICE);
    const llms = await (await get("/llms.txt")).text();
    expect(llms).toContain(MARKET_IDEAS_NOTICE);
    const wk = await (await get("/.well-known/x402")).json();
    expect(JSON.stringify(wk)).toContain(MARKET_IDEAS_NAME);
    const card = await (await get("/.well-known/agent-card.json")).json();
    expect(card.description).toContain(MARKET_IDEAS_NOTICE);
    const ideaSkills = card.skills.filter((s: any) => ["signal", "lite", "scan", "levels", "slate"].includes(s.id));
    expect(ideaSkills.length).toBe(5);
    for (const s of ideaSkills) expect(s.name, s.id).toMatch(/^Lumi Market Ideas: /);
    for (const r of MARKET_IDEAS_ROUTES) {
      const b = (BAZAAR_ROUTES as any)[r];
      expect(b.description, r).toMatch(/^Lumi Market Ideas\./);
      expect(b.description, r).toContain("not investment advice");
      expect(b.description.length, r).toBeLessThanOrEqual(BAZAAR_MAX_DESCRIPTION);
    }
    for (const t of PAID_TOOLS.filter((t) => MARKET_IDEAS_ROUTES.includes(t.route))) expect(t.description, t.name).toContain(MARKET_IDEAS_NOTICE);
    expect(PAID_TOOLS.filter((t) => MARKET_IDEAS_ROUTES.includes(t.route)).length).toBe(5);
  });
});
