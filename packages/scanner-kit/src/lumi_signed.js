/**
 * Verify a Lumi-signed response (free /v1/check receipt, paid trust/check `lumi_receipt`, Tested-by-Lumi badge verdict).
 * Same shape as RECEIPT_FORMAT: receipt_hash = sha256(canonical JSON without receipt_hash and signer);
 * signer.message = `lumi-signed:<kind>:<receipt_hash>`; ed25519 over the UTF-8 message; public key hex; signature base64.
 * Trusted keys default to the keys pinned in this package (./lumi_keys.js), never to keys fetched from the network.
 * A response signed by any other key fails with `untrusted_key` (error lumi_untrusted_key); a retired pinned key with
 * `retired_key` (lumi_retired_key).
 */
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalJson, sha256Hex, fromHex, unb64, enc } from "./util.js";
import { pinnedPublicKeys, retiredPublicKeys, LUMI_SIGNING_KEYS } from "./lumi_keys.js";

export const LUMI_SIGNED_TYPE = "lumi_signed_response";
const HEX64 = /^[0-9a-f]{64}$/i;
export const lumiSignedMessage = (kind, hash) => `lumi-signed:${kind}:${hash}`;
export const lumiKeyId = (publicKeyHex) => "lsk_" + sha256Hex(String(publicKeyHex).toLowerCase()).slice(0, 16);

/**
 * @param publicKeys trusted public keys (hex). Default: the pinned, non-retired Lumi keys. Pass your own only for tests or
 *   a self-hosted Lumi.
 * @returns {{ ok: boolean, errors: string[], expired: boolean, key_id: string|null, error?: string, detail?: string }}
 */
export function verifyLumiSigned(r, { publicKeys = pinnedPublicKeys(), now = Date.now() } = {}) {
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
    const pk = String(s.public_key).toLowerCase();
    if (!publicKeys.map((k) => String(k).toLowerCase()).includes(pk)) errors.push(retiredPublicKeys().includes(pk) ? "retired_key" : "untrusted_key");
  }
  const expired = !(Date.parse(String(r.expires_at)) >= now);
  if (expired) errors.push("expired");
  const ok = errors.length === 0;
  return { ok, errors, expired, key_id: s.key_id ?? null, ...(ok ? {} : explain(errors, s)) };
}

/** One clear error code + sentence for a failed verification (key problems first: they mean "not from Lumi"). */
function explain(errors, s) {
  const kid = typeof s.key_id === "string" ? s.key_id.slice(0, 40) : "unknown";
  const pinned = LUMI_SIGNING_KEYS.filter((k) => k.status !== "retired").map((k) => k.key_id).join(", ");
  if (errors.includes("untrusted_key")) return { error: "lumi_untrusted_key", detail: `Signed by key ${kid}, which is not a pinned Lumi signing key (pinned: ${pinned}). Rejected: this answer did not come from Lumi, or this kit is older than a key rotation (update it).` };
  if (errors.includes("retired_key")) return { error: "lumi_retired_key", detail: `Signed by retired Lumi key ${kid}. Rejected: retired keys are no longer trusted.` };
  if (errors.includes("unsigned")) return { error: "lumi_unsigned", detail: "The response carries no Lumi signature." };
  if (errors.includes("expired") && errors.length === 1) return { error: "lumi_expired", detail: "The signed answer has expired; ask Lumi again." };
  return { error: "lumi_bad_signature", detail: `Lumi's signature did not verify (${errors.join(", ")}).` };
}
