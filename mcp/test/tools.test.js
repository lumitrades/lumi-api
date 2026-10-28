import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, VERSION } from "../src/index.js";
import { createClient, loadSettings } from "../src/lumi.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const srv = JSON.parse(readFileSync(new URL("../server.json", import.meta.url)));

async function listTools() {
  const server = buildServer(createClient(loadSettings({})));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  const { tools } = await c.listTools();
  await c.close();
  return tools;
}

test("0.10.0: versions agree across package.json, server.json and the server", () => {
  assert.equal(VERSION, "0.10.0");
  assert.equal(pkg.version, VERSION);
  assert.equal(srv.version, VERSION);
  assert.equal(srv.packages[0].version, VERSION);
  assert.ok(srv.description.length <= 100);
  assert.match(srv.title, /^Lumi/);
  assert.match(srv.description, /x402 sellers/);
});

test("descriptions are current (no per-coin readings since 0.9.8; no Solana)", () => {
  assert.doesNotMatch(pkg.description, /\d+ coins|trend readings|signals?\b|levels/);
  assert.match(pkg.description, /Lumi Check/);
  assert.match(pkg.description, /XRPL, Base and Stellar/);
  assert.doesNotMatch(pkg.description + srv.description, /solana/i);
  // npm cuts descriptions at 255 characters (0.9.0 ended mid-word at "fundi"): keep it one complete sentence pair under that
  assert.ok(pkg.description.length <= 255, `description is ${pkg.description.length} chars`);
  assert.match(pkg.description, /\.$/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(pkg.description + srv.description + readme + pkg.keywords.join(" "), /fear.?greed|lumi_funding|funding rates|institutional|policy.brief|market data|trust layer/i);
  assert.doesNotMatch(readme, /12 more coins|The 13 coins covered|The 50 coins covered|top 50|top-50|7-day projection|solana/i);
});

test("tools: seller monitoring and trust feed present; retired trading tools gone; no projection wording", async () => {
  const tools = await listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(by.lumi_seller_monitoring && by.lumi_trust_feed);
  assert.match(by.lumi_seller_monitoring.description, /paying never changes a score/);
  for (const n of ["lumi_coins", "lumi_signal", "lumi_lite", "lumi_scan", "lumi_levels", "lumi_slate", "lumi_brief", "lumi_market", "lumi_macro_yen", "lumi_sentiment", "lumi_events", "lumi_events_48h", "lumi_funding", "lumi_fear_greed", "lumi_institutional_brief"]) assert.ok(!by[n], `${n} retired`);
  for (const t of tools) assert.doesNotMatch(JSON.stringify(t), /\/v1\/(funding|fear-greed|institutional)|fear.?greed|funding rate|institutional brief|policy brief|market data/i, t.name);
  for (const t of tools) assert.doesNotMatch(t.description, /projection|leverage|support|resistance|\bsignal\b|trade idea/i, t.name);
  assert.equal(tools.length, 13); // 0.10.0: lumi_trust_check is free, lumi_high_value_check added (0.9.9: retired tools removed)
  assert.ok(by.lumi_verdict, "lumi_verdict present");
  assert.match(by.lumi_verdict.description, /never changes a result/);
  assert.ok(!tools.some((t) => t.name === "lumi_trades"), "lumi_trades removed");
  assert.ok(by.lumi_scan_seller && by.lumi_report_receipt);
});

test("0.10.0: lumi_trust_check is free (no payment, no wallet); lumi_high_value_check is paid and needs url + amount", async () => {
  const seen = [];
  const fetchStub = async (u, init) => {
    seen.push({ url: String(u), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({ kind: "trust_check", verdict: "allow", access: { mode: "free", charged: false } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const server = buildServer(createClient(loadSettings({}), { fetch: fetchStub }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  const { tools } = await c.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.match(by.lumi_trust_check.description, /^Free/);
  assert.match(by.lumi_high_value_check.description, /0\.5% of amount, minimum \$0\.005, maximum \$0\.25/);
  assert.deepEqual([...by.lumi_high_value_check.inputSchema.required].sort(), ["amount", "url"]);
  const r = await c.callTool({ name: "lumi_trust_check", arguments: { url: "https://api.example.com/x", amount: "0.01" } });
  await c.close();
  assert.equal(r.isError, undefined);
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v1\/trust\/check\?url=https%3A%2F%2Fapi\.example\.com%2Fx&amount=0\.01$/);
  assert.ok(!JSON.stringify(seen[0].headers).match(/payment-signature/i));
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.verdict, "allow");
  assert.match(body.note, /not a rating/);
});

test("the free trust check leads the tool list (2026-10-28)", async () => {
  const tools = await listTools();
  assert.equal(tools[0].name, "lumi_trust_check");
});
