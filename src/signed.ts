/**
 * Signed objects (ars-evidence `counterparty_delivery_receipt`s) are opaque to every response transform.
 * Their receipt_hash covers the canonical JSON of the exact fields and values that were signed, so any rewrite
 * (timestamp normalisation "…:11.000Z" -> "…:11Z", null-dropping, text scrubbing, key filtering) breaks the hash and
 * the signature. Body walkers (isoTimestamps, compact, sanitize) must return these unchanged.
 */
export function isSignedObject(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.receipt_hash === "string" && !!o.signer && typeof o.signer === "object" && !Array.isArray(o.signer);
}
