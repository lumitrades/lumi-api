/**
 * Free trial calls (v1.0): a few free calls per new wallet, wire-compatible with the x402 "sign-in-with-x" (SIWX,
 * CAIP-122 / EIP-4361) extension, so `wrapFetchWithSIWx` / `createSIWxClientHook` from @x402/extensions work unchanged.
 *
 * Flow: a plain unauthenticated 402 is a standard x402 payment quote (prices first) with a top-level `trial` hint. A client
 * that opts in with header `X-Lumi-Trial: 1` gets the same 402 plus `extensions["sign-in-with-x"]` (a one-time challenge;
 * opt-in so discovery scanners never list the paid routes as identity-only SIWX routes). The client signs
 * the EIP-4361 message with its Base wallet (EOA, EIP-191) and retries with header `SIGN-IN-WITH-X: base64(JSON payload)`.
 * XRPL wallets (v1.1.3) answer the same challenge with `type: "xrpl"`: the same CAIP-122 message with "XRP Ledger account" and
 * `Chain ID: 0`, signed with ripple-keypairs over its UTF-8 bytes; the payload adds `publicKey`. The key must derive to the
 * address (master key, not disabled) or be the account's current RegularKey (checked on the validated ledger).
 * If the signature, challenge and caps check out, the call is served free (`access.mode = "trial"`, nothing settled).
 *
 * Abuse resistance:
 * - the challenge nonce is random + HMAC(secret) over (issuedAt, expiry, exact URL): only Lumi can mint one, it is bound to
 *   one URL and expires after 5 minutes; each nonce can be used once (D1 primary key);
 * - the signer must be a funded wallet that could pay: at least 0.01 USDC on Base, or an activated XRPL account (the
 *   account reserve is already locked), checked on-chain;
 * - caps, enforced in one atomic INSERT over one shared ledger for both chains: 3 trial calls per wallet ever, 3 per (daily-rotating keyed) IP hash per day, and a
 *   global daily cap. Raw IPs are never stored.
 * - every paid route is eligible (the daily policy brief /v1/institutional, $0.10, since Oct 23 2026); anything above $0.10 is not.
 */
import type { D1Like, PaidRoute } from "./config";
import { recoverEvmSigner, verifyXrplSignature, xrplAddressOf, XRPL_ADDR_RE } from "./trust/verify";

export const SIWX_KEY = "sign-in-with-x";
export const SIWX_HEADER = "SIGN-IN-WITH-X";
/** Request header that opts in to the SIWX trial challenge on a 402. */
export const TRIAL_OPT_IN_HEADER = "X-Lumi-Trial";
export const TRIAL_CHAIN = "eip155:8453";
/** SIWX signature type for XRPL wallets (Lumi-defined; the official client hooks ignore types they do not sign). */
export const XRPL_SIWX_TYPE = "xrpl";
export type TrialChain = { chainId: string; type: string };
/** supportedChains for the challenge: Base (when configured) first, then the XRP Ledger network. */
export function trialChains(evmNetwork: string | undefined, xrplNetwork: string): TrialChain[] {
  return [...(evmNetwork ? [{ chainId: evmNetwork, type: "eip191" }] : []), { chainId: xrplNetwork, type: XRPL_SIWX_TYPE }];
}
export const TRIAL_LIMITS = { perWallet: 3, perIpDay: 3, globalDay: 300, challengeTtlSec: 300, maxUsd: 0.10, minUsdcAtomic: 10_000n };
export const TRIAL_EXCLUDED: PaidRoute[] = [];
export const TRIAL_STATEMENT = "Lumi API free trial: sign to prove you control this wallet. This is not a payment and moves no funds.";

export const TRIAL_SUMMARY =
  `Free trial: ${TRIAL_LIMITS.perWallet} free calls per new wallet in total (not per endpoint), usable on any paid endpoint. ` +
  `Send the request with header X-Lumi-Trial: 1 and the 402 also carries extensions["sign-in-with-x"] (x402 SIWX, CAIP-122): sign it with a ` +
  `Base wallet holding at least 0.01 USDC (EIP-4361, @x402/extensions wrapFetchWithSIWx does this) or an activated XRP Ledger account ` +
  `(type "xrpl", ripple-keypairs signature plus publicKey) and retry with the SIGN-IN-WITH-X header. ` +
  `Nothing is charged; caps: ${TRIAL_LIMITS.perWallet} per wallet (one trial per wallet, whichever chain), ${TRIAL_LIMITS.perIpDay} per IP per day, one-time 5-minute challenges. ` +
  `Without that header every 402 is a plain x402 payment quote.`;

/** One-line trial terms for listings, MCP instructions and the index (keep in sync with TRIAL_SUMMARY). */
export const TRIAL_SHORT =
  `new wallets get ${TRIAL_LIMITS.perWallet} free trial calls over REST (x402 sign-in-with-x; nothing is charged or moved): a Base wallet holding at least 0.01 USDC or an activated XRP Ledger account, one trial per wallet`;

/** True when the client asked for the SIWX trial challenge (X-Lumi-Trial: 1 / true / yes). */
export function wantsTrial(request: Request): boolean {
  return /^(1|true|yes)$/i.test(request.headers.get(TRIAL_OPT_IN_HEADER)?.trim() ?? "");
}

/** Top-level `trial` hint on a plain (non-opted-in) 402 of an eligible route. Not an x402 extension. */
export function trialHint(): Record<string, unknown> {
  return {
    available: true,
    free_calls_per_wallet: TRIAL_LIMITS.perWallet,
    opt_in_header: `${TRIAL_OPT_IN_HEADER}: 1`,
    detail:
      `New wallets get ${TRIAL_LIMITS.perWallet} free calls: repeat this request with header ${TRIAL_OPT_IN_HEADER}: 1 to receive a one-time ` +
      `sign-in-with-x challenge, sign it with a Base wallet holding >= 0.01 USDC or an activated XRP Ledger account (type "xrpl", add publicKey) ` +
      `and retry with ${SIWX_HEADER}. Not a payment; or pay with any accepts[] option.`,
  };
}

export function trialEligible(route: PaidRoute, usd: number | undefined): boolean {
  return !TRIAL_EXCLUDED.includes(route) && typeof usd === "number" && usd > 0 && usd <= TRIAL_LIMITS.maxUsd;
}

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const isoS = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const SIWX_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    domain: { type: "string" }, address: { type: "string" }, statement: { type: "string" }, uri: { type: "string", format: "uri" },
    version: { type: "string" }, chainId: { type: "string" }, type: { type: "string" }, nonce: { type: "string" },
    issuedAt: { type: "string", format: "date-time" }, expirationTime: { type: "string", format: "date-time" },
    notBefore: { type: "string", format: "date-time" }, requestId: { type: "string" },
    resources: { type: "array", items: { type: "string", format: "uri" } }, signature: { type: "string" },
  },
  required: ["domain", "address", "uri", "version", "chainId", "type", "nonce", "issuedAt", "signature"],
};

const macMsg = (rand: string, issuedAt: string, exp: string, uri: string) => `lumi-siwx|${rand}|${issuedAt}|${exp}|${uri}`;

/** The `extensions["sign-in-with-x"]` declaration for one 402 (fresh nonce, bound to this exact URL). */
export async function siwxChallenge(secret: string, uri: string, now: number, chains: string | TrialChain[] = TRIAL_CHAIN) {
  const supportedChains = typeof chains === "string" ? [{ chainId: chains, type: "eip191" }] : chains;
  const rand = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const issuedAt = isoS(now);
  const expirationTime = isoS(now + TRIAL_LIMITS.challengeTtlSec * 1000);
  const nonce = rand + (await hmacHex(secret, macMsg(rand, issuedAt, expirationTime, uri))).slice(0, 24);
  return {
    info: { domain: new URL(uri).host, uri, version: "1", nonce, issuedAt, expirationTime, statement: TRIAL_STATEMENT, resources: [uri] },
    supportedChains,
    schema: SIWX_SCHEMA,
    lumi_trial: {
      free_calls_per_wallet: TRIAL_LIMITS.perWallet,
      header: SIWX_HEADER,
      requires: supportedChains.map((c) => (c.type === XRPL_SIWX_TYPE ? "activated XRP Ledger account (master key or current regular key)" : "Base EOA wallet holding >= 0.01 USDC")).join(", or "),
      ...(supportedChains.some((c) => c.type === XRPL_SIWX_TYPE)
        ? {
            xrpl: {
              type: XRPL_SIWX_TYPE,
              message: 'the CAIP-122 message for info, with "XRP Ledger account" in the first line and "Chain ID: 0" (mainnet) or "1" (testnet)',
              signature: "ripple-keypairs sign(<UTF-8 bytes of the message as uppercase hex>, privateKey)",
              payload_extra: { publicKey: "hex public key of the signing key (master key or the account's current RegularKey)" },
            },
          }
        : {}),
      one_trial_per_wallet: true,
      charged: false,
    },
  };
}

export interface SiwxPayload {
  domain: string; address: string; statement?: string; uri: string; version: string; chainId: string; type: string;
  nonce: string; issuedAt: string; expirationTime?: string; notBefore?: string; requestId?: string; resources?: string[]; signature: string;
  /** XRPL only: the public key that signed (master key or the account's RegularKey). */
  publicKey?: string;
}

export function decodeSiwx(header: string): SiwxPayload | null {
  try {
    const bin = atob(header.trim().replace(/-/g, "+").replace(/_/g, "/"));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return p && typeof p === "object" && typeof p.address === "string" && typeof p.signature === "string" ? (p as SiwxPayload) : null;
  } catch {
    return null;
  }
}

/**
 * EIP-4361 message, byte-identical to SiweMessage.prepareMessage() (what @x402/extensions signs). For XRPL (`xrpl:N`) the same
 * CAIP-122 layout with "XRP Ledger account" and `Chain ID: N`.
 */
export function siweMessage(p: SiwxPayload): string {
  const xrpl = /^xrpl:/.test(p.chainId);
  const chainId = /^(?:eip155|xrpl):(\d+)$/.exec(p.chainId)?.[1] ?? p.chainId;
  let head = `${p.domain} wants you to sign in with your ${xrpl ? "XRP Ledger" : "Ethereum"} account:\n${p.address}`;
  head = p.statement === undefined ? `${head}\n\n` : `${[head, p.statement].join("\n\n")}\n`;
  const body = [`URI: ${p.uri}`, `Version: ${p.version}`, `Chain ID: ${chainId}`, `Nonce: ${p.nonce}`];
  if (p.issuedAt) body.push(`Issued At: ${p.issuedAt}`);
  if (p.expirationTime) body.push(`Expiration Time: ${p.expirationTime}`);
  if (p.notBefore) body.push(`Not Before: ${p.notBefore}`);
  if (p.requestId !== undefined) body.push(`Request ID: ${p.requestId}`);
  if (p.resources) body.push(["Resources:", ...p.resources.map((r) => `- ${r}`)].join("\n"));
  return [head, body.join("\n")].join("\n");
}

export type SiwxCheck =
  | { ok: true; wallet: string; nonce: string; chain: "evm" | "xrpl"; signingKeyAddress?: string }
  | { ok: false; reason: string };

/** Signature + challenge checks (no I/O). `uri` is the URL being requested now. */
export async function verifySiwx(secret: string, p: SiwxPayload, uri: string, now: number, chains: string | TrialChain[] = TRIAL_CHAIN): Promise<SiwxCheck> {
  const list = typeof chains === "string" ? [{ chainId: chains, type: "eip191" }] : chains;
  if (!list.some((c) => c.chainId === p.chainId && c.type === p.type)) {
    return { ok: false, reason: `unsupported_chain (${list.map((c) => `${c.chainId} ${c.type}`).join(" or ")} only)` };
  }
  const isXrpl = p.type === XRPL_SIWX_TYPE;
  if (isXrpl ? !XRPL_ADDR_RE.test(p.address) : !/^0x[0-9a-fA-F]{40}$/.test(p.address)) return { ok: false, reason: "invalid_address" };
  if (p.version !== "1" || p.statement !== TRIAL_STATEMENT) return { ok: false, reason: "challenge_mismatch" };
  if (p.uri !== uri || p.domain !== new URL(uri).host || !Array.isArray(p.resources) || p.resources.length !== 1 || p.resources[0] !== uri) {
    return { ok: false, reason: "challenge_not_for_this_url" };
  }
  if (p.notBefore !== undefined || p.requestId !== undefined) return { ok: false, reason: "challenge_mismatch" };
  if (typeof p.nonce !== "string" || !/^[0-9a-f]{40}$/.test(p.nonce) || typeof p.issuedAt !== "string" || typeof p.expirationTime !== "string") {
    return { ok: false, reason: "invalid_challenge" };
  }
  const mac = (await hmacHex(secret, macMsg(p.nonce.slice(0, 16), p.issuedAt, p.expirationTime, uri))).slice(0, 24);
  if (mac !== p.nonce.slice(16)) return { ok: false, reason: "challenge_not_issued_by_lumi" };
  const iat = Date.parse(p.issuedAt);
  const exp = Date.parse(p.expirationTime);
  if (!(exp - iat === TRIAL_LIMITS.challengeTtlSec * 1000) || iat > now + 60_000) return { ok: false, reason: "invalid_challenge" };
  if (now > exp) return { ok: false, reason: "challenge_expired" };
  if (isXrpl) {
    const pk = typeof p.publicKey === "string" ? p.publicKey.trim() : "";
    if (!/^(ED[0-9A-F]{64}|0[23][0-9A-F]{64})$/i.test(pk)) return { ok: false, reason: "public_key_required_for_xrpl" };
    if (typeof p.signature !== "string" || !/^[0-9A-Fa-f]{64,200}$/.test(p.signature)) return { ok: false, reason: "invalid_signature" };
    if (!verifyXrplSignature(siweMessage(p), p.signature, pk)) return { ok: false, reason: "invalid_signature" };
    const keyAddr = xrplAddressOf(pk);
    if (!keyAddr) return { ok: false, reason: "invalid_signature" };
    // Whether that key controls p.address (master key not disabled, or the current RegularKey) is a ledger check: see xrplTrialAccount.
    return { ok: true, wallet: p.address, nonce: p.nonce, chain: "xrpl", signingKeyAddress: keyAddr };
  }
  const signer = recoverEvmSigner(siweMessage(p), p.signature);
  if (!signer || signer !== p.address.toLowerCase()) return { ok: false, reason: "invalid_signature (EOA EIP-191 signatures only)" };
  return { ok: true, wallet: signer, nonce: p.nonce, chain: "evm" };
}

/** lsfDisableMaster: the master key may no longer sign for the account. */
export const LSF_DISABLE_MASTER = 0x00100000;

/**
 * Ledger half of the XRPL trial check (one validated account_info read, no writes): the account must be activated, and
 * the signing key must control it (the master key while not disabled, or the current RegularKey).
 */
export async function xrplTrialAccount(
  f: typeof fetch,
  urls: string[],
  account: string,
  signingKeyAddress: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const url of urls) {
    try {
      const r = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "account_info", params: [{ account, ledger_index: "validated" }] }),
        signal: AbortSignal.timeout(4000),
      });
      const res = ((await r.json()) as { result?: { account_data?: { Flags?: number; RegularKey?: string }; error?: string } })?.result;
      if (res?.error === "actNotFound") return { ok: false, reason: "xrpl_account_not_activated" };
      const ad = res?.account_data;
      if (!ad) continue;
      if (signingKeyAddress === account) {
        return (Number(ad.Flags ?? 0) & LSF_DISABLE_MASTER) ? { ok: false, reason: "xrpl_master_key_disabled (sign with the regular key)" } : { ok: true };
      }
      return ad.RegularKey && ad.RegularKey === signingKeyAddress ? { ok: true } : { ok: false, reason: "signing_key_does_not_control_address" };
    } catch {
      /* next endpoint */
    }
  }
  return { ok: false, reason: "ledger_check_unavailable" };
}

// ---------------------------------------------------------------- storage

export interface TrialUse { nonce: string; wallet: string; ip_hash: string | null; day: string; route: string; ts: number }
export type ClaimResult = { ok: true; used: number } | { ok: false; reason: "nonce_used" | "wallet_trial_used_up" | "ip_daily_cap" | "global_daily_cap" };

export interface TrialStore {
  /** Atomically record one trial use if every cap allows it. */
  claim(u: TrialUse): Promise<ClaimResult>;
  usedByWallet(wallet: string): Promise<number>;
}

const L = TRIAL_LIMITS;

export class MemoryTrialStore implements TrialStore {
  rows: TrialUse[] = [];
  async claim(u: TrialUse): Promise<ClaimResult> {
    if (this.rows.some((r) => r.nonce === u.nonce)) return { ok: false, reason: "nonce_used" };
    const w = this.rows.filter((r) => r.wallet === u.wallet).length;
    if (w >= L.perWallet) return { ok: false, reason: "wallet_trial_used_up" };
    if (u.ip_hash && this.rows.filter((r) => r.ip_hash === u.ip_hash && r.day === u.day).length >= L.perIpDay) return { ok: false, reason: "ip_daily_cap" };
    if (this.rows.filter((r) => r.day === u.day).length >= L.globalDay) return { ok: false, reason: "global_daily_cap" };
    this.rows.push(u);
    return { ok: true, used: w + 1 };
  }
  async usedByWallet(wallet: string) {
    return this.rows.filter((r) => r.wallet === wallet).length;
  }
}

export class D1TrialStore implements TrialStore {
  constructor(private db: D1Like) {}
  async claim(u: TrialUse): Promise<ClaimResult> {
    const r = (await this.db
      .prepare(
        "INSERT OR IGNORE INTO trial_uses (nonce, wallet, ip_hash, day, route, ts) SELECT ?,?,?,?,?,? WHERE " +
          "(SELECT COUNT(*) FROM trial_uses WHERE wallet = ?) < ? AND " +
          "(? IS NULL OR (SELECT COUNT(*) FROM trial_uses WHERE ip_hash = ? AND day = ?) < ?) AND " +
          "(SELECT COUNT(*) FROM trial_uses WHERE day = ?) < ?",
      )
      .bind(u.nonce, u.wallet, u.ip_hash, u.day, u.route, u.ts, u.wallet, L.perWallet, u.ip_hash, u.ip_hash, u.day, L.perIpDay, u.day, L.globalDay)
      .run()) as { meta?: { changes?: number } };
    if ((r?.meta?.changes ?? 0) === 1) return { ok: true, used: await this.usedByWallet(u.wallet) };
    const row = await this.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM trial_uses WHERE nonce = ?) AS n, (SELECT COUNT(*) FROM trial_uses WHERE wallet = ?) AS w, " +
          "(SELECT COUNT(*) FROM trial_uses WHERE ip_hash = ? AND day = ?) AS i",
      )
      .bind(u.nonce, u.wallet, u.ip_hash, u.day)
      .first<{ n: number; w: number; i: number }>();
    if (Number(row?.n) > 0) return { ok: false, reason: "nonce_used" };
    if (Number(row?.w) >= L.perWallet) return { ok: false, reason: "wallet_trial_used_up" };
    if (Number(row?.i) >= L.perIpDay) return { ok: false, reason: "ip_daily_cap" };
    return { ok: false, reason: "global_daily_cap" };
  }
  async usedByWallet(wallet: string) {
    const row = await this.db.prepare("SELECT COUNT(*) AS c FROM trial_uses WHERE wallet = ?").bind(wallet).first<{ c: number }>();
    return Number(row?.c ?? 0);
  }
}

export async function trialIpHash(request: Request, secret: string, day: string): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? null;
  return ip ? (await hmacHex(secret, `trial|${day}|${ip}`)).slice(0, 32) : null;
}

/** USDC (atomic) balance of `wallet` on Base via eth_call balanceOf; null when the RPC fails. */
export async function usdcBalance(f: typeof fetch, rpc: string | string[], token: string, wallet: string): Promise<bigint | null> {
  const data = "0x70a08231" + wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  // Public RPCs throttle Workers egress now and then: try each endpoint in turn (4 s each) before giving up.
  for (const url of Array.isArray(rpc) ? rpc : [rpc]) {
    try {
      const r = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
        signal: AbortSignal.timeout(4000),
      });
      const j = (await r.json()) as { result?: string };
      if (typeof j.result === "string" && /^0x[0-9a-f]*$/i.test(j.result)) return BigInt(j.result === "0x" ? 0 : j.result);
    } catch {
      /* next endpoint */
    }
  }
  return null;
}
