import { describe, expect, it } from "vitest";
import { seededStores } from "./stage_c_fixtures";
import { createApp } from "../src/app";
import { PAID_ENDPOINTS } from "../src/catalog";
import { EXAMPLE_RESULT_LABEL } from "../src/example_result";
import { DATA, FACILITATOR, PAY_TO, NOW, makeFetch, happyFacilitator, decodeB64Json } from "./helpers";

// 2026-10-28: the trust check leads every discovery surface, and trust-route 402 quotes carry a labelled example result.
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, OWNER_MCP_KEY: "owner-key-for-tests-0123456789abcdef", INVOICE_SECRET: "test-secret" };
const mk = () => createApp(ENV as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, ...seededStores(NOW) });
const get = async (app: ReturnType<typeof mk>, p: string) => app.fetch(new Request("http://lumi.test" + p));

describe("trust check first", () => {
  it("is the first A2A skill, MCP tool, OpenAPI path, free endpoint and paid endpoint", async () => {
    const app = mk();
    const card = await (await get(app, "/.well-known/agent-card.json")).json() as any;
    expect(card.skills[0].id).toBe("trust_check");
    const mcp = await app.fetch(new Request("http://lumi.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    const names = ((await mcp.text()).match(/"name":\s*"lumi_[a-z_]+"/g) ?? []).map((s) => s.replace(/.*"(lumi_[a-z_]+)"/, "$1"));
    expect(names[0]).toBe("lumi_trust_check");
    const oa = await (await get(app, "/openapi.json")).json() as any;
    expect(Object.keys(oa.paths).slice(0, 2)).toEqual(["/v1/trust/check", "/v1/trust/check/high-value"]);
    const root = await (await get(app, "/")).json() as any;
    expect(root.free_endpoints[0].path).toBe("/v1/trust/check?url=");
    expect(root.paid_endpoints[0].path).toBe("/v1/trust/check/high-value");
    const wk = await (await get(app, "/.well-known/x402")).json() as any;
    expect(Object.keys(wk).indexOf("start_here")).toBeLessThan(Object.keys(wk).indexOf("resources"));
    expect(wk.start_here.free_trust_check).toMatch(/\/v1\/trust\/check\?url=/);
    expect(wk.resources[0].url ?? wk.resources[0].resource).toMatch(/\/v1\/trust\/check\/high-value/);
  });
});

describe("example result in trust-route 402 quotes", () => {
  it("high-value check, verdict and batch check carry a labelled example (body == header); other routes do not", async () => {
    const app = mk();
    const seen: string[] = [];
    for (const e of PAID_ENDPOINTS) {
      if (e.route === "vendor_report") continue; // needs trust observations (503 in this fixture); no example by design
      const r = await get(app, e.route === "receipts" ? e.path : e.example);
      expect(r.status).toBe(402);
      const h = r.headers.get("PAYMENT-REQUIRED")!;
      expect(h.length).toBeLessThan(8000);
      const fromHeader = decodeB64Json(h);
      const body = await r.json() as any;
      expect(body.example_result).toEqual(fromHeader.example_result);
      if (["high_value_check", "verdict", "batch_check"].includes(e.route)) {
        seen.push(e.route);
        expect(body.example_result.label).toBe(EXAMPLE_RESULT_LABEL);
        expect(body.example_result.label).toMatch(/^EXAMPLE/);
        // placeholder sellers only, never a real seller's verdict
        expect(JSON.stringify(body.example_result.result)).not.toMatch(/https?:\/\/(?![a-z.]*example\.(com|org))/);
        // the example never leaks into what clients echo back to the facilitator
        expect(JSON.stringify(body.resource)).not.toContain("EXAMPLE only");
        expect(JSON.stringify(body.accepts)).not.toContain("EXAMPLE only");
      } else {
        expect(body.example_result).toBeUndefined();
      }
    }
    // /v1/verdict (paid by default, VERDICT_PRICING) is added outside the static PAID_ENDPOINTS list; covered in the next test.
    expect(seen.sort()).toEqual(PAID_ENDPOINTS.map((e) => e.route).filter((r) => ["batch_check", "high_value_check", "verdict"].includes(r)).sort());
    expect(seen).toContain("high_value_check");
  });

  it("the paid /v1/verdict quote carries the labelled one-label example", async () => {
    const app = mk();
    const r = await get(app, "/v1/verdict?url=" + encodeURIComponent("https://api.agentweather.io/v1/pulse/facilitator"));
    expect(r.status).toBe(402);
    const body = await r.json() as any;
    expect(body.example_result).toEqual(decodeB64Json(r.headers.get("PAYMENT-REQUIRED")!).example_result);
    expect(body.example_result.label).toBe(EXAMPLE_RESULT_LABEL);
    expect(body.example_result.result.label).toBe("checks_passed");
  });

  it("bare probes of trust routes (crawlers) also carry it", async () => {
    const app = mk();
    const r = await get(app, "/v1/trust/check/high-value");
    expect(r.status).toBe(402);
    const body = await r.json() as any;
    expect(body.example_result.label).toBe(EXAMPLE_RESULT_LABEL);
    expect(body.example_result.result.verdict).toMatch(/^(allow|warn|block)$/);
  });
});
