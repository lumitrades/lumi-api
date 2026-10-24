/**
 * Pinned Lumi signing keys (public keys only). Lumi Check answers, paid trust/check `lumi_receipt`s and Tested-by-Lumi
 * badge verdicts are accepted ONLY when signed by a non-retired key from this list. The kit never fetches keys at
 * runtime: whoever answers a request must not be able to choose the key it is checked against.
 * Same list as the server (src/trust/lumi_keys.ts) and lumi-trades-mcp (mcp/src/lumi_keys.js); a test keeps them equal.
 *
 * Rotation: a new key ships here as "next" first (trusted), becomes "active" when Lumi switches to it, and the old key
 * becomes "retired" (rejected with lumi_retired_key). See docs/lumi-check-keys.md in the Lumi API repo.
 */
export const LUMI_SIGNING_KEYS = Object.freeze([
  Object.freeze({ key_id: "lsk_5c8c2f54fd228547", public_key: "7d8806265f0ce62af2bf354392246019e5f607ae2470c611bffedba59ef82e52", status: "active", added: "2026-10-23" }),
]);

/** Public keys the kit trusts by default: every pinned key that is not retired. */
export const pinnedPublicKeys = (list = LUMI_SIGNING_KEYS) => list.filter((k) => k.status !== "retired").map((k) => k.public_key.toLowerCase());
export const retiredPublicKeys = (list = LUMI_SIGNING_KEYS) => list.filter((k) => k.status === "retired").map((k) => k.public_key.toLowerCase());
