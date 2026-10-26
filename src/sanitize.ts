/**
 * Privacy filter applied to every paid response. Lumi's public JSON is already
 * public, but it is hand-edited, so anything that refers to a named private
 * person or to personal holdings/positions is removed: keys are dropped, and
 * free text is filtered sentence by sentence.
 *
 * Names to block are not hard-coded: they come from the PRIVATE_NAMES env var
 * (comma-separated, set with `wrangler secret put PRIVATE_NAMES`).
 */

import { isSignedObject } from "./signed";

const BLOCKED_KEY = /(holdings?|portfolio|personal|private|owner|wallet|seed|secret)/i;

let nameText: RegExp | null = null;
let nameKey: RegExp | null = null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Configure the private names to filter (comma-separated string or list). */
export function setPrivateNames(names: string | string[] | undefined): void {
  const list = (Array.isArray(names) ? names : (names ?? "").split(","))
    .map((n) => n.trim())
    .filter(Boolean)
    .map(escapeRe);
  nameText = list.length ? new RegExp(`\\b(${list.join("|")})\\b`, "i") : null;
  nameKey = list.length ? new RegExp(`(${list.join("|")})`, "i") : null;
}

const BLOCKED_TEXT = [
  /\b(my|our|his|her|their|personal)\s+(own\s+)?(holdings?|bags?|stack|portfolio|positions?|coins|stake)\b/i,
  /\b(i|we)\s+(hold|own|bought|sold|am holding|are holding)\b/i,
  /\buser[- ]specified\b/i,
];

export function isBlockedText(s: string): boolean {
  return (nameText?.test(s) ?? false) || BLOCKED_TEXT.some((re) => re.test(s));
}

/**
 * Split prose into sentences. Only breaks on . ! ? followed by whitespace and an
 * uppercase letter, digit, quote or bracket, so "$82.0K", "1.25%" and "U.S." stay intact.
 */
export function splitSentences(s: string): string[] {
  return s
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[$~])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Remove sentences that trip the filter; keep the rest of the text intact. */
export function scrubText(s: string): string {
  if (!isBlockedText(s)) return s;
  return splitSentences(s)
    .filter((x) => !isBlockedText(x))
    .join(" ")
    .trim();
}

export function sanitize<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (typeof v === "string") return scrubText(v);
  if (Array.isArray(v)) {
    return v.map(walk).filter((x) => !(typeof x === "string" && x === ""));
  }
  if (isSignedObject(v)) return v; // signed receipts are public evidence and must stay byte-for-byte as signed
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (BLOCKED_KEY.test(k) || nameKey?.test(k)) continue;
      out[k] = walk(val);
    }
    return out;
  }
  return v;
}
