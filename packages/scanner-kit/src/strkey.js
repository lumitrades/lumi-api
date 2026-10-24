// Minimal Stellar StrKey (G... public, S... secret seed). Base32 + CRC16-XModem.
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
function b32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error("bad strkey"); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Uint8Array.from(out);
}
function b32encode(u8) {
  let bits = 0, val = 0, out = "";
  for (const b of u8) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}
function decode(version, s) {
  const raw = b32decode(s);
  if (raw.length !== 35 || raw[0] !== version) throw new Error("bad strkey");
  const crc = crc16(raw.slice(0, 33));
  if (raw[33] !== (crc & 0xff) || raw[34] !== crc >> 8) throw new Error("bad strkey checksum");
  return raw.slice(1, 33);
}
function encode(version, key) {
  const body = Uint8Array.from([version, ...key]);
  const crc = crc16(body);
  return b32encode(Uint8Array.from([...body, crc & 0xff, crc >> 8]));
}
export const decodeSecret = (s) => decode(18 << 3, s);
export const decodePublic = (g) => decode(6 << 3, g);
export const encodePublic = (pk) => encode(6 << 3, pk);
