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
  const args = { endpoint: "https://seller.example/a", network: "xrpl:0", tx_hash: TX, http_status: 200, outcome: "delivered" };
  // Tier 2 is OFF by default: submit=true sends nothing.
  const off = await connect({ LUMI_CONTRIB_KEY_FILE: keyFile, LUMI_CONTRIB_API: "https://api.test" }, f);
  const refused = await off.callTool({ name: "lumi_report_receipt", arguments: { ...args, submit: true } });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).error, "sharing_off");
  assert.equal(sent.length, 0);
  await off.close();
  const c = await connect({ LUMI_CONTRIB_KEY_FILE: keyFile, LUMI_CONTRIB_API: "https://api.test", LUMI_SHARE_RECEIPTS: "1" }, f);
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

test("lumi_check: free signed pre-pay check; fail-open warn when Lumi is unreachable; payTo-only for MCP tools", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519");
  const kit = await import("../../packages/scanner-kit/src/index.js");
  const { canonicalJson, sha256Hex, hex, b64 } = await import("../../packages/scanner-kit/src/util.js");
  const sk = ed25519.utils.randomPrivateKey(), pub = hex(ed25519.getPublicKey(sk));
  const body = { type: "lumi_signed_response", version: "0.1", kind: "lumi_check", id: "x", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300000).toISOString(),
    payload: { decision: "block", reasons: [{ code: "seller_failing", severity: "block" }], score: { score: 12 }, link: "https://api.test/trust/v/bad.example", matched: null, paid: false, query: {} } };
  const receipt_hash = sha256Hex(canonicalJson(body)), message = `lumi-signed:lumi_check:${receipt_hash}`;
  const receipt = { ...body, receipt_hash, signer: { key_type: "lumi-ed25519", key_id: kit.lumiKeyId(pub), public_key: pub, message, signature: b64(ed25519.sign(new TextEncoder().encode(message), sk)) } };
  const urls = [];
  const f = async (u) => { urls.push(String(u)); return String(u).includes("/v1/check/keys") ? Response.json({ keys: [{ public_key: pub }] }) : Response.json({ receipt }); };
  const c = await connect({ LUMI_CHECK_API: "https://api.test" }, f);
  const j = JSON.parse((await c.callTool({ name: "lumi_check", arguments: { url: "https://bad.example/x?secret=1", amount_usd: 0.01 } })).content[0].text);
  assert.equal(j.decision, "block"); assert.equal(j.verified, true); assert.equal(j.link, "https://api.test/trust/v/bad.example");
  assert.ok(urls.every((u) => !u.includes("secret")));
  const p = JSON.parse((await c.callTool({ name: "lumi_check", arguments: { pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" } })).content[0].text);
  assert.equal(p.decision, "block");
  const last = urls.filter((u) => u.includes("/v1/check?")).at(-1);
  assert.ok(last.includes("payTo=rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe") && !last.includes("url="));
  await c.close();
  const down = await connect({ LUMI_CHECK_API: "https://api.test" }, async () => { throw new TypeError("fetch failed"); });
  const w = JSON.parse((await down.callTool({ name: "lumi_check", arguments: { url: "https://x.example/a" } })).content[0].text);
  assert.equal(w.decision, "warn"); assert.equal(w.reasons[0].code, "lumi_unreachable");
  await down.close();
});

test("lumiCheckHooks re-exports the x402 and MCP adapters", async () => {
  const { lumiCheckHooks } = await import("../src/check.js");
  const h = await lumiCheckHooks({ fetchImpl: async () => { throw new TypeError("down"); }, publicKeys: ["00".repeat(32)], config: { fail_mode: "open", timeout_ms: 2500 } });
  assert.equal(typeof h.x402Hook, "function"); assert.equal(typeof h.mcpHook, "function");
  assert.equal(await h.x402Hook({ paymentRequired: { resource: { url: "https://a.example/x" } }, selectedRequirements: { payTo: "0x1111111111111111111111111111111111111111" } }), undefined); // fail-open
});

test("lumi_check in MCP server mode never asks: sharing stays off, one stderr hint per process, result unchanged", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { registerContribTools } = await import("../src/contrib.js");
  const { _resetHintForTests } = await import("../../packages/scanner-kit/src/first_run.js");
  _resetHintForTests();
  const cfg = join(mkdtempSync(join(tmpdir(), "lk-mcp-")), "config.json");
  const handlers = {};
  const server = { registerTool: (name, _meta, h) => { handlers[name] = h; } };
  const err = { text: "", write(s) { this.text += s; } };
  const calls = [];
  registerContribTools(server, { apiUrl: "https://api.test" }, { env: { LUMI_KIT_CONFIG: cfg }, fetchImpl: async (u) => { calls.push(String(u)); throw new TypeError("down"); }, stderr: err });
  for (let i = 0; i < 2; i++) {
    const j = JSON.parse((await handlers.lumi_check({ url: "https://x.example/a" })).content[0].text);
    assert.equal(j.decision, "warn");
    assert.ok(!("sharing" in j));
  }
  assert.equal(err.text.split("\n").filter(Boolean).length, 1);
  assert.match(err.text, /LUMI_CHECK_TELEMETRY=on/);
  assert.ok(calls.every((u) => !u.includes("/v1/check/outcome")));
  assert.equal(existsSync(cfg), false);
});

