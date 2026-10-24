/**
 * Lumi Check: free pre-pay trust check, usable from code or as an x402 / MCP payment hook.
 *   const lumi = createLumiCheck();                       // fail-open, 2.5 s timeout
 *   const r = await lumi.check({ url, payTo, amount: "10000", asset, network });
 *   r.decision: "allow" | "warn" | "block"; r.reasons; r.score; r.link; r.verified (Lumi signature checked)
 *
 * Fail mode (default "open"): if Lumi is unreachable, slow, or returns an unsigned/invalid verdict, the result is
 * decision "warn" with reason lumi_unreachable / lumi_unverified, and the payment proceeds. "closed" turns those into "block".
 * Only origin + path of the URL is sent (query strings dropped). Tier-1 outcome reporting is separate (telemetry.js).
 */
import { originPath } from "./origin.js";
import { verifyLumiSigned } from "./lumi_signed.js";
import { loadConfig } from "./config.js";
import { reportOutcome } from "./telemetry.js";
import { kitHeader, DEFAULT_API } from "./version.js";

/** Known USDC decimals (Base/Base Sepolia = 6, Stellar = 7). Unknown assets: amount_usd is omitted. */
const USDC = {
  "eip155:8453": { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6 },
  "eip155:84532": { "0x036cbd53842c5426634e7929541ec2318f3dcf7e": 6 },
};
export function amountUsdOf(req) {
  if (!req) return undefined;
  const net = String(req.network ?? ""), asset = String(req.asset ?? "").toLowerCase(), amt = String(req.amount ?? req.maxAmountRequired ?? "");
  if (!/^\d{1,30}$/.test(amt)) return undefined;
  let dec = USDC[net]?.[asset];
  if (dec === undefined && net.startsWith("stellar:") && /usdc/i.test(asset + JSON.stringify(req.extra ?? {}))) dec = 7;
  if (dec === undefined) return undefined;
  return Number(amt) / 10 ** dec;
}
/** Lumi's server accepts EVM, XRPL and Solana-style payTo; anything else is omitted rather than rejected. */
const PAYTO_OK = /^(0x[0-9a-fA-F]{40}|r[1-9A-HJ-NP-Za-km-z]{24,34}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const payToOf = (p) => (p && PAYTO_OK.test(String(p)) ? String(p) : undefined);

export function createLumiCheck({ api = DEFAULT_API, publicKeys, timeoutMs, failMode, fetchImpl = fetch, config, configPath, env, now = () => Date.now() } = {}) {
  const cfg = config ?? loadConfig(configPath, env);
  const base = api.replace(/\/+$/, "");
  const ms = timeoutMs ?? cfg.timeout_ms ?? 2500;
  const mode = (failMode ?? cfg.fail_mode) === "closed" ? "closed" : "open";
  let keys = publicKeys ?? cfg.public_keys ?? null;

  async function trustedKeys() {
    if (keys?.length) return keys;
    const r = await fetchImpl(base + "/v1/check/keys", { headers: { "Lumi-Kit": kitHeader() }, signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    keys = (j.keys ?? []).map((k) => k.public_key).filter(Boolean);
    return keys;
  }
  const unavailable = (code, detail, extra = {}) => ({
    decision: mode === "closed" ? "block" : "warn", reasons: [{ code, severity: mode === "closed" ? "block" : "warn", detail }],
    score: null, link: null, verified: false, fail_mode: mode, unavailable: true, ...extra,
  });

  async function check({ url, payTo, amount, amountUsd, asset, network } = {}) {
    const clean = originPath(url);
    const pt = payToOf(payTo);
    const usd = amountUsd ?? amountUsdOf({ amount, asset, network });
    if (!clean && !pt) return unavailable("lumi_no_subject", "Nothing to check: no http(s) URL and no supported payTo.");
    const q = new URLSearchParams({ ...(clean ? { url: clean } : {}), ...(pt ? { payTo: pt } : {}), ...(usd !== undefined && Number.isFinite(usd) ? { amount: String(+usd.toFixed(6)) } : {}), ...(network ? { network: String(network).slice(0, 40) } : {}) });
    let j;
    try {
      const res = await fetchImpl(`${base}/v1/check?${q}`, { headers: { "Lumi-Kit": kitHeader() }, signal: AbortSignal.timeout(ms) });
      j = await res.json().catch(() => null);
      if (!res.ok || !j) return unavailable("lumi_unreachable", `Lumi Check returned HTTP ${res.status}.`, { status: res.status });
    } catch (e) {
      return unavailable("lumi_unreachable", e?.name === "TimeoutError" ? `No answer within ${ms} ms.` : "Network error reaching Lumi.");
    }
    let v;
    try { v = verifyLumiSigned(j.receipt, { publicKeys: await trustedKeys(), now: now() }); } catch { v = { ok: false, errors: ["keys_unavailable"] }; }
    if (!v.ok) return unavailable("lumi_unverified", `Lumi's signature did not verify (${(v.errors ?? []).join(", ")}).`);
    const p = j.receipt.payload; // the signed payload is the source of truth
    return { decision: p.decision, reasons: p.reasons, score: p.score, link: p.link, matched: p.matched, verified: true, key_id: v.key_id, receipt: j.receipt, fail_mode: mode };
  }
  return {
    check,
    config: cfg,
    /** Tier 1 (OFF until the user says yes): seller host + delivered yes/no + status class only. */
    reportOutcome: (o) => reportOutcome(o, { api: base, fetchImpl, config: cfg }),
  };
}

const reasonText = (r) => `Lumi Check ${r.decision}: ${(r.reasons ?? []).map((x) => x.code).join(", ") || "no reasons"}${r.link ? ` (${r.link})` : ""}`;

/**
 * x402 client hook: client.onBeforePaymentCreation(x402BeforePaymentHook(lumi)).
 * Aborts on "block" (and on "warn" if blockOnWarn). Otherwise returns undefined so the payment proceeds.
 */
export function x402BeforePaymentHook(lumi, { blockOnWarn = false, onResult } = {}) {
  return async ({ paymentRequired, selectedRequirements } = {}) => {
    const req = selectedRequirements ?? paymentRequired?.accepts?.[0];
    const r = await lumi.check({ url: paymentRequired?.resource?.url, payTo: req?.payTo, amount: req?.amount ?? req?.maxAmountRequired, asset: req?.asset, network: req?.network });
    onResult?.(r);
    if (r.decision === "block" || (blockOnWarn && r.decision === "warn")) return { abort: true, reason: reasonText(r) };
    return undefined;
  };
}

/**
 * @x402/mcp hook: mcpClient.onPaymentRequired(mcpOnPaymentRequiredHook(lumi)).
 * MCP tool resources are mcp://tool/<name>, so the check is by payTo only. Returns { abort: true } on block.
 */
export function mcpOnPaymentRequiredHook(lumi, { blockOnWarn = false, onResult } = {}) {
  return async ({ toolName, paymentRequired } = {}) => {
    const req = paymentRequired?.accepts?.[0];
    const url = paymentRequired?.resource?.url;
    const r = await lumi.check({ url: /^https?:/i.test(String(url ?? "")) ? url : undefined, payTo: req?.payTo, amount: req?.amount ?? req?.maxAmountRequired, asset: req?.asset, network: req?.network });
    onResult?.({ ...r, toolName });
    if (r.decision === "block" || (blockOnWarn && r.decision === "warn")) return { abort: true };
    return undefined;
  };
}

/**
 * Wrap a paying fetch (e.g. @x402/fetch wrapFetchWithPayment) so each paid call sends one tier-1 outcome
 * (seller host + delivered yes/no + status class) when telemetry is on. Unpaid calls send nothing.
 * The request, response body and payment details are never read or sent.
 */
export function withOutcomeReporting(paidFetch, lumi) {
  return async (input, init) => {
    const target = typeof input === "string" ? input : input?.url;
    let res;
    try { res = await paidFetch(input, init); }
    catch (e) { if (e?.name === "TimeoutError") void lumi.reportOutcome({ target, delivered: false, status: "timeout" }).catch(() => {}); throw e; }
    const paid = res.headers?.get?.("PAYMENT-RESPONSE") || res.headers?.get?.("X-PAYMENT-RESPONSE");
    if (paid) void lumi.reportOutcome({ target, delivered: res.ok, status: res.status }).catch(() => {});
    return res;
  };
}
