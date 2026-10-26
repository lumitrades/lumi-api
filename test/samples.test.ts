import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { truncate, institutionalSample, productSample } from "../src/samples";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: "k".repeat(52) };
const BASE = "http://lumi.test";

describe("samples", () => {
  it("truncate cuts arrays to 2 and records full lengths", () => {
    const cut = {};
    const out = truncate({ a: [1, 2, 3, 4], b: { c: ["x".repeat(500)] } }, "", cut) as any;
    expect(out.a).toEqual([1, 2]);
    expect(cut).toEqual({ a: 4 });
    expect(out.b.c[0].length).toBeLessThan(300);
    expect(out.b.c[0]).toContain("[sample: truncated]");
  });

  it("institutional sample: headline, big_picture, 2 items, all sources", () => {
    const items = [1, 2, 3].map((i) => ({ headline: `h${i}`, source_url: `https://s/${i}`, additional_sources: [`https://a/${i}`] }));
    const s = institutionalSample({ title: "T", big_picture: ["bp"], items, coin_map: {}, markdown: "# md" });
    expect(s.sample.headline).toBe("h1");
    expect(s.sample.big_picture).toEqual(["bp"]);
    expect(s.sample.items).toHaveLength(2);
    expect(s.sample.sources).toHaveLength(6);
    expect(s.truncated.items).toBe(3);
    expect(s.truncated.omitted).toEqual(["coin_map", "markdown"]);
    expect(JSON.stringify(s)).not.toContain("# md");
  });

  it("GET /v1/samples is free, labelled, cached and covers every paid route", async () => {
    let calls = 0;
    const f = makeFetch(happyFacilitator());
    const app = createApp(ENV, { fetch: (async (u: any, i: any) => { calls++; return f(u, i); }) as any, log: () => {}, now: () => NOW });
    const r = await app.fetch(new Request(BASE + "/v1/samples"));
    expect(r.status).toBe(200);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(r.headers.get("Cache-Control")).toContain("max-age=600");
    const j: any = await r.json();
    expect(j.is_sample).toBe(true);
    expect(j.label).toMatch(/^SAMPLE/);
    const routes = j.products.map((p: any) => p.route);
    expect(routes).toEqual(expect.arrayContaining(["fear_greed", "institutional", "vendor_report"]));
    for (const gone of ["signal", "levels", "lite", "scan", "slate", "brief", "coins", "market", "yen", "sentiment", "events", "events_48h"]) expect(routes).not.toContain(gone);
    for (const p of j.products) {
      expect(p.full_url).toMatch(/^http:\/\/lumi\.test\/v1\//);
      expect(p.price.xrp).toBeTruthy();
    }
    const n = calls;
    await app.fetch(new Request(BASE + "/v1/samples"));
    expect(calls).toBe(n);
  });

  it("remote MCP lumi_samples returns one product", async () => {
    const app = createApp(ENV, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
    const r = await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lumi_samples", arguments: { route: "institutional" } } }) }));
    const j: any = await r.json();
    const t = JSON.parse(j.result.content[0].text);
    expect(t.route).toBe("institutional");
    expect(t.label).toMatch(/^SAMPLE/);
  });
});
