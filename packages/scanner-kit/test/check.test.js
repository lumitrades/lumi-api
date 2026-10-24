import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import * as kit from "../src/index.js";
import { canonicalJson, sha256Hex, hex, b64 } from "../src/util.js";

// Ephemeral test signing key (never printed).
const SEED = ed25519.utils.randomPrivateKey();
const PUB = hex(ed25519.getPublicKey(SEED));
function signed(payload, { kind = "lumi_check", ttl = 300_000, seed = SEED } = {}) {
  const now = Date.now();
  const body = { type: "lumi_signed_response", version: "0.1", kind, id: "t1", issued_at: new Date(now).toISOString(), expires_at: new Date(now + ttl).toISOString(), payload };
  const receipt_hash = sha256Hex(canonicalJson(body));
  const message = `lumi-signed:${kind}:${receipt_hash}`;
  const pub = hex(ed25519.getPublicKey(seed));
  return { ...body, receipt_hash, signer: { key_type: "lumi-ed25519", key_id: kit.lumiKeyId(pub), public_key: pub, message, signature: b64(ed25519.sign(new TextEncoder().encode(message), seed)) } };
}
const payload = (decision, extra = {}) => ({ decision, confidence: "high", reasons: decision === "allow" ? [] : [{ code: "seller_unverified", severity: decision }], query: {}, matched: null, score: { score: 91 }, link: "https://api.lumitrades.io/trust/v/x.example", paid: false, ...extra });
const cfgOn = { telemetry: true, share_receipts: false, fail_mode: "open", timeout_ms: 2500 };

function fakeFetch(handler) {
  const calls = [];
  const f = async (u, init = {}) => {
    calls.push({ url: String(u), init });
    const r = await handler(String(u), init);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

test("verifyLumiSigned: valid, tampered, wrong key, expired", () => {
  const r = signed(payload("allow"));
  assert.equal(kit.verifyLumiSigned(r, { publicKeys: [PUB] }).ok, true);
  const t = structuredClone(r); t.payload.decision = "block";
  assert.ok(kit.verifyLumiSigned(t, { publicKeys: [PUB] }).errors.includes("receipt_hash_mismatch"));
  assert.ok(kit.verifyLumiSigned(r, { publicKeys: ["00".repeat(32)] }).errors.includes("untrusted_key"));
  const e = kit.verifyLumiSigned(signed(payload("allow"), { ttl: -1000 }), { publicKeys: [PUB] });
  assert.equal(e.ok, false); assert.equal(e.expired, true);
});

test("check: sends origin + path only, returns the SIGNED decision, score and link", async () => {
  const f = fakeFetch((u) => ({ kind: "lumi_check", decision: "allow", receipt: signed(payload("block")) }));
  const lumi = kit.createLumiCheck({ fetchImpl: f, publicKeys: [PUB], config: cfgOn });
  const r = await lumi.check({ url: "https://api.x.example/data?q=my+secret+query#frag", payTo: "0x1111111111111111111111111111111111111111", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453" });
  assert.equal(r.decision, "block"); // from the signed payload, not the unsigned top level
  assert.equal(r.verified, true);
  assert.equal(r.link, "https://api.lumitrades.io/trust/v/x.example");
  const q = new URL(f.calls[0].url).searchParams;
  assert.equal(q.get("url"), "https://api.x.example/data");
  assert.equal(q.get("amount"), "0.01");
  assert.ok(!f.calls[0].url.includes("secret"));
});

test("fail mode: open by default (warn, payment proceeds); closed blocks; unsigned counts as unavailable", async () => {
  const slow = fakeFetch(() => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("t"), { name: "TimeoutError" })), 5)));
  const open = await kit.createLumiCheck({ fetchImpl: slow, publicKeys: [PUB], config: cfgOn }).check({ url: "https://a.example/x" });
  assert.equal(open.decision, "warn"); assert.equal(open.reasons[0].code, "lumi_unreachable"); assert.equal(open.fail_mode, "open");
  const closed = await kit.createLumiCheck({ fetchImpl: slow, publicKeys: [PUB], failMode: "closed", config: cfgOn }).check({ url: "https://a.example/x" });
  assert.equal(closed.decision, "block");
  const forged = fakeFetch(() => ({ receipt: signed(payload("allow"), { seed: ed25519.utils.randomPrivateKey() }) }));
  const f = await kit.createLumiCheck({ fetchImpl: forged, publicKeys: [PUB], config: cfgOn }).check({ url: "https://a.example/x" });
  assert.equal(f.decision, "warn"); assert.equal(f.reasons[0].code, "lumi_untrusted_key"); // signed by a key that is not pinned
  assert.equal(kit.DEFAULT_CONFIG.fail_mode, "open"); assert.equal(kit.DEFAULT_CONFIG.timeout_ms, 2500);
});

test("x402 onBeforePaymentCreation adapter: aborts on block, proceeds on allow", async () => {
  let d = "block";
  const lumi = kit.createLumiCheck({ fetchImpl: fakeFetch(() => ({ receipt: signed(payload(d)) })), publicKeys: [PUB], config: cfgOn });
  const hook = kit.x402BeforePaymentHook(lumi);
  const ctx = { paymentRequired: { resource: { url: "https://api.x.example/d?x=1" }, accepts: [] }, selectedRequirements: { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "5000", payTo: "0x1111111111111111111111111111111111111111" } };
  const a = await hook(ctx);
  assert.equal(a.abort, true); assert.match(a.reason, /seller_unverified/);
  d = "allow"; assert.equal(await hook(ctx), undefined);
});

test("MCP onPaymentRequired adapter: checks by payTo only for mcp:// tools, returns { abort: true } on block", async () => {
  const f = fakeFetch(() => ({ receipt: signed(payload("block")) }));
  const hook = kit.mcpOnPaymentRequiredHook(kit.createLumiCheck({ fetchImpl: f, publicKeys: [PUB], config: cfgOn }));
  const r = await hook({ toolName: "get_data", arguments: { secret: "x" }, paymentRequired: { resource: { url: "mcp://tool/get_data" }, accepts: [{ network: "xrpl:0", payTo: "raKj7ZGoPy1fWw1vfynuJhyHirpcmUMBhP", amount: "1000", asset: "XRP" }] } });
  assert.deepEqual(r, { abort: true });
  const q = new URL(f.calls[0].url).searchParams;
  assert.equal(q.get("url"), null); assert.equal(q.get("payTo"), "raKj7ZGoPy1fWw1vfynuJhyHirpcmUMBhP");
  assert.ok(!f.calls[0].url.includes("secret"));
});

// ---- Tier 1: anonymous delivery outcomes ----
const FORBIDDEN = ["payTo", "pay_to", "payer", "wallet", "address", "amount", "asset", "tx_hash", "tx", "url", "path", "query", "payload", "body", "client_id", "install_id", "key_id", "network"];

test("tier 1 is OFF until the user says yes; once on it sends exactly the allowed keys, never a forbidden field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lk-"));
  const def = kit.loadConfig(join(dir, "none.json"), {});
  assert.equal(def.telemetry, false); assert.equal(def.share_answered, false);
  const p = join(dir, "yes.json"); kit.recordShareChoice(true, { path: p });
  const cfg = kit.loadConfig(p, {});
  assert.equal(cfg.telemetry, true); assert.equal(cfg.share_answered, true);
  const f = fakeFetch(() => new Response("{}", { status: 202 }));
  const r = await kit.reportOutcome({ target: "https://user:pw@api.seller.example:8443/v1/data?q=secret&wallet=rABC#x", delivered: false, status: 503, payTo: "0xabc", amount: "1", tx_hash: "A".repeat(64) }, { fetchImpl: f, config: cfg });
  assert.equal(r.sent, true);
  assert.ok(f.calls[0].url.endsWith("/v1/check/outcome"));
  const body = JSON.parse(f.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["delivered", "status_class", "subject", "token", "v"]);
  assert.deepEqual({ ...body, token: undefined }, { v: 1, subject: "api.seller.example", delivered: false, status_class: "5xx", token: undefined });
  for (const k of FORBIDDEN) assert.ok(!(k in body), k);
  const raw = f.calls[0].init.body;
  for (const s of ["secret", "wallet", "rABC", "user", "pw", "/v1/data", "8443", "0xabc", "AAAA"]) assert.ok(!raw.includes(s), s);
  assert.deepEqual(Object.keys(f.calls[0].init.headers).sort(), ["Content-Type", "Lumi-Kit"]); // no auth, no contributor key
  // token is fresh per event: two reports are not linkable
  await kit.reportOutcome({ target: "api.seller.example", delivered: true, status: 200 }, { fetchImpl: f, config: cfg });
  assert.notEqual(JSON.parse(f.calls[1].init.body).token, body.token);
  for (const o of [{ target: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", delivered: true }, { target: "mcp://tool/x", delivered: true }, { target: "https://a.example", delivered: "yes" }])
    assert.equal(kit.buildOutcome(o), null);
});

test("tier 1 off switch: config flag, LUMI_CHECK_TELEMETRY=off, and the CLI each stop all sends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lk-"));
  const p = join(dir, "config.json");
  const f = fakeFetch(() => ({}));
  kit.saveConfig({ telemetry: false }, p);
  assert.deepEqual(await kit.reportOutcome({ target: "a.example", delivered: true }, { fetchImpl: f, configPath: p, env: {} }), { sent: false, reason: "telemetry_off" });
  for (const v of ["off", "0", "false", "no"])
    assert.equal((await kit.reportOutcome({ target: "a.example", delivered: true }, { fetchImpl: f, configPath: join(dir, "x.json"), env: { LUMI_CHECK_TELEMETRY: v } })).sent, false);
  const lumi = kit.createLumiCheck({ fetchImpl: f, publicKeys: [PUB], configPath: p, env: {} });
  assert.equal((await lumi.reportOutcome({ target: "a.example", delivered: true })).sent, false);
  const wrapped = kit.withOutcomeReporting(async () => new Response("ok", { headers: { "PAYMENT-RESPONSE": "x" } }), lumi);
  await wrapped("https://a.example/x");
  assert.equal(f.calls.length, 0);
  // CLI
  const { execFileSync } = await import("node:child_process");
  const cli = new URL("../bin/lumi-scan.js", import.meta.url).pathname;
  const p2 = join(dir, "cli.json");
  execFileSync(process.execPath, [cli, "telemetry", "off"], { env: { ...process.env, LUMI_KIT_CONFIG: p2 }, stdio: "pipe" });
  assert.equal(kit.loadConfig(p2, {}).telemetry, false);
});

test("withOutcomeReporting: one outcome per PAID call, none for unpaid calls", async () => {
  const f = fakeFetch(() => ({}));
  const lumi = kit.createLumiCheck({ fetchImpl: f, publicKeys: [PUB], config: cfgOn });
  await kit.withOutcomeReporting(async () => new Response("free"), lumi)("https://a.example/x?q=1");
  assert.equal(f.calls.length, 0);
  await kit.withOutcomeReporting(async () => new Response("", { status: 502, headers: { "PAYMENT-RESPONSE": "x" } }), lumi)("https://a.example/x?q=1");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual({ ...JSON.parse(f.calls[0].init.body), token: 0 }, { v: 1, subject: "a.example", delivered: false, status_class: "5xx", token: 0 });
});

// ---- Tier 2: full signed receipts ----
test("tier 2 is OFF by default: submit sends nothing unless sharing is enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lk-"));
  assert.equal(kit.loadConfig(join(dir, "none.json"), {}).share_receipts, false);
  const f = fakeFetch(() => ({ ok: true }));
  const priv = hex(ed25519.utils.randomPrivateKey());
  const off = kit.createLumiClient({ keyId: "lck_0123456789abcdef", privateKey: priv, fetchImpl: f, configPath: join(dir, "none.json"), env: {} });
  const r = await off.submit({ any: "receipt" }, "passive");
  assert.equal(r.sent, false); assert.equal(r.error, "sharing_off");
  const envOff = kit.createLumiClient({ keyId: "lck_0123456789abcdef", privateKey: priv, fetchImpl: f, configPath: join(dir, "none.json"), env: { LUMI_SHARE_RECEIPTS: "1", LUMI_CHECK_TELEMETRY: "on" } });
  assert.equal(f.calls.length, 0);
  const p = join(dir, "c.json"); kit.saveConfig({ share_receipts: true }, p);
  assert.equal((await kit.createLumiClient({ keyId: "lck_0123456789abcdef", privateKey: priv, fetchImpl: f, configPath: p, env: { LUMI_SHARE_RECEIPTS: "0" } }).submit({}, "passive")).sent, false);
  assert.equal(f.calls.length, 0);
  await envOff.submit({ a: 1 }, "passive");
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.endsWith("/v1/contrib/submissions"));
});

test("receipts carry origin + path only", async () => {
  const body = kit.buildReceiptBody({ endpoint: "https://x.example/a/b?q=secret", network: "xrpl:0", tx_hash: "AB".repeat(32), payer: "rX", pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", amount: "0.001", asset: "XRP", observed_at: "2026-10-23T12:00:00Z", http_status: 200, outcome: "delivered", mode: "passive" });
  assert.equal(body.seller.endpoint, "https://x.example/a/b");
});

test("disclosure names both tiers and all three off switches", () => {
  for (const s of ["nothing is sent until you say yes", "Tier 1 (OFF until you say yes)", "Tier 2 (OFF by default", "lumi-scan telemetry on|off", "LUMI_CHECK_TELEMETRY=on|off", "\"telemetry\": true|false", "never changes any score", "public badge only, nothing of monetary value", "transaction ID", "link it to the wallet"]) assert.ok(kit.DISCLOSURE.includes(s), s);
  assert.doesNotMatch(kit.DISCLOSURE, /credit|leaderboard|bount|perk|Solana/i);
});

test("tier 2 notice says a public, wallet-linkable transaction ID is shared and the reward is a badge only", () => {
  assert.match(kit.TIER2_NOTICE, /transaction ID \(tx hash\) and chain/);
  assert.match(kit.TIER2_NOTICE, /anyone can look it up on the blockchain and link it to the wallet that paid/);
  assert.match(kit.TIER2_NOTICE, /badge/);
  assert.match(kit.TIER2_NOTICE, /Nothing of monetary value/);
  assert.doesNotMatch(kit.TIER2_NOTICE + kit.ACCOUNT_DELETE_NOTICE, /credit|leaderboard|bount|perk/i);
});

test("account delete: the client refuses without the matching key id and sends a signed DELETE when confirmed", async () => {
  const f = fakeFetch(() => ({ deleted: true, status: "deleted" }));
  const priv = hex(ed25519.utils.randomPrivateKey());
  const c = kit.createLumiClient({ keyId: "lck_0123456789abcdef", privateKey: priv, fetchImpl: f, env: {} });
  assert.equal((await c.deleteAccount()).deleted, false);
  assert.equal((await c.deleteAccount("lck_ffffffffffffffff")).error, "confirm_key_id_required");
  assert.equal(f.calls.length, 0);
  const r = await c.deleteAccount("lck_0123456789abcdef");
  assert.equal(r.deleted, true);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.endsWith("/v1/contrib/me"));
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { confirm: "lck_0123456789abcdef" });
  assert.ok(f.calls[0].init.headers["Lumi-Signature"]);
  assert.match(kit.ACCOUNT_DELETE_NOTICE, /cannot be undone/);
});

test("lumi-scan account delete: non-interactive needs --confirm; a wrong key id cancels without sending", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "lk-"));
  const keyFile = join(dir, "key.json");
  writeFileSync(keyFile, JSON.stringify({ key_id: "lck_0123456789abcdef", private_key: hex(ed25519.utils.randomPrivateKey()) }));
  const run = (args) => { try { execFileSync(process.execPath, ["bin/lumi-scan.js", "account", "delete", "--key", keyFile, ...args], { env: { ...process.env, LUMI_API: "http://127.0.0.1:9", LUMI_KIT_CONFIG: join(dir, "cfg.json") }, stdio: ["ignore", "pipe", "pipe"] }); return { code: 0 }; } catch (e) { return { code: e.status, err: String(e.stderr) }; } };
  const a = run([]);
  assert.equal(a.code, 2); assert.match(a.err, /Nothing was sent/);
  const b = run(["--confirm", "lck_ffffffffffffffff"]);
  assert.equal(b.code, 1); assert.match(b.err, /Cancelled/);
});

test("walletProof: wallet signs a message bound to the contributor key (EVM address lower-cased)", async () => {
  const evm = await kit.signerFor("eip155:8453", "0x" + "22".repeat(32));
  const p = await kit.walletProof(evm, PUB.toUpperCase());
  assert.equal(p.address, evm.address.toLowerCase());
  assert.equal(p.key_type, "eip191");
  assert.equal(kit.walletProofMessage(PUB, evm.address), `lumi-wallet-proof:v1:${PUB}:${evm.address.toLowerCase()}`);
  assert.match(p.signature, /^0x[0-9a-f]{130}$/);
  assert.equal(JSON.stringify(p).includes("22".repeat(32)), false); // never the secret
});

test("pinned keys: defaults reject other keys (lumi_untrusted_key), never fetch keys, and validate overrides", async () => {
  const sk = ed25519.utils.randomPrivateKey(), pub = hex(ed25519.getPublicKey(sk));
  const body = { type: "lumi_signed_response", version: "0.1", kind: "lumi_check", id: "p", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300000).toISOString(),
    payload: { decision: "allow", reasons: [], score: null, link: null, matched: null, paid: false, query: {} } };
  const receipt_hash = sha256Hex(canonicalJson(body)), message = `lumi-signed:lumi_check:${receipt_hash}`;
  const r = { ...body, receipt_hash, signer: { key_type: "lumi-ed25519", key_id: kit.lumiKeyId(pub), public_key: pub, message, signature: b64(ed25519.sign(new TextEncoder().encode(message), sk)) } };
  assert.deepEqual(kit.pinnedPublicKeys(), kit.LUMI_SIGNING_KEYS.filter((k) => k.status !== "retired").map((k) => k.public_key));
  assert.equal(kit.LUMI_SIGNING_KEYS[0].key_id, "lsk_5c8c2f54fd228547");
  assert.equal(kit.LUMI_SIGNING_KEYS[0].key_id, kit.lumiKeyId(kit.LUMI_SIGNING_KEYS[0].public_key));
  const v = kit.verifyLumiSigned(r);
  assert.equal(v.ok, false); assert.equal(v.error, "lumi_untrusted_key"); assert.match(v.detail, /lsk_5c8c2f54fd228547/);
  assert.equal(kit.verifyLumiSigned(r, { publicKeys: [pub] }).ok, true);
  const urls = [];
  const lumi = kit.createLumiCheck({ api: "https://api.test", fetchImpl: async (u) => { urls.push(String(u)); return u.includes("/v1/check/keys") ? Response.json({ keys: [{ public_key: pub }] }) : Response.json({ receipt: r }); }, config: { fail_mode: "closed", timeout_ms: 2500 } });
  const out = await lumi.check({ url: "https://s.example/x" });
  assert.equal(out.decision, "block"); assert.equal(out.reasons[0].code, "lumi_untrusted_key"); assert.equal(out.verified, false);
  assert.ok(urls.every((u) => !u.includes("/v1/check/keys")));
  assert.throws(() => kit.createLumiCheck({ publicKeys: [] }), /publicKeys/);
  assert.throws(() => kit.createLumiCheck({ publicKeys: ["not-hex"] }), /publicKeys/);
});
