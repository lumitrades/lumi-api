import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { DATA, FACILITATOR, PAY_TO, happyFacilitator, makeFetch, NOW } from "./helpers";

// Item 5 (2026-10-25): the root list (/) and the OpenAPI paths must describe the same public routes.
// Discovery/meta documents that are not API operations are listed at / only.
const ROOT_ONLY = new Set(["GET /", "GET /skill.md", "GET /llms.txt", "GET /openapi.json", "POST /mcp", "POST /a2a"]);
const norm = (p: string) => p.replace(/\?.*$/, "");

async function tables(env: Record<string, string> = {}) {
  const app = createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", ...env }, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
  const idx: any = await (await app.fetch(new Request("http://lumi.test/"))).json();
  const oa: any = await (await app.fetch(new Request("http://lumi.test/openapi.json"))).json();
  const root = new Set<string>();
  for (const e of [...idx.free_endpoints, ...idx.paid_endpoints]) root.add(`${e.method} ${norm(e.path)}`);
  for (const p of idx.plans ?? []) if (p.path) root.add(`${p.method ?? "GET"} ${norm(p.path)}`);
  const api = new Set<string>();
  for (const [p, ops] of Object.entries<any>(oa.paths)) for (const m of Object.keys(ops)) if (["get", "post", "put", "delete", "patch"].includes(m)) api.add(`${m.toUpperCase()} ${p}`);
  return { root, api, idx, oa };
}

describe("one route table: / and /openapi.json agree", () => {
  for (const env of [{}, { VERDICT_PRICING: "paid" }, { VERDICT_PRICING: "free" }] as Record<string, string>[]) {
    it(`no differences (${JSON.stringify(env)})`, async () => {
      const { root, api } = await tables(env);
      const missingFromOpenApi = [...root].filter((r) => !api.has(r) && !ROOT_ONLY.has(r) && !r.includes("/.well-known/")).sort();
      const missingFromRoot = [...api].filter((r) => !root.has(r)).sort();
      expect({ missingFromOpenApi, missingFromRoot }).toEqual({ missingFromOpenApi: [], missingFromRoot: [] });
    });
  }

  it("the free seller check is listed in both, and no retired path is in either", async () => {
    const { root, api } = await tables();
    expect(root.has("GET /v1/check")).toBe(true);
    expect(api.has("GET /v1/check")).toBe(true);
    for (const r of [...root, ...api]) expect(r).not.toMatch(/\/v1\/(signal|lite|levels|scan|slate|brief|coins)\b/);
  });

  it("/.well-known/x402 and the OpenAPI x-payment-info list the same paid paths at the same USD price", async () => {
    const app = createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" }, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
    const wk: any = await (await app.fetch(new Request("http://lumi.test/.well-known/x402"))).json();
    const oa: any = await (await app.fetch(new Request("http://lumi.test/openapi.json"))).json();
    const tmpl = (u: string) => decodeURIComponent(new URL(u).pathname).replace("/printmoneylab/", "/{id}/");
    const wkPaths = wk.resources.map((r: any) => tmpl(r.template ?? r.url)).sort();
    const oaPaid = Object.entries<any>(oa.paths).filter(([, ops]) => ops.get?.["x-payment-info"]).map(([p]) => p).sort();
    expect(wkPaths).toEqual(oaPaid);
    for (const r of wk.resources) {
      const op = oa.paths[tmpl(r.template ?? r.url)].get["x-payment-info"];
      const stable = r.accepts.find((a: any) => a.asset_symbol === "RLUSD" || a.asset_symbol === "USDC");
      expect(Number(stable?.amount_usdc ?? stable?.amount), r.url).toBe(Number(op.price.amount));
    }
  });
});
