/**
 * Live check (paid /v1/trust/check, $0.02): Lumi contacts the seller at call time (one unpaid request, never a payment
 * header), reads its x402 quote and compares quote, price, payTo and TLS against the last values Lumi has on record.
 * The free /v1/check stays cached; any safety-relevant change found here is also stored as a live alert that the free
 * check shows at once (safety is never held behind the paid call).
 */
import { optUsd } from "./catalog";

export const LIVE_CHECK_NOTE =
  "live: Lumi contacted the seller during this call (one unpaid request; no payment was sent to the seller) and compared its quote with Lumi's record. live_evidence is signed and timestamped; verify it at /v1/check/keys. The free /v1/check answers from cached data and shows data_age; safety changes found here appear there too, at once.";
export const LIVE_RULES_VERSION = "2026-10-25.l1";
export const LIVE_TIMEOUT_MS = 8_000;
export const LIVE_ALERT_TTL_MS = 48 * 3_600_000;
export const LIVE_ALERT_PREFIX = "live_alert:";
const UA = "LumiLiveCheck/1.0 (+https://api.lumitrades.io/v1/trust/methodology; unpaid quote check, no payment sent)";

/** What Lumi had on record before this call. Any field may be unknown. */
export interface LiveBaseline {
  pay_tos: string[];
  price_usd: string | null;
  quote_ok: boolean | null;
  https: boolean | null;
  as_of: string | null;
  source: string;
}

export type LiveChangeField = "quote" | "price" | "pay_to" | "tls";
export interface LiveChange { field: LiveChangeField; was: unknown; now: unknown; safety: boolean; text: string }

export interface LiveResult {
  checked_at: string;
  url: string;
  outcome: "unchanged" | "changed" | "no_baseline" | "no_quote" | "unreachable";
  http_status: number | null;
  latency_ms: number | null;
  tls: "pass" | "fail" | "unknown" | "not_https";
  quote: { x402: boolean; x402_version: number | null; networks: string[]; pay_tos: string[]; price_usd: string | null } | null;
  baseline: LiveBaseline;
  changes: LiveChange[];
  safety_change: boolean;
  note: string;
  rules_version: string;
}

function b64json(h: string): any {
  const bin = atob(h.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
const fmt = (n: number) => String(Number(n.toFixed(6)));
const lc = (s: string) => (s.startsWith("0x") ? s.toLowerCase() : s);

/** One unpaid request; never throws. `f` must not add payment headers (none are ever passed here). */
export async function liveProbe(f: typeof fetch, url: string, baseline: LiveBaseline, now: () => number): Promise<LiveResult> {
  const t0 = now();
  const https = url.startsWith("https://");
  const out: LiveResult = {
    checked_at: new Date(t0).toISOString(), url, outcome: "unreachable", http_status: null, latency_ms: null,
    tls: https ? "fail" : "not_https", quote: null, baseline, changes: [], safety_change: false, note: "", rules_version: LIVE_RULES_VERSION,
  };
  let pr: any = null;
  try {
    const r = await f(url, { method: "GET", headers: { Accept: "application/json", "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    out.latency_ms = now() - t0;
    out.http_status = r.status;
    // A TLS handshake that fails (bad or expired certificate) rejects the fetch, so any answer over https means TLS passed.
    if (https) out.tls = "pass";
    if (r.status === 402) {
      const h = r.headers.get("PAYMENT-REQUIRED");
      try {
        if (h) pr = b64json(h);
        else if (/json/i.test(r.headers.get("content-type") ?? "")) { const txt = await r.text(); if (txt.length <= 65_536) pr = JSON.parse(txt); }
      } catch { pr = null; }
    }
    if (!r.bodyUsed) await r.body?.cancel().catch(() => {});
  } catch (e) {
    out.latency_ms = now() - t0;
    const msg = String(e);
    // Only a certificate / handshake error counts as a TLS failure; a timeout or a plain network error says nothing about TLS.
    const tlsErr = https && /cert|tls|ssl|handshake/i.test(msg);
    if (https && !tlsErr) out.tls = "unknown";
    out.note = /timeout|abort/i.test(msg) ? `no answer within ${LIVE_TIMEOUT_MS / 1000} s` : tlsErr ? "TLS error (certificate or handshake)" : "network error";
  }
  const accepts: any[] = Array.isArray(pr?.accepts) ? pr.accepts.filter((a: any) => a && typeof a === "object") : [];
  if (out.http_status != null) {
    const usd = accepts.map(optUsd).find((x: number | null) => x != null) ?? null;
    out.quote = {
      x402: accepts.length > 0,
      x402_version: Number.isFinite(Number(pr?.x402Version)) ? Number(pr.x402Version) : null,
      networks: [...new Set(accepts.map((a) => String(a.network ?? "")).filter(Boolean))].slice(0, 8),
      pay_tos: [...new Set(accepts.map((a) => String(a.payTo ?? "")).filter(Boolean))].slice(0, 8),
      price_usd: usd == null ? null : fmt(usd),
    };
  }
  out.changes = compare(baseline, out);
  out.safety_change = out.changes.some((c) => c.safety);
  const known = baseline.pay_tos.length > 0 || baseline.price_usd != null || baseline.quote_ok != null;
  out.outcome = out.http_status == null ? "unreachable" : !out.quote?.x402 ? "no_quote" : out.changes.length ? "changed" : known ? "unchanged" : "no_baseline";
  if (!out.note) out.note = NOTES[out.outcome];
  return out;
}

const NOTES: Record<LiveResult["outcome"], string> = {
  unchanged: "The seller's live quote matches what Lumi has on record.",
  changed: "The seller's live quote differs from what Lumi has on record. See changes before paying.",
  no_baseline: "The seller answered with an x402 quote, but Lumi has no earlier record to compare it with.",
  no_quote: "The seller answered, but not with a readable x402 payment request.",
  unreachable: "The seller did not answer.",
};

export function compare(b: LiveBaseline, r: Pick<LiveResult, "quote" | "tls" | "http_status">): LiveChange[] {
  const ch: LiveChange[] = [];
  if (r.tls === "fail" && b.https) ch.push({ field: "tls", was: "pass", now: "fail", safety: true, text: "HTTPS worked before; the live request failed at the connection or TLS step." });
  if (b.quote_ok === true && !r.quote?.x402) ch.push({ field: "quote", was: "valid x402 quote", now: r.http_status == null ? "no answer" : `HTTP ${r.http_status} without a readable quote`, safety: false, text: "Lumi's last record had a valid x402 quote; the live request did not get one." });
  if (r.quote?.x402) {
    if (b.pay_tos.length && r.quote.pay_tos.length) {
      const known = new Set(b.pay_tos.map(lc));
      const fresh = r.quote.pay_tos.filter((p) => !known.has(lc(p)));
      if (fresh.length) ch.push({ field: "pay_to", was: b.pay_tos.slice(0, 4), now: fresh.slice(0, 4), safety: true, text: "The live quote pays an address Lumi has not seen for this seller. Confirm it with the seller before paying." });
    }
    if (b.price_usd != null && r.quote.price_usd != null && Math.abs(Number(b.price_usd) - Number(r.quote.price_usd)) > 1e-9) {
      const up = Number(r.quote.price_usd) > Number(b.price_usd);
      ch.push({ field: "price", was: b.price_usd, now: r.quote.price_usd, safety: up && Number(r.quote.price_usd) > Number(b.price_usd) * 2, text: up ? "The live price is higher than the listed price." : "The live price is lower than the listed price." });
    }
  }
  return ch;
}

/** The part of a live result the free check may show (safety changes only, with their age). */
export function liveAlertView(raw: string | null, now: number): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as { checked_at: string; url: string; changes: LiveChange[] };
    const at = Date.parse(a.checked_at);
    if (!Number.isFinite(at) || now - at > LIVE_ALERT_TTL_MS) return null;
    const changes = (a.changes ?? []).filter((c) => c.safety).map((c) => ({ field: c.field, text: c.text }));
    if (!changes.length) return null;
    return { checked_at: a.checked_at, age_seconds: Math.max(0, Math.round((now - at) / 1000)), url: a.url, changes, note: "A live check found a safety-relevant change. Safety findings are shown free and at once." };
  } catch { return null; }
}
