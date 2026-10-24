import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSeed } from "ripple-keypairs";
import { ed25519 } from "@noble/curves/ed25519";
import * as kit from "../src/index.js";

const seed = generateSeed({ entropy: new Uint8Array(16).fill(3) });

test("canonical JSON is key-order independent", () => {
  assert.equal(kit.canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("receipt: built, hashed and signed by the payer wallet; payment block is chain + tx hash only", async () => {
  const signer = await kit.signerFor("xrpl:0", seed);
  const body = kit.buildReceiptBody({ endpoint: "https://x.example/a", network: "xrpl:0", tx_hash: "AB".repeat(32), payer: signer.address, pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", amount: "0.001", asset: "RLUSD", observed_at: "2026-10-23T12:00:00Z", http_status: 200, outcome: "delivered", mode: "passive", measurements: { latency_ms: 5 } });
  assert.deepEqual(body.payment, { network: "xrpl:0", tx_hash: "AB".repeat(32) }); // amount, asset and payer are dropped even if passed
  assert.equal(body.type, "counterparty_delivery_receipt");
  assert.equal(body.version, "ars-evidence/0.1");
  assert.equal(body.x_lumi_contrib.kit.version, kit.KIT_VERSION);
  const r = await kit.signReceipt(body, signer);
  assert.equal(r.receipt_hash, await kit.receiptHash(body));
  assert.ok(r.signer.signature);
  // tampering changes the hash
  const t = structuredClone(body); t.delivery.outcome = "no_data";
  assert.notEqual(await kit.receiptHash(t), r.receipt_hash);
  // only the payer may sign: checked locally against the ledger's payer (which is not written into the receipt)
  const other = await kit.signerFor("xrpl:0", generateSeed({ entropy: new Uint8Array(16).fill(4) }));
  await assert.rejects(() => kit.signReceipt(body, other, { payer: signer.address }));
  const ok = await kit.signReceipt(body, signer, { payer: signer.address });
  assert.equal(ok.receipt_hash, r.receipt_hash);
  assert.throws(() => kit.buildReceiptBody({ endpoint: "https://x.example/a", mode: "passive", outcome: "great" }));
});

test("request signing verifies with the contributor public key", async () => {
  const k = kit.generateKey();
  const s = kit.signRequest(k.private_key, "POST", "/v1/contrib/submissions", "{}", "1761220000000");
  const msg = `lumi-contrib/v0\nPOST\n/v1/contrib/submissions\n1761220000000\n${await kit.sha256Hex("{}")}`;
  assert.ok(ed25519.verify(Buffer.from(s.signature, "base64"), new TextEncoder().encode(msg), Buffer.from(k.public_key, "hex")));
});

test("caps: low defaults, hard ceiling, per-day tracking", () => {
  const caps = kit.capsFrom({ LUMI_KIT_MAX_PER_BUY: "9", LUMI_KIT_MAX_PER_DAY: "9" });
  assert.equal(caps.per_buy, kit.HARD_CEILING.per_buy);
  assert.equal(caps.per_day, kit.HARD_CEILING.per_day);
  const d = kit.capsFrom({});
  assert.equal(d.per_buy, 0.01);
  const path = join(mkdtempSync(join(tmpdir(), "kit-")), "spend.json");
  let st = kit.loadState(path);
  assert.equal(kit.checkSpend(st, "RLUSD", 0.02, d).ok, false);
  for (let i = 0; i < 3; i++) { const c = kit.checkSpend(st, "RLUSD", 0.01, d); assert.equal(c.ok, true); st = kit.recordSpend(c.state, "RLUSD", 0.01, "T" + i); }
  kit.saveState(st, path);
  st = kit.loadState(path);
  assert.equal(st.spent.RLUSD, 0.03);
  assert.match(kit.checkSpend(st, "RLUSD", 0.001, d).reason, /buys-per-day/);
});

test("quote parsing (header + body) and dry-run buy never pays", async () => {
  const req = { x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:0", amount: "0.001", asset: "RLUSD", payTo: "rX", extra: { decimals: 6 } }, { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1" }] };
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(req)).toString("base64") } }); };
  const q = await kit.checkQuote("https://x.example/a", { fetchImpl });
  assert.equal(q.ok, true);
  assert.equal(q.http_status, 402);
  assert.equal(q.quotes.length, 2);
  const statePath = join(mkdtempSync(join(tmpdir(), "kit-")), "spend.json");
  const b = await kit.testBuy({ url: "https://x.example/a", networks: ["xrpl:0", "eip155:8453"], fetchImpl, statePath, secretFor: () => { throw new Error("must not be called"); } });
  assert.equal(b.dry_run, true);
  assert.equal(b.plan.network, "xrpl:0");
  assert.equal(kit.loadState(statePath).buys, 0);
  // over the per-buy cap: refused before anything is signed
  req.accepts[0].amount = "5";
  const big = await kit.testBuy({ url: "https://x.example/a", networks: ["xrpl:0"], fetchImpl, statePath, live: true, secretFor: () => { throw new Error("must not be called"); } });
  assert.equal(big.ok, false);
  assert.equal(big.step, "caps");
  assert.equal(calls, 3);
});

test("measurements: schema fingerprint ignores values, outcome classification", () => {
  const a = kit.measureBody(JSON.stringify({ x: 1, y: [{ z: "a" }], updated_at: "2026-10-23T11:59:00Z" }), "application/json", Date.parse("2026-10-23T12:00:00Z"));
  const b = kit.measureBody(JSON.stringify({ x: 9, y: [{ z: "q" }], updated_at: "2026-10-23T11:00:00Z" }), "application/json", Date.parse("2026-10-23T12:00:00Z"));
  assert.notEqual(a.response_sha256, b.response_sha256);
  assert.equal(a.schema_fingerprint, b.schema_fingerprint);
  assert.equal(a.freshness_s, 60);
  assert.equal(kit.outcomeOf(200, 0, null), "no_data");
  assert.equal(kit.outcomeOf(200, 2, []), "empty_result");
  assert.equal(kit.outcomeOf(500, 10, null), "error_status");
  assert.equal(kit.outcomeOf(200, 10, { a: 1 }), "delivered");
});

test("redact hides secrets in output", () => {
  const s = kit.redact(JSON.stringify({ seed, private_key: "ab".repeat(32) }));
  assert.ok(!s.includes(seed));
  assert.ok(!s.includes("ab".repeat(32)));
});
