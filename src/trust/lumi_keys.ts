/**
 * Pinned Lumi Check signing keys (server copy). Clients (lumi-scanner-kit, lumi-trades-mcp) ship the same list and accept
 * a Lumi-signed answer or receipt ONLY when it is signed by a non-retired key from it; they never fetch keys at runtime.
 * A test (test/kit_settings.test.ts) keeps the three copies identical.
 *
 * Only PUBLIC keys live here. The private seed is the Worker secret LUMI_CHECK_SIGNING_KEY, set with
 * `wrangler secret put LUMI_CHECK_SIGNING_KEY` at deploy time (see docs/lumi-check-keys.md).
 *
 * Rotation: add the new key as "next" and ship a client release; once clients have it, switch the Worker secret and mark
 * the new key "active" and the old one "retired" (retired keys are rejected; answers are short-lived, 15 min TTL).
 */
export type PinnedKeyStatus = "active" | "next" | "retired";
export interface PinnedKey { key_id: string; public_key: string; status: PinnedKeyStatus; added: string; retired?: string }

export const LUMI_SIGNING_KEYS: readonly PinnedKey[] = Object.freeze([
  { key_id: "lsk_5c8c2f54fd228547", public_key: "7d8806265f0ce62af2bf354392246019e5f607ae2470c611bffedba59ef82e52", status: "active", added: "2026-10-23" },
] as PinnedKey[]);

/** Public keys a client may trust: every pinned key that is not retired. */
export function trustedPublicKeys(list: readonly PinnedKey[] = LUMI_SIGNING_KEYS): string[] {
  return list.filter((k) => k.status !== "retired").map((k) => k.public_key.toLowerCase());
}

export function pinnedKey(publicKey: string, list: readonly PinnedKey[] = LUMI_SIGNING_KEYS): PinnedKey | null {
  return list.find((k) => k.public_key.toLowerCase() === String(publicKey).toLowerCase()) ?? null;
}

/**
 * LUMI_CHECK_SIGNING_KEY (response signing) must be a different secret from the admin credentials (CONTRIB_ADMIN_KEY,
 * OWNER_MCP_KEY). Returns false when the signing secret is reused as either; the app then refuses to sign with it and
 * closes the contributor admin routes rather than run with one secret doing both jobs.
 */
export function signingSecretSeparate(env: { LUMI_CHECK_SIGNING_KEY?: string; CONTRIB_ADMIN_KEY?: string; OWNER_MCP_KEY?: string }): boolean {
  const s = (env.LUMI_CHECK_SIGNING_KEY ?? "").trim().toLowerCase();
  if (!s) return true;
  return ![env.CONTRIB_ADMIN_KEY, env.OWNER_MCP_KEY].some((k) => (k ?? "").trim().toLowerCase() === s);
}
