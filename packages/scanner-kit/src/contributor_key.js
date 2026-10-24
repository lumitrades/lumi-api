/** Contributor key: an ed25519 keypair that signs requests to Lumi. Separate from any wallet. */
import { ed25519 } from "@noble/curves/ed25519";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { hex, fromHex, b64, enc, sha256Hex } from "./util.js";

export function generateKey() {
  const priv = ed25519.utils.randomPrivateKey();
  return { private_key: hex(priv), public_key: hex(ed25519.getPublicKey(priv)) };
}
export function saveKey(path, k) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
  writeFileSync(path, JSON.stringify(k, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}
export function loadKey(path) {
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (!/^[0-9a-f]{64}$/.test(j.private_key ?? "")) throw new Error("bad contributor key file");
  return { key_id: j.key_id, private_key: j.private_key, public_key: j.public_key ?? hex(ed25519.getPublicKey(fromHex(j.private_key))) };
}
export const signedMessage = (method, pathAndQuery, ts, bodySha256) => `lumi-contrib/v0\n${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${bodySha256}`;
export function signRequest(privateKeyHex, method, pathAndQuery, body, ts = String(Date.now())) {
  const msg = signedMessage(method, pathAndQuery, ts, sha256Hex(body ?? ""));
  return { ts, signature: b64(ed25519.sign(enc.encode(msg), fromHex(privateKeyHex))) };
}
