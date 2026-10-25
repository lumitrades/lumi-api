import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrustStore } from "../src/trust/store";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://api.lumitrades.io";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: "k".repeat(52), EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532" };
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function mk() {
  const app = createApp(ENV as any, { trustStore: new MemoryTrustStore(SEED_OBSERVATIONS), catalogStore: new MemoryCatalogStore(), now: () => NOW, fetch: makeFetch(happyFacilitator()), log: () => {} } as any);
  return (p: string, h: Record<string, string> = {}, method = "GET") => app.fetch(new Request(BASE + p, { method, headers: h }));
}

describe("vendor report: HTML page for unpaid browser visits", () => {
  it("a browser gets a small page explaining the $0.02 x402 call, with docs links; nothing charged", async () => {
    const r = await mk()("/v1/trust/vendors/asksurf/report", { Accept: BROWSER });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.headers.get("vary")).toMatch(/Accept/);
    const html = await r.text();
    expect(html).toContain("$0.02");
    expect(html).toContain("x402");
    expect(html).toContain(`${BASE}/openapi.json`);
    expect(html).toContain(`${BASE}/v1/trust/vendors/asksurf`);
    expect(html).toContain("AskSurf");
  });
  it("escapes unknown ids", async () => {
    const html = await (await mk()("/v1/trust/vendors/%3Cscript%3E/report", { Accept: BROWSER })).text();
    expect(html).not.toContain("<script>");
  });
  it("agents still get the 402 (JSON, */*, no Accept, or any payment header)", async () => {
    const get = mk();
    for (const h of [{ Accept: "application/json" }, { Accept: "*/*" }, {}, { Accept: "application/json, text/html;q=0.5" }] as Record<string, string>[]) {
      expect((await get("/v1/trust/vendors/asksurf/report", h)).status).toBe(402);
    }
    const paid = await get("/v1/trust/vendors/asksurf/report", { Accept: BROWSER, "PAYMENT-SIGNATURE": "not-a-real-payment" });
    expect(paid.status).not.toBe(200);
    expect(paid.headers.get("content-type") ?? "").not.toMatch(/text\/html/);
  });
  it("the unfilled template still answers the 402 quote for crawlers", async () => {
    expect((await mk()("/v1/trust/vendors/%7Bid%7D/report", { Accept: BROWSER })).status).toBe(402);
  });
});
