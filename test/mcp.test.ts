import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { safeEqual, SUPPORTED_VERSIONS } from "../src/mcp";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const KEY = "k".repeat(20) + "0123456789abcdef0123456789abcdef";
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", OWNER_MCP_KEY: KEY };
const BASE = "http://lumi.test";

function setup(now = NOW) {
  const fac = happyFacilitator();
  const logs: any[] = [];
  const app = createApp(ENV, { fetch: makeFetch(fac), log: (e) => logs.push(e), now: () => now });
  let n = 0;
  const rpc = async (method: string, params: unknown = {}, opts: { path?: string; headers?: Record<string, string> } = {}) => {
    const r = await app.fetch(
      new Request(BASE + (opts.path ?? "/mcp"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...opts.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
      }),
    );
    return { status: r.status, body: r.status === 202 ? null : await r.json() };
  };
  const call = (name: string, args: unknown = {}, opts = {}) => rpc("tools/call", { name, arguments: args }, opts);
  return { app, rpc, call, fac, logs };
}
const textOf = (b: any) => b.result.content[0].text as string;

describe("remote MCP: protocol", () => {
  it("legacy initialize, notifications/initialized, ping", async () => {
    const { rpc, app } = setup();
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lumi-trades" } });
    const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(unknown.body.result.protocolVersion).toBe("2025-11-25");
    const note = await app.fetch(new Request(BASE + "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    expect((await rpc("ping")).body.result).toEqual({});
  });

  it("modern (2026-07-28): server/discover, resultType, version and header validation", async () => {
    const { rpc } = setup();
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const d = await rpc("server/discover", meta, { headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" } });
    expect(d.body.result).toMatchObject({ resultType: "complete", supportedVersions: SUPPORTED_VERSIONS });
    const tl = await rpc("tools/list", meta, { headers: { "MCP-Protocol-Version": "2026-07-28" } });
    expect(tl.body.result.resultType).toBe("complete");
    const bad = await rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: -32022, data: { requested: "1900-01-01" } });
    const mismatch = await rpc("tools/list", meta, { headers: { "MCP-Protocol-Version": "2025-06-18" } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(-32020);
    const nameMismatch = await rpc("tools/call", { ...meta, name: "lumi_coins" }, { headers: { "Mcp-Name": "lumi_brief" } });
    expect(nameMismatch.body.error.code).toBe(-32020);
    const nf = await rpc("nope/nope", meta);
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe(-32601);
  });

  it("GET/DELETE are 405, OPTIONS allows MCP headers, parse errors are 400", async () => {
    const { app } = setup();
    expect((await app.fetch(new Request(BASE + "/mcp"))).status).toBe(405);
    const del = await app.fetch(new Request(BASE + "/mcp", { method: "DELETE" }));
    expect(del.status).toBe(405);
    expect(del.headers.get("Allow")).toBe("POST, HEAD, OPTIONS");
    expect(del.headers.get("Access-Control-Allow-Methods")).toBe(del.headers.get("Allow"));
    const head = await app.fetch(new Request(BASE + "/mcp", { method: "HEAD" }));
    expect(head.status).toBe(204);
    expect(head.headers.get("Allow")).toBe("POST, HEAD, OPTIONS");
    const o = await app.fetch(new Request(BASE + "/mcp", { method: "OPTIONS" }));
    expect(o.status).toBe(204);
    expect(o.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
    expect(o.headers.get("Access-Control-Allow-Methods")).toBe("POST, HEAD, OPTIONS");
    const pe = await app.fetch(new Request(BASE + "/mcp", { method: "POST", body: "{nope" }));
    expect(pe.status).toBe(400);
    expect((await pe.json()).error.code).toBe(-32700);
  });

  it("answers as SSE when the client only accepts text/event-stream", async () => {
    const { app } = setup();
    const r = await app.fetch(new Request(BASE + "/mcp", { method: "POST", headers: { Accept: "text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(r.headers.get("Content-Type")).toBe("text/event-stream");
    const t = await r.text();
    expect(t).toMatch(/^event: message\ndata: /);
    expect(JSON.parse(t.split("data: ")[1]).result.tools.length).toBe(24);
  });
});

describe("remote MCP: tools", () => {
  it("mirrors the stdio wrapper's tool names", async () => {
    const { rpc } = setup();
    const names = (await rpc("tools/list")).body.result.tools.map((t: any) => t.name);
    const src = readFileSync(join(__dirname, "..", "mcp", "src", "index.js"), "utf8");
    const wrapper = [...src.matchAll(/name: "(lumi_[a-z0-9_]+)"/g), ...src.matchAll(/registerTool\(\s*"(lumi_[a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(wrapper));
    expect(names).toHaveLength(24);
  });

  it("lumi_verdict is free by default and answers with a label (same core as /v1/check)", async () => {
    const { call } = setup();
    const r = JSON.parse(textOf((await call("lumi_verdict", { url: "https://unknown-seller.example/v1/x" })).body));
    expect(r.kind).toBe("lumi_verdict");
    expect(r.label).toBe("no_data");
    expect(r.label_text).toBe("Not enough data");
    const bad = await call("lumi_verdict", {});
    expect(bad.body.result.isError).toBe(true);
  });

  it("free tools work without a key", async () => {
    const { call } = setup();
    const coins = JSON.parse(textOf((await call("lumi_coins")).body));
    expect(coins).toHaveLength(50);
    const cat = JSON.parse(textOf((await call("lumi_catalog")).body));
    expect(cat.endpoints).toHaveLength(16);
    expect(cat.access).toMatch(/^public/);
    const q = JSON.parse(textOf((await call("lumi_quote", { path: "/v1/brief" })).body));
    expect(q.status).toBe(402);
    expect(q.options[0]).toMatchObject({ asset: "XRP", amount: "0.015" });
  });

  it("paid tool without a key: payment explanation, no charge, no facilitator call", async () => {
    const { call, fac } = setup();
    const r = await call("lumi_brief");
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    const t = textOf(r.body);
    expect(t).toMatch(/0\.015 XRP/);
    expect(t).toMatch(/x402/);
    expect(t).toMatch(/lumi-trades-mcp/);
    expect(t).toContain(`${BASE}/v1/brief`);
    expect(t).not.toMatch(/"btc"/);
    expect(fac.calls).toHaveLength(0);
    // a wrong bearer is just public access
    const w = await call("lumi_signal", { coin: "XRP" }, { headers: { Authorization: "Bearer wrong" } });
    expect(textOf(w.body)).toMatch(/payment_required/);
  });

  it("paid tool with the owner key (header and path) returns data, free", async () => {
    const { call, fac, logs } = setup();
    const viaHeader = await call("lumi_signal", { coin: "xrp" }, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(viaHeader.body.result.isError).toBeUndefined();
    const sig = JSON.parse(textOf(viaHeader.body));
    expect(sig).toMatchObject({ kind: "signal", coin: { symbol: "XRP" }, access: { mode: "owner", charged: false } });
    const viaPath = await call("lumi_brief", {}, { path: `/mcp/${KEY}` });
    const brief = JSON.parse(textOf(viaPath.body));
    expect(brief.kind).toBe("brief");
    const md = await call("lumi_brief", { format: "md" }, { path: `/mcp/${KEY}` });
    expect(textOf(md.body)).toMatch(/^#|\*\*/m);
    expect(fac.calls).toHaveLength(0);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it("wrong path key is 404; unknown coin and bad args are tool errors", async () => {
    const { call, rpc } = setup();
    expect((await call("lumi_brief", {}, { path: "/mcp/" + "x".repeat(52) })).status).toBe(404);
    const unk = await call("lumi_signal", { coin: "NOPE" }, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(unk.body.result.isError).toBe(true);
    expect(textOf(unk.body)).toMatch(/unknown_coin/);
    expect((await call("lumi_signal", {})).body.result.isError).toBe(true);
    expect((await rpc("tools/call", { name: "nope" })).body.error.code).toBe(-32602);
  });

  it("stale data is an error (not charged) for owner and public", async () => {
    const { call } = setup(NOW + 3 * 86_400_000);
    for (const headers of [{}, { Authorization: `Bearer ${KEY}` }]) {
      const r = await call("lumi_market", {}, { headers });
      expect(r.body.result.isError).toBe(true);
      expect(JSON.parse(textOf(r.body))).toMatchObject({ status: 503, error: "stale_data", note: "Not charged." });
    }
  });

  it("owner access is disabled when the secret is missing or short", async () => {
    const app = createApp({ ...ENV, OWNER_MCP_KEY: "short" }, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW });
    const r = await app.fetch(new Request(BASE + "/mcp/short", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    expect(r.status).toBe(404);
  });

  it("safeEqual", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
  });
});
