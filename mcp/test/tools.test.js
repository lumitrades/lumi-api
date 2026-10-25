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

test("0.9.6: versions agree across package.json, server.json and the server", () => {
  assert.equal(VERSION, "0.9.6");
  assert.equal(pkg.version, VERSION);
  assert.equal(srv.version, VERSION);
  assert.equal(srv.packages[0].version, VERSION);
  assert.ok(srv.description.length <= 100);
  assert.match(srv.title, /^Lumi/);
  assert.match(srv.description, /x402 sellers/);
});

test("coin counts are current (51 coins, 14 for levels; no Solana)", () => {
  assert.doesNotMatch(pkg.description, /12 more coins/);
  assert.match(pkg.description, /51 coins/);
  assert.match(pkg.description, /Lumi Check/);
  assert.match(pkg.description, /XRPL, Base and Stellar/);
  assert.doesNotMatch(pkg.description + srv.description, /solana/i);
  // npm cuts descriptions at 255 characters (0.9.0 ended mid-word at "fundi"): keep it one complete sentence pair under that
  assert.ok(pkg.description.length <= 255, `description is ${pkg.description.length} chars`);
  assert.match(pkg.description, /\.$/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /12 more coins|The 13 coins covered|The 50 coins covered|top 50|top-50|7-day projection|solana/i);
});

test("tools: seller monitoring and trust feed present; coins says 50; no projection wording", async () => {
  const tools = await listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(by.lumi_seller_monitoring && by.lumi_trust_feed);
  assert.match(by.lumi_seller_monitoring.description, /paying never changes a score/);
  assert.match(by.lumi_coins.description, /51 coins/);
  for (const t of tools) assert.doesNotMatch(t.description, /projection/, t.name);
  assert.equal(tools.length, 26);
  assert.ok(!tools.some((t) => t.name === "lumi_trades"), "lumi_trades removed");
  assert.ok(by.lumi_scan_seller && by.lumi_report_receipt);
});
