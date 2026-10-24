/**
 * Pinned Lumi signing keys (public keys only), shipped in lumi-trades-mcp. Lumi Check answers (lumi_check, lumiCheckHooks)
 * and paid trust/check `lumi_receipt`s are accepted ONLY when signed by a non-retired key from this list; any other key
 * is rejected with lumi_untrusted_key. Nothing is fetched at runtime. Same list as lumi-scanner-kit and the Lumi API
 * (src/trust/lumi_keys.ts); a test keeps them equal.
 *
 * Rotation list: "next" (shipped ahead of a rotation, trusted), "active" (trusted), "retired" (rejected).
 */
export const LUMI_SIGNING_KEYS = Object.freeze([
  Object.freeze({ key_id: "lsk_5c8c2f54fd228547", public_key: "7d8806265f0ce62af2bf354392246019e5f607ae2470c611bffedba59ef82e52", status: "active", added: "2026-10-23" }),
]);

export const pinnedPublicKeys = (list = LUMI_SIGNING_KEYS) => list.filter((k) => k.status !== "retired").map((k) => k.public_key.toLowerCase());
