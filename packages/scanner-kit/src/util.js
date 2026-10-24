import { sha256 } from "@noble/hashes/sha256";

export const enc = new TextEncoder();
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
export const sha256Hex = (s) => hex(sha256(typeof s === "string" ? enc.encode(s) : s));
export const b64 = (u8) => Buffer.from(u8).toString("base64");
export const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
export const utf8Hex = (s) => hex(enc.encode(s)).toUpperCase();

/** RFC 8785-style canonical JSON (same rules as Lumi's verifier): sorted keys, no whitespace, undefined dropped. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/** Strip anything that looks like a secret before printing (defence in depth: the kit never prints secrets). */
export function redact(s) {
  return String(s)
    .replace(/\bs[1-9A-HJ-NP-Za-km-z]{28,}\b/g, "s***")
    .replace(/\bS[A-Z2-7]{55}\b/g, "S***")
    .replace(/0x[0-9a-fA-F]{64}\b/g, "0x***")
    .replace(/("?(?:private_?key|privateKey|secret|seed)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1***");
}
