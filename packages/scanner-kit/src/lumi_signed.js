/**
 * Verify a Lumi-signed response (free /v1/check receipt, paid trust/check `lumi_receipt`, Tested-by-Lumi badge verdict).
 * Same shape as RECEIPT_FORMAT: receipt_hash = sha256(canonical JSON without receipt_hash and signer);
 * signer.message = `lumi-signed:<kind>:<receipt_hash>`; ed25519 over the UTF-8 message; public key hex; signature base64.
 * Pin Lumi's public key(s) from GET /v1/check/keys (or /.well-known/lumi-keys.json).
 */
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalJson, sha256Hex, fromHex, unb64, enc } from "./util.js";

export const LUMI_SIGNED_TYPE = "lumi_signed_response";
const HEX64 = /^[0-9a-f]{64}$/i;
export const lumiSignedMessage = (kind, hash) => `lumi-signed:${kind}:${hash}`;
export const lumiKeyId = (publicKeyHex) => "lsk_" + sha256Hex(String(publicKeyHex).toLowerCase()).slice(0, 16);

/** @returns {{ ok: boolean, errors: string[], expired: boolean, key_id: string|null }} */
export function verifyLumiSigned(r, { publicKeys = [], now = Date.now() } = {}) {
  const errors = [];
  if (!r || typeof r !== "object" || r.type !== LUMI_SIGNED_TYPE) return { ok: false, errors: ["not_a_lumi_signed_response"], expired: false, key_id: null };
  const { receipt_hash: _h, signer: _s, ...body } = r;
  if (sha256Hex(canonicalJson(body)) !== r.receipt_hash) errors.push("receipt_hash_mismatch");
  const s = r.signer ?? {};
  if (s.message !== lumiSignedMessage(r.kind, r.receipt_hash)) errors.push("message_mismatch");
  if (!s.signature || !HEX64.test(String(s.public_key ?? ""))) errors.push("unsigned");
  else {
    let good = false;
    try { good = ed25519.verify(unb64(String(s.signature)), enc.encode(String(s.message)), fromHex(String(s.public_key).toLowerCase())); } catch { good = false; }
    if (!good) errors.push("bad_signature");
    if (s.key_id !== lumiKeyId(s.public_key)) errors.push("key_id_mismatch");
    if (!publicKeys.map((k) => String(k).toLowerCase()).includes(String(s.public_key).toLowerCase())) errors.push("untrusted_key");
  }
  const expired = !(Date.parse(String(r.expires_at)) >= now);
  if (expired) errors.push("expired");
  return { ok: errors.length === 0, errors, expired, key_id: s.key_id ?? null };
}
