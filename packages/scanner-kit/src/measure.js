/** Test data the kit measures. Only hashes, sizes and shape leave the machine, never the response body. */
import { sha256Hex, enc } from "./util.js";

/** Shape of a JSON value: sorted key paths with types, arrays collapsed to their first element. */
export function schemaShape(v, path = "$", out = new Set(), depth = 0) {
  if (depth > 8 || out.size > 400) return out;
  const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  out.add(`${path}:${t}`);
  if (t === "array" && v.length) schemaShape(v[0], path + "[]", out, depth + 1);
  else if (t === "object") for (const k of Object.keys(v).sort()) schemaShape(v[k], `${path}.${k}`, out, depth + 1);
  return out;
}
export const schemaFingerprint = (v) => sha256Hex([...schemaShape(v)].sort().join("\n")).slice(0, 32);

const TS_KEYS = /^(as_of|asOf|timestamp|time|ts|updated_at|updatedAt|generated_at|generatedAt|last_updated|lastUpdated|date|created_at|createdAt|observed_at)$/;
/** Newest timestamp-like field near the top of the JSON (depth <= 3). */
export function dataTimestamp(v, depth = 0) {
  if (!v || typeof v !== "object" || depth > 3) return null;
  let best = null;
  for (const [k, x] of Object.entries(Array.isArray(v) ? { 0: v[0] } : v)) {
    let t = null;
    if (TS_KEYS.test(k)) {
      if (typeof x === "string" && /\d{4}-\d{2}-\d{2}/.test(x)) t = Date.parse(x);
      else if (typeof x === "number") t = x > 1e12 ? x : x > 1e9 ? x * 1000 : null;
    } else if (x && typeof x === "object") t = dataTimestamp(x, depth + 1);
    if (t && Number.isFinite(t) && (!best || t > best)) best = t;
  }
  return best;
}

/** Measurements of one HTTP response body. */
export function measureBody(bytes, contentType, now = Date.now()) {
  const u8 = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  const m = { response_bytes: u8.length, response_sha256: sha256Hex(u8), content_type: contentType ? String(contentType).slice(0, 80) : undefined };
  if (/json/i.test(contentType ?? "") || /^[\s]*[[{]/.test(new TextDecoder().decode(u8.slice(0, 8)))) {
    try {
      const j = JSON.parse(new TextDecoder().decode(u8));
      m.schema_fingerprint = schemaFingerprint(j);
      const ts = dataTimestamp(j);
      if (ts) { m.data_timestamp = new Date(ts).toISOString(); m.freshness_s = Math.round((now - ts) / 1000); }
    } catch { /* not JSON */ }
  }
  return m;
}

/** Did the paid call deliver data? Same outcome words as the receipt format. */
export function outcomeOf(status, bytes, json) {
  if (status == null || status === 0) return "timeout";
  if (status < 200 || status >= 300) return "error_status";
  if (!bytes) return "no_data";
  if (json !== undefined && (json === null || (Array.isArray(json) && !json.length) || (typeof json === "object" && !Array.isArray(json) && !Object.keys(json).length))) return "empty_result";
  return "delivered";
}
