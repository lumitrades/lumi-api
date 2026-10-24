import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { LUMI_SIGNING_KEYS, pinnedPublicKeys } from "../src/lumi_keys.js";
import { checkLumiReceipt } from "../src/contrib.js";
import * as kit from "../../packages/scanner-kit/src/index.js";
import { canonicalJson, sha256Hex, hex, b64 } from "../../packages/scanner-kit/src/util.js";

function signed(kind, payload, sk) {
  const pub = hex(ed25519.getPublicKey(sk));
  const body = { type: "lumi_signed_response", version: "0.1", kind, id: "r1", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300000).toISOString(), payload };
  const receipt_hash = sha256Hex(canonicalJson(body)), message = `lumi-signed:${kind}:${receipt_hash}`;
  return { ...body, receipt_hash, signer: { key_type: "lumi-ed25519", key_id: kit.lumiKeyId(pub), public_key: pub, message, signature: b64(ed25519.sign(new TextEncoder().encode(message), sk)) } };
}

test("mcp pins the same Lumi keys as the kit, with a valid rotation status", () => {
  assert.deepEqual(LUMI_SIGNING_KEYS, kit.LUMI_SIGNING_KEYS);
  assert.ok(LUMI_SIGNING_KEYS.every((k) => /^[0-9a-f]{64}$/.test(k.public_key) && ["next", "active", "retired"].includes(k.status) && k.key_id === kit.lumiKeyId(k.public_key)));
  assert.equal(LUMI_SIGNING_KEYS.filter((k) => k.status === "active").length, 1);
  assert.ok(Object.isFrozen(LUMI_SIGNING_KEYS));
  assert.deepEqual(pinnedPublicKeys(), ["7d8806265f0ce62af2bf354392246019e5f607ae2470c611bffedba59ef82e52"]);
});

test("paid trust/check lumi_receipt is kept only when signed by a pinned key", async () => {
  const sk = ed25519.utils.randomPrivateKey(), pub = hex(ed25519.getPublicKey(sk));
  const r = signed("trust_check", { decision: "allow" }, sk);
  const kitLoader = async () => kit;
  const bad = await checkLumiReceipt({ decision: "allow", lumi_receipt: r }, { kitLoader });
  assert.equal(bad.lumi_receipt, null); assert.equal(bad.decision, "allow");
  assert.equal(bad.lumi_receipt_rejected.error, "lumi_untrusted_key"); assert.match(bad.lumi_receipt_rejected.detail, /not a pinned Lumi signing key/);
  const ok = await checkLumiReceipt({ decision: "allow", lumi_receipt: r }, { kitLoader, publicKeys: [pub] });
  assert.deepEqual(ok.lumi_receipt_verified, { ok: true, key_id: kit.lumiKeyId(pub) }); assert.equal(ok.lumi_receipt, r);
  const tampered = await checkLumiReceipt({ lumi_receipt: { ...r, payload: { decision: "block" } } }, { kitLoader, publicKeys: [pub] });
  assert.equal(tampered.lumi_receipt_rejected.error, "lumi_bad_signature");
  const noKit = await checkLumiReceipt({ lumi_receipt: r }, { kitLoader: async () => { throw new Error("missing"); } });
  assert.equal(noKit.lumi_receipt_rejected.error, "lumi_kit_unavailable");
  assert.deepEqual(await checkLumiReceipt({ decision: "allow" }, { kitLoader }), { decision: "allow" });
});
