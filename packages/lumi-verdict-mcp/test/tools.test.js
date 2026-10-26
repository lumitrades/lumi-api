import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, loadSettings } from "lumi-trades-mcp/src/lumi.js";
import { buildServer, VERSION, VERDICT_DESCRIPTION, FREE_DESCRIPTION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const srv = JSON.parse(readFileSync(new URL("../server.json", import.meta.url)));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

async function connect(fetchImpl) {
  const server = buildServer(createClient(loadSettings({}), { fetch: fetchImpl }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  return c;
}

test("versions and names agree across package.json, server.json and the server", () => {
  assert.equal(pkg.version, VERSION);
  assert.equal(srv.version, VERSION);
  assert.equal(srv.packages[0].version, VERSION);
  assert.equal(srv.packages[0].identifier, pkg.name);
  assert.equal(srv.name, pkg.mcpName);
  assert.equal(srv.repository.subfolder, pkg.repository.directory);
  assert.ok(srv.description.length <= 100);
  assert.ok(pkg.description.length <= 255);
});

test("public copy rules: no Solana, no partner claims, no scam wording, no seller names", () => {
  const all = [pkg.description, srv.title, srv.description, readme, VERDICT_DESCRIPTION, FREE_DESCRIPTION, pkg.keywords.join(" ")].join("\n");
  assert.doesNotMatch(all, /solana|partner|scam|fraud|fake/i);
  assert.match(readme, /x402 seller trust you can verify/);
  assert.match(VERDICT_DESCRIPTION, /\$0\.01 per call/);
  assert.match(VERDICT_DESCRIPTION, /never changes a result/);
});

test("two tools; no wallet = quote only, nothing paid; free check sends origin+path only", async () => {
  const seen = [];
  const c = await connect(async (u) => {
    seen.push(String(u));
    const url = new URL(String(u));
    if (url.pathname === "/v1/verdict")
      return new Response(JSON.stringify({ x402Version: 2, resource: { url: String(u), description: "d" }, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000", payTo: "0x5E617bac19912e6d212CB303ae84655E9E203532" }] }), { status: 402 });
    if (url.pathname === "/v1/check") return new Response(JSON.stringify({ kind: "lumi_check", label: "no_data" }));
    return new Response("{}", { status: 404 });
  });
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["lumi_check_free", "lumi_verdict"]);
  const v = await c.callTool({ name: "lumi_verdict", arguments: { url: "https://api.example.com/v1/data" } });
  const body = JSON.parse(v.content[0].text);
  assert.equal(body.paid, false);
  assert.match(body.error, /not set, so no payment was made/);
  const f = await c.callTool({ name: "lumi_check_free", arguments: { url: "https://api.example.com/v1/data?secret=1#x" } });
  assert.equal(JSON.parse(f.content[0].text).label, "no_data");
  const chk = new URL(seen.find((s) => s.includes("/v1/check")));
  assert.equal(chk.searchParams.get("url"), "https://api.example.com/v1/data");
  await c.close();
});
