/**
 * Lumi-signed responses (Lumi Check v0): the pre-pay check, the paid trust/check and the earned "Tested by Lumi" badge.
 *
 * Same shape and hashing as RECEIPT_FORMAT (counterparty_delivery_receipt): receipt_hash = sha256(canonical JSON of the
 * object without receipt_hash and signer), so isSignedObject() keeps every response transform away from it.
 * Signer: a dedicated ed25519 key held by the Worker as the secret LUMI_CHECK_SIGNING_KEY (64 hex, a 32-byte seed).
 * It is NOT a wallet key: it cannot move funds and only attests "Lumi said this at this time".
 * Signed message: `lumi-signed:<kind>:<receipt_hash>`. Public key(s): pinned in ./lumi_keys.ts and in the clients; also listed
 * (informational only, clients do not fetch them) at GET /v1/check/keys and /.well-known/lumi-keys.json.
 * When the secret is unset the response still carries the same object with signer.signature = null (unsigned_reason).
 */
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalJson } from "./receipts";
import { sha256Hex } from "./verify";
import { LUMI_SIGNING_KEYS, pinnedKey } from "./lumi_keys";

export const SIGNED_TYPE = "lumi_signed_response";
export const SIGNED_VERSION = "0.1";
export const SIGNED_KEY_TYPE = "lumi-ed25519";
export type SignedKind = "lumi_check" | "trust_check" | "tested_badge" | "lumi_verdict" | "live_check";

export interface SigningKey { seed: Uint8Array; public_key: string; key_id: string }
export interface SignedResponse {
  type: typeof SIGNED_TYPE;
  version: typeof SIGNED_VERSION;
  kind: SignedKind;
  id: string;
  issued_at: string;
  expires_at: string;
  payload: Record<string, unknown>;
  receipt_hash: string;
  signer: { key_type: typeof SIGNED_KEY_TYPE; key_id: string | null; public_key: string | null; message: string; signature: string | null; unsigned_reason?: string };
}

const HEX64 = /^[0-9a-f]{64}$/i;
const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const signedMessage = (kind: string, hash: string) => `lumi-signed:${kind}:${hash}`;

/** key_id = "lsk_" + first 16 hex of sha256(public key hex). */
export async function keyIdOf(publicKeyHex: string) {
  return "lsk_" + (await sha256Hex(publicKeyHex.toLowerCase())).slice(0, 16);
}

/** Parses the Worker secret; null when unset or malformed (never logs or echoes the value). */
export async function signingKeyFrom(secret: string | undefined): Promise<SigningKey | null> {
  const s = (secret ?? "").trim();
  if (!HEX64.test(s)) return null;
  const seed = hexToBytes(s);
  const public_key = bytesToHex(ed25519.getPublicKey(seed));
  return { seed, public_key, key_id: await keyIdOf(public_key) };
}

export async function signedHash(o: Omit<SignedResponse, "receipt_hash" | "signer"> | SignedResponse): Promise<string> {
  const { receipt_hash: _h, signer: _s, ...body } = o as SignedResponse;
  return sha256Hex(canonicalJson(body));
}

export async function signResponse(kind: SignedKind, payload: Record<string, unknown>, key: SigningKey | null, now: number, ttlSec: number): Promise<SignedResponse> {
  const id = `${kind}_${now.toString(36)}_${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
  const body = { type: SIGNED_TYPE, version: SIGNED_VERSION, kind, id, issued_at: new Date(now).toISOString(), expires_at: new Date(now + ttlSec * 1000).toISOString(), payload } as const;
  const receipt_hash = await signedHash(body as any);
  const message = signedMessage(kind, receipt_hash);
  if (!key) return { ...body, receipt_hash, signer: { key_type: SIGNED_KEY_TYPE, key_id: null, public_key: null, message, signature: null, unsigned_reason: "signing_key_not_configured" } };
  const signature = b64(ed25519.sign(new TextEncoder().encode(message), key.seed));
  return { ...body, receipt_hash, signer: { key_type: SIGNED_KEY_TYPE, key_id: key.key_id, public_key: key.public_key, message, signature } };
}

/**
 * Verify a Lumi-signed response. trusted = Lumi public keys (hex) the caller pinned or fetched from /v1/check/keys.
 * Without trusted keys only integrity is checked (hash + signature by the embedded key), and ok is false with "untrusted_key".
 */
export async function verifySignedResponse(r: any, opts: { trusted?: string[]; now?: number } = {}): Promise<{ ok: boolean; errors: string[]; expired: boolean }> {
  const errors: string[] = [];
  if (!r || typeof r !== "object" || r.type !== SIGNED_TYPE) return { ok: false, errors: ["not_a_lumi_signed_response"], expired: false };
  const hash = await signedHash(r);
  if (hash !== r.receipt_hash) errors.push("receipt_hash_mismatch");
  const s = r.signer ?? {};
  if (s.message !== signedMessage(r.kind, r.receipt_hash)) errors.push("message_mismatch");
  if (!s.signature || !HEX64.test(String(s.public_key ?? ""))) errors.push("unsigned");
  else {
    let good = false;
    try { good = ed25519.verify(unb64(String(s.signature)), new TextEncoder().encode(String(s.message)), hexToBytes(String(s.public_key))); } catch { good = false; }
    if (!good) errors.push("bad_signature");
    if (s.key_id !== (await keyIdOf(String(s.public_key)))) errors.push("key_id_mismatch");
    const trusted = (opts.trusted ?? []).map((k) => k.toLowerCase());
    if (!trusted.includes(String(s.public_key).toLowerCase())) errors.push("untrusted_key");
  }
  const expired = Date.parse(String(r.expires_at)) < (opts.now ?? Date.now());
  if (expired) errors.push("expired");
  return { ok: errors.length === 0, errors, expired };
}

export function keysDoc(key: SigningKey | null, base: string, opts: { secretReused?: boolean } = {}) {
  const use = ["lumi_check", "trust_check", "tested_badge"];
  const configured = key ? pinnedKey(key.public_key) : null;
  const keys = [
    ...(key ? [{ key_id: key.key_id, key_type: SIGNED_KEY_TYPE, alg: "ed25519", public_key: key.public_key, use, pinned: !!configured, status: configured?.status ?? "not_pinned", signing: true }] : []),
    ...LUMI_SIGNING_KEYS.filter((k) => k.public_key !== key?.public_key).map((k) => ({ key_id: k.key_id, key_type: SIGNED_KEY_TYPE, alg: "ed25519", public_key: k.public_key, use, pinned: true, status: k.status, signing: false })),
  ];
  return {
    kind: "lumi_signing_keys",
    keys,
    status: opts.secretReused ? "signing_key_reused_as_admin_key" : !key ? "signing_key_not_configured" : configured && configured.status !== "retired" ? "active" : "configured_key_not_pinned",
    pinning: "lumi-scanner-kit and lumi-trades-mcp ship these public keys (rotation list: active, next, retired) and reject any other key with lumi_untrusted_key. They never fetch this document to decide trust.",
    verify: {
      steps: [
        "receipt_hash = sha256 hex of the canonical JSON (sorted keys, no whitespace) of the object without receipt_hash and signer.",
        "signer.message must equal `lumi-signed:<kind>:<receipt_hash>`.",
        "ed25519 verify(base64 signer.signature, utf8 signer.message, hex signer.public_key); the public key must be a pinned, non-retired Lumi key.",
        "Reject when expires_at is in the past (badges and checks are short-lived on purpose).",
      ],
      helper: "lumi-check (npm): verifyLumiSigned(response, { publicKeys }) with the pinned keys listed here (Apache-2.0).",
      endpoint: `${base}/v1/check/keys`,
    },
    note: "A dedicated signing key, not a wallet: it cannot move funds. Lumi's test-buy receipts stay signed by the paying wallet (RECEIPT_FORMAT).",
  };
}
