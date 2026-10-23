import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSeed, deriveKeypair, deriveAddress } from "ripple-keypairs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import { createClient, loadSettings } from "../src/lumi.js";

const seed = generateSeed({ entropy: new Uint8Array(16).fill(7) });
const payer = deriveAddress(deriveKeypair(seed).publicKey);
const TX = "C".repeat(64);
const PAYTO = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

async function connect(env, fetchImpl) {
  const server = buildServer(createClient(loadSettings({ XRPL_SEED: seed })), { contrib: { env: { LUMI_KIT_HOME: mkdtempSync(join(tmpdir(), "kit-")), ...env }, fetchImpl } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  return c;
}

test("lumi_scan_seller: quote + dry-run plan, never pays", async () => {
  const req = { x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:0", amount: "0.001", asset: "RLUSD", payTo: PAYTO }] };
  const calls = [];
  const f = async (url, init) => { calls.push(init?.headers ?? {}); return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(req)).toString("base64") } }); };
  const c = await connect({}, f);
  const r = await c.callTool({ name: "lumi_scan_seller", arguments: { url: "https://seller.example/a" } });
  const j = JSON.parse(r.content[0].text);
  assert.equal(j.dry_run, true);
  assert.equal(j.plan.network, "xrpl:0");
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((h) => h["PAYMENT-SIGNATURE"]));
  await c.close();
});

test("lumi_report_receipt: signs a passive receipt from the ledger, submits with the contributor key, never echoes secrets", async () => {
  const sent = [];
  const f = async (url, init) => {
    const u = String(url);
    if (u.includes("/v1/contrib/submissions")) { sent.push({ headers: init.headers, body: JSON.parse(init.body) }); return Response.json({ accepted: true, finding: "counted" }, { status: 202 }); }
    return Response.json({ result: { validated: true, close_time_iso: "2026-10-23T12:00:00Z", tx_json: { TransactionType: "Payment", Account: payer, Destination: PAYTO }, meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", value: "0.001" } } } });
  };
  const dir = mkdtempSync(join(tmpdir(), "ck-"));
  const keyFile = join(dir, "key.json");
  writeFileSync(keyFile, JSON.stringify({ key_id: "lck_0123456789abcdef", private_key: "11".repeat(32), public_key: "x" }));
  const c = await connect({ LUMI_CONTRIB_KEY_FILE: keyFile, LUMI_CONTRIB_API: "https://api.test" }, f);
  const args = { endpoint: "https://seller.example/a", network: "xrpl:0", tx_hash: TX, http_status: 200, outcome: "delivered" };
  const dry = JSON.parse((await c.callTool({ name: "lumi_report_receipt", arguments: args })).content[0].text);
  assert.equal(dry.submitted, false);
  assert.equal(dry.receipt.payment.payer, payer);
  assert.equal(dry.receipt.x_lumi_contrib.mode, "passive");
  const r = await c.callTool({ name: "lumi_report_receipt", arguments: { ...args, submit: true } });
  const out = r.content[0].text;
  assert.equal(JSON.parse(out).response.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers["Lumi-Contributor-Key"], "lck_0123456789abcdef");
  assert.ok(sent[0].headers["Lumi-Signature"]);
  for (const t of [out, JSON.stringify(dry), JSON.stringify(sent)]) { assert.ok(!t.includes(seed)); assert.ok(!t.includes("11".repeat(32))); }
  await c.close();
});
