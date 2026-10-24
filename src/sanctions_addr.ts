/**
 * Address normalisation for the OFAC screen (no data import, so Node runners can use it too: scripts/ofac_guard.ts).
 * EVM 0x -> lower-case; XRPL X-address / "r...:tag" / "r...?dt=" -> classic r-address; Stellar M (muxed) -> G, upper-cased.
 */
import { sha256 } from "@noble/hashes/sha256";

export type AddressFormat = "evm" | "xrpl" | "stellar";
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const XRPL_CLASSIC_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const XRPL_X_RE = /^[XT][1-9A-HJ-NP-Za-km-z]{46}$/;
const STELLAR_G_RE = /^G[A-Z2-7]{55}$/;
const STELLAR_M_RE = /^M[A-Z2-7]{68}$/;
const RIPPLE_B58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

function b58decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) { const i = RIPPLE_B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== RIPPLE_B58[0]) break; out.unshift(0); }
  return Uint8Array.from(out);
}
function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) { s = RIPPLE_B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = RIPPLE_B58[0] + s; }
  return s;
}
const dsha = (b: Uint8Array) => sha256(sha256(b));
function checked(b: Uint8Array | null): Uint8Array | null {
  if (!b || b.length < 5) return null;
  const body = b.slice(0, -4), sum = dsha(body);
  for (let i = 0; i < 4; i++) if (sum[i] !== b[b.length - 4 + i]) return null;
  return body;
}
/** XRPL X-address (mainnet X / testnet T) -> classic r-address, or null when not a valid X-address. */
export function xAddressToClassic(x: string): string | null {
  const body = checked(b58decode(x));
  if (!body || body.length !== 31) return null;
  const mainnet = body[0] === 0x05 && body[1] === 0x44, test = body[0] === 0x04 && body[1] === 0x93;
  if (!mainnet && !test) return null;
  const payload = Uint8Array.from([0x00, ...body.slice(2, 22)]);
  return b58encode(Uint8Array.from([...payload, ...dsha(payload).slice(0, 4)]));
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s: string): Uint8Array | null {
  let bits = 0, v = 0; const out: number[] = [];
  for (const c of s) { const i = B32.indexOf(c); if (i < 0) return null; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Uint8Array.from(out);
}
function b32encode(b: Uint8Array): string {
  let bits = 0, v = 0, s = "";
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { s += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) s += B32[(v << (5 - bits)) & 31];
  return s;
}
function crc16x(b: Uint8Array): number {
  let crc = 0;
  for (const x of b) { crc ^= x << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
function strkey(version: number, payload: Uint8Array): string {
  const d = Uint8Array.from([version, ...payload]), c = crc16x(d);
  return b32encode(Uint8Array.from([...d, c & 0xff, c >> 8]));
}
/** Stellar muxed M-address -> its underlying G account, or null when the checksum/version is wrong. */
export function muxedToAccount(m: string): string | null {
  const b = b32decode(m);
  if (!b || b.length !== 43 || b[0] !== 12 << 3) return null;
  const c = crc16x(b.slice(0, 41));
  if (b[41] !== (c & 0xff) || b[42] !== c >> 8) return null;
  return strkey(6 << 3, b.slice(1, 33));
}

/** Canonical form used for matching, or null when the string is not an EVM / XRPL / Stellar address. */
export function normalizeAddress(raw: string): { format: AddressFormat; normalized: string } | null {
  let a = String(raw ?? "").trim();
  if (!a) return null;
  a = a.replace(/^(?:eip155:\d+:|xrpl:\d+:|stellar:(?:pubnet|testnet):)/i, "");
  if (EVM_RE.test(a)) return { format: "evm", normalized: a.toLowerCase() };
  const tagless = a.split(/[:?]/)[0]; // "rXXX:12345" or "rXXX?dt=12345"
  if (XRPL_CLASSIC_RE.test(tagless)) return { format: "xrpl", normalized: tagless };
  if (XRPL_X_RE.test(a)) { const c = xAddressToClassic(a); return c ? { format: "xrpl", normalized: c } : null; }
  const up = a.toUpperCase();
  if (STELLAR_G_RE.test(up)) return { format: "stellar", normalized: up };
  if (STELLAR_M_RE.test(up)) { const g = muxedToAccount(up); return g ? { format: "stellar", normalized: g } : null; }
  return null;
}

