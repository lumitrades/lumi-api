/**
 * Wallet signers for receipts. Secrets come from the caller (env or a file path) and are never printed or sent.
 *   XRPL:    ripple-keypairs sign(utf8Hex(message), privateKey)    key_type "ripple-keypairs"
 *   Stellar: ed25519 over the UTF-8 message, base64                 key_type "stellar-ed25519"
 *   Base:    EIP-191 personal_sign (viem, optional peer dep)        key_type "eip191"
 */
import { ed25519 } from "@noble/curves/ed25519";
import { enc, b64, utf8Hex } from "./util.js";
import { decodeSecret, encodePublic } from "./strkey.js";

export async function signerFor(network, secret) {
  if (!secret) throw new Error(`no wallet secret for ${network}`);
  if (network === "xrpl:0") {
    const kp = await import("ripple-keypairs");
    const { privateKey, publicKey } = kp.deriveKeypair(secret);
    const address = kp.deriveAddress(publicKey);
    return { network, address, key_type: "ripple-keypairs", public_key: publicKey, sign: async (m) => kp.sign(utf8Hex(m), privateKey) };
  }
  if (network === "stellar:pubnet") {
    const seed = decodeSecret(secret);
    const pub = ed25519.getPublicKey(seed);
    const address = encodePublic(pub);
    return { network, address, key_type: "stellar-ed25519", sign: async (m) => b64(ed25519.sign(enc.encode(m), seed)) };
  }
  if (network === "eip155:8453") {
    const { privateKeyToAccount } = await import("viem/accounts");
    const acct = privateKeyToAccount(secret.startsWith("0x") ? secret : "0x" + secret);
    return { network, address: acct.address, key_type: "eip191", sign: async (m) => acct.signMessage({ message: m }) };
  }
  throw new Error("unsupported network " + network);
}

/** Wallet secret for a network from env (LUMI_KIT_XRPL_SEED / LUMI_KIT_STELLAR_SECRET / LUMI_KIT_EVM_KEY) or a *_FILE path. */
export async function secretFromEnv(network, env = process.env) {
  const name = network === "xrpl:0" ? "LUMI_KIT_XRPL_SEED" : network === "stellar:pubnet" ? "LUMI_KIT_STELLAR_SECRET" : "LUMI_KIT_EVM_KEY";
  if (env[name]) return env[name].trim();
  if (env[name + "_FILE"]) {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(env[name + "_FILE"], "utf8").trim();
    if (raw.startsWith("{")) {
      const j = JSON.parse(raw);
      return String(j.seed ?? j.secret ?? j.privateKey ?? j.private_key ?? "").trim() || undefined;
    }
    return raw;
  }
  return undefined;
}
