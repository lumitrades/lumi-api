/**
 * Trust layer v0: Lumi's automated observations of x402 vendors.
 *
 * - Free, unpaid 402-quote probes every 30 min (cron). No payment is ever sent by the Worker,
 *   and the Worker holds no wallet key.
 * - Paid test-buys are made box-side by the owner and recorded via the owner-only
 *   POST /v1/trust/observations (each tx is checked on-ledger before it is stored).
 * - Agent reports count only when the payment is verified on-ledger AND the payer signed the challenge.
 * - Tips are stored privately; nothing reads them back.
 * Public wording is factual: observed results with timestamps and tx evidence, never a judgement of the business.
 */
import { MONITOR_METHODOLOGY } from "../commerce/policy";
import { json } from "../x402";
import { isOwnerKey } from "../mcp";
import { scrubText } from "../sanitize";
import { VENDORS, vendorById, type Vendor, type VendorEndpoint } from "../vendors";
import type { Catalog } from "./catalog_service";
import { XRPL_BAZAAR_SWEEP } from "./catalog_service";
import { receiptMatchesBuy, receiptVerifyDoc, verifyReceipt, type Receipt, type ReceiptStore } from "./receipts";
import { dataReturnedView, deliveryCounts, deliveryState, deliveryText, guardBuy, inconclusiveReason, INCONCLUSIVE_REASONS, isInconclusiveReason } from "./delivery";
import { isStorageQuotaError, storageUnavailableBody } from "./storage_errors";
import type { LookupQuery } from "./catalog";
import type { ObservationRow, ProbeRow, ProbeSummary, ReportRow, TrustStore, UnsettledAttemptRow } from "./store";
import {
  lookupXrplPayment, lookupBaseUsdc, lookupStellarUsdc, STELLAR_HORIZON, verifyXrplSignature, xrplAddressOf, xrplRegularKey, recoverEvmSigner, sha256Hex,
  XRPL_TX_RE, EVM_TX_RE, XRPL_ADDR_RE, EVM_ADDR_RE, RLUSD, USDC_XRPL, type Fetch, type LedgerPayment,
} from "./verify";

export const WINDOW_DAYS = 30;
/** Confidence counts paid test-buys over 90 days (score inputs stay 30 days): since 2026-10-25 steady curated vendors are
 * test-bought weekly instead of daily (seller rotation), so a 30-day count would understate how often they were checked. */
export const CONFIDENCE_WINDOW_DAYS = 90;
/** How the curated test-buy list is scheduled (seller rotation, owner-approved 2026-10-25). */
export const TEST_BUY_SCHEDULE = "rotation: bought daily while new (fewer than 5 delivered test-buys), after any failed, no-data or timed-out buy or quote in the last 7 days, after a price or payTo change in the last 7 days, or for 14 days after a failure; otherwise (steady: every buy delivered for 7+ days) bought once a week, on a fixed weekday per seller. Free quote checks still run every 30 minutes.";
const DAY = 86_400_000;
export const REPORT_HOLD_MS = DAY;
const REPORT_MAX_AGE_MS = 7 * DAY;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_BODY = 16_384;
export const WEIGHTS = { delivery: 0.5, uptime: 0.2, latency: 0.15, agent_reports: 0.15 } as const;
export const REPORT_OUTCOMES = ["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other"] as const;
export const CONTACT_EMAIL = "hello@lumitrades.io";
const BANNED_WORDS = /\b(scam\w*|fraud\w*|untrustworthy|rip-?off|thie(f|ves)|steal\w*)\b/i;
export const TRUST_POST_PATHS = ["/v1/reports", "/v1/tips", "/v1/trust/replies", "/v1/trust/observations", "/v1/trust/attempts", "/v1/trust/probe", "/v1/trust/buys/inconclusive"];

export const LABEL =
  "Lumi's automated observations of this x402 endpoint (free 402-quote checks plus small paid test-buys), not a rating or review of the business. Few samples = low confidence.";

export interface TrustDeps {
  store: TrustStore;
  fetch: Fetch;
  now: () => number;
  ownerKey?: string;
  /** HMAC key for salted IP hashes (rate limits). */
  ipSecret: string;
  log: (e: Record<string, unknown>) => void;
  xrplRpc: string[];
  baseRpc: string;
  /** XRPL addresses whose payments are Lumi's own test-buys. */
  buyers: string[];
  /** x402 catalog (CDP Bazaar) with free quote checks; absent = curated list only. */
  catalog?: Catalog;
  /** Small persistent key/value (D1 meta) for the precomputed /v1/trust/vendors index; absent = in-isolate memo only. */
  cache?: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };
  /** Base URL used when the cron precomputes the vendors index. */
  publicBase?: string;
  /** Signed test-buy receipts (verified + stored here; signed on the operator box only). */
  receipts?: ReceiptStore;
  /** EVM addresses whose payments are Lumi's own test-buys (Base receipts). */
  evmBuyers?: string[];
  /** Stellar G-addresses whose payments are Lumi's own test-buys (Stellar receipts). */
  stellarBuyers?: string[];
  stellarHorizon?: string;
  /** Adds disclosure fields (seller monitoring = commercial relationship) to lookup docs. Never changes scores. */
  annotate?: (doc: Record<string, unknown>, payTos: string[]) => Promise<Record<string, unknown>>;
  /** A free lookup was served (after rate limits): the same test-buy priority signal as a paid trust/check. Never changes the answer. */
  onFreeCheck?: (q: LookupQuery, base: string) => Promise<unknown>;
  /** Active safety findings for a lookup, attached to a free-limit 429 (safety is never withheld, only the normal answer is). */
  safetyFor?: (q: LookupQuery, base: string) => Promise<Record<string, unknown>>;
}

/** Every payTo-looking string under `pay_to` keys of a lookup doc (catalog entries + curated vendors). */
export function payTosIn(doc: unknown, q?: { payTo?: string }): string[] {
  const out = new Set<string>();
  if (q?.payTo) out.add(q.payTo.trim());
  const walk = (v: unknown, under: boolean, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") { if (under && (XRPL_ADDR_RE.test(v) || EVM_ADDR_RE.test(v))) out.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, under, depth + 1); return; }
    if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, under || k === "pay_to" || k === "xrpl" || k === "evm", depth + 1);
  };
  walk(doc, false, 0);
  return [...out].slice(0, 50);
}

export const RECEIPT_FREE_LIMITS = { perMinute: 10, perDay: 100, globalPerDay: 5_000 } as const;

/** The precomputed vendors index is served while younger than this (rebuilt by the 30-minute cron and after trust writes). */
export const VENDORS_INDEX_TTL_MS = 40 * 60_000;
const VENDORS_MEMO_MS = 60_000;
const VENDORS_KEY = "vendors_index_v5"; // v5: score null + score_status/score_reason (not scored until paid proof); v4: + opt-in payment_attempts; v3: latest test-buy tx_hash/explorer per vendor

export interface Trust {
  handle(request: Request, path: string, base: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null>;
  runProbes(): Promise<{ probes: number; ok: number }>;
  vendorsDoc(base: string): Promise<Record<string, unknown>>;
  vendorDoc(id: string, base: string): Promise<Record<string, unknown> | null>;
  /** Paid detailed report: full observation history. Unknown vendor and stale data are never sold. */
  vendorReport(id: string, base: string): Promise<VendorReportResult>;
  /** Lookup by resource URL, domain or payTo across the curated list and the catalog. */
  /** free=true: answer-only (no tx hashes / evidence detail) for free surfaces; default full for paid /v1/trust/check. */
  lookup(q: LookupQuery, base: string, opts?: { free?: boolean }): Promise<Record<string, unknown>>;
  /** Live score of one curated vendor (same inputs as the public score: probes, Lumi test-buys, verified reports). Null = unknown id. */
  vendorScore(id: string): Promise<{ vendor_id: string; name: string; score: ScoreResult; status: string; last_conclusive: "delivered" | "not_delivered" | null } | null>;
  /** Verified seller replies for a curated vendor (shown in /v1/verdict). */
  vendorReplies(id: string): Promise<Array<{ text: string; via: string; ts: number }>>;
  /** Free-route rate limit (same buckets as free lookups). Null = allowed. */
  freeLimit(request: Request, bucket: "lookup"): Promise<Response | null>;
}

/** Read url / domain / payTo lookup parameters (payTo matched case-insensitively). */
export function lookupQuery(sp: URLSearchParams): LookupQuery | null {
  const get = (...ks: string[]) => { for (const k of ks) { const v = sp.get(k); if (v && v.trim()) return v.trim().slice(0, 500); } return undefined; };
  const q: LookupQuery = { url: get("url", "resource"), domain: get("domain", "host"), payTo: get("payTo", "payto", "pay_to") };
  return q.url || q.domain || q.payTo ? q : null;
}

const LOOKUP_KEYS = { url: ["url", "resource"], domain: ["domain", "host"], payTo: ["payTo", "payto", "pay_to"] } as const;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
const PAYTO_RE = /^(?:0x[0-9a-fA-F]{40}|r[1-9A-HJ-NP-Za-km-z]{24,34}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

/** Validates lookup inputs; returns a 400 body or null. Present-but-empty parameters are errors, not "list everything". */
export function lookupError(q: Partial<LookupQuery>, present: { url?: boolean; domain?: boolean; payTo?: boolean } = {}, context: "lookup" | "check" = "lookup"): Record<string, unknown> | null {
  // Examples only name parameters the calling route documents (trust/check takes url, payTo and amount; no domain).
  const examples = context === "check"
    ? ["?url=https://api.example.com/v1/data", "?url=https://api.example.com/v1/data&payTo=0x...&amount=0.01"]
    : ["?url=https://api.example.com/v1/data", "?domain=example.com", "?payTo=0x... or r..."];
  const bad = (param: string, detail: string) => ({ error: `invalid_${param === "payTo" ? "pay_to" : param}`, param, detail, examples });
  if (present.url && !q.url) return bad("url", "url is empty: pass a full http(s) resource URL.");
  if (present.domain && !q.domain) return bad("domain", "domain is empty: pass a host name such as example.com.");
  if (present.payTo && !q.payTo) return bad("payTo", "payTo is empty: pass an EVM (0x...) or XRPL classic (r...) address.");
  if (q.url) {
    let u: URL | null = null;
    try { u = new URL(q.url); } catch { /* invalid */ }
    if (!u || !/^https?:$/.test(u.protocol) || !HOST_RE.test(u.hostname)) return bad("url", "url must be an absolute http(s) URL with a public host name.");
  }
  if (q.domain) {
    const host = q.domain.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/:\d+$/, "").toLowerCase();
    if (!HOST_RE.test(host)) return bad("domain", "domain must be a host name such as example.com (no scheme or path needed).");
  }
  if (q.payTo && !PAYTO_RE.test(q.payTo)) return bad("payTo", "payTo must be an EVM (0x + 40 hex) or XRPL classic (r...) address.");
  return null;
}

/** Which lookup parameters are present in the query string (even if empty). */
export function lookupPresent(sp: URLSearchParams) {
  const has = (ks: readonly string[]) => ks.some((k) => sp.has(k));
  return { url: has(LOOKUP_KEYS.url), domain: has(LOOKUP_KEYS.domain), payTo: has(LOOKUP_KEYS.payTo) };
}

export type VendorReportResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; reason: "unknown_vendor" }
  | { ok: false; reason: "stale"; last_observed_at: string | null };

/** The paid report is sold only when the vendor has a probe or paid test-buy in this window. */
export const REPORT_FRESH_MS = 48 * 3_600_000;
const REPORT_PROBE_DAYS = 90;
const REPORT_MAX_PROBES = 10_000;

// ---------------------------------------------------------------- helpers

const iso = (ms: number) => new Date(ms).toISOString();
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number | null, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const explorer = (network: string, hash: string) =>
  network.startsWith("eip155:") ? `https://basescan.org/tx/${hash}` : `https://livenet.xrpl.org/transactions/${hash}`;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

/** POST bodies: a missing/blank vendor_id is a 400 (field required); an unknown one is a 404 that links the list instead of dumping it. */
function vendorIdError(id: unknown, base: string): Response | null {
  if (typeof id !== "string" || !id.trim()) {
    return json(400, { error: "invalid_request", field: "vendor_id", detail: `vendor_id is required: a vendor id from GET ${base}/v1/trust/vendors (e.g. "printmoneylab").` });
  }
  if (!vendorById(id)) return json(404, { error: "unknown_vendor", field: "vendor_id", detail: `No listed vendor "${id.slice(0, 64)}". Vendor ids: GET ${base}/v1/trust/vendors (free).` });
  return null;
}

function bad(field: string, detail: string): Response {
  return json(400, { error: "invalid_request", field, detail });
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return Array.from(sig.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function readJson(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY) return { ok: false, res: json(413, { error: "payload_too_large", max_bytes: MAX_BODY }) };
  const text = await request.text();
  if (text.length > MAX_BODY) return { ok: false, res: json(413, { error: "payload_too_large", max_bytes: MAX_BODY }) };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { ok: true, body };
  } catch {
    return { ok: false, res: json(400, { error: "invalid_json", detail: "Body must be a JSON object." }) };
  }
}

function priceLabel(o: any): { price: string | null; asset: string | null } {
  if (!o) return { price: null, asset: null };
  if (o.asset === "XRP") return { price: /^\d+$/.test(String(o.amount)) ? String(Number(o.amount) / 1e6) : String(o.amount), asset: "XRP" };
  const issuer = o.extra?.issuer ?? o.issuer;
  if (o.asset === RLUSD.currency && issuer === RLUSD.issuer) return { price: String(o.amount), asset: "RLUSD" };
  if (o.asset === USDC_XRPL.currency && issuer === USDC_XRPL.issuer) return { price: String(o.amount), asset: "USDC" };
  return { price: String(o.amount), asset: String(o.asset).slice(0, 48) };
}

function decodeB64Json(h: string): any {
  const bin = atob(h.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

// ---------------------------------------------------------------- scoring

export const NOT_SCORED_REASON =
  "Not scored: Lumi has no conclusive paid test-buy of this vendor yet. Free probes (402 quote checks) alone never produce a score; a score appears after Lumi's first conclusive test-buy.";

export interface ScoreResult {
  /** null until Lumi has at least one conclusive paid test-buy (status "not_scored"). */
  value: number | null;
  status: "scored" | "not_scored";
  reason?: string;
  confidence: "low" | "medium" | "high";
  components: Record<string, unknown>;
  samples: { paid_test_buys: number; delivered: number; inconclusive_test_buys?: number; paid_test_buys_90d?: number; probes: number; probes_ok: number; verified_reports_counted: number };
}

export function scoreVendor(probes: ProbeSummary, obs: ObservationRow[], reports: ReportRow[], now: number, paid90?: number): ScoreResult {
  const paid = obs.length;
  // Inconclusive buys (Lumi never saw a response) are not evidence about the seller: excluded from the delivery rate.
  const dc = deliveryCounts(obs);
  const delivered = dc.delivered;
  const delivery = dc.conclusive ? delivered / dc.conclusive : null;
  const uptime = probes.n ? probes.ok / probes.n : null;
  const med = median(probes.latencies);
  const latency = med == null ? null : clamp01(1 - (med - 500) / 4500);

  // Agent reports: verified, past the hold, max 1 per reporter per UTC day, max 5 per reporter per window.
  const perDay = new Set<string>();
  const perReporter = new Map<string, number>();
  let pos = 0;
  let neg = 0;
  let counted = 0;
  for (const r of [...reports].sort((a, b) => a.ts - b.ts)) {
    if (!r.verified || r.ts > now - REPORT_HOLD_MS) continue;
    const dayKey = `${r.reporter}:${new Date(r.ts).toISOString().slice(0, 10)}`;
    if (perDay.has(dayKey)) continue;
    if ((perReporter.get(r.reporter) ?? 0) >= 5) continue;
    perDay.add(dayKey);
    perReporter.set(r.reporter, (perReporter.get(r.reporter) ?? 0) + 1);
    counted++;
    if (r.outcome === "delivered") {
      pos += 1;
    } else {
      const t = r.tx_ts ?? r.ts;
      const corroborated = obs.some((o) => deliveryState(o) === "not_delivered" && Math.abs(o.ts - t) <= 6 * 3_600_000);
      neg += corroborated ? 1.5 : 1;
    }
  }
  const agentReports = pos + neg > 0 ? pos / (pos + neg) : null;

  const parts: [keyof typeof WEIGHTS, number | null][] = [
    ["delivery", delivery],
    ["uptime", uptime],
    ["latency", latency],
    ["agent_reports", agentReports],
  ];
  let num = 0;
  let den = 0;
  for (const [k, v] of parts) if (v != null) { num += WEIGHTS[k] * v; den += WEIGHTS[k]; }
  // "Not scored" until proof: without a conclusive paid test-buy there is no score, however many probes passed.
  const scored = dc.conclusive > 0 && den > 0;
  const value = scored ? Math.round((100 * num) / den) : null;
  const confidence = confidenceOf(paid90 ?? paid, probes.n);
  return {
    value,
    status: scored ? "scored" : "not_scored",
    ...(scored ? {} : { reason: NOT_SCORED_REASON }),
    confidence,
    components: {
      delivery: { value: round(delivery), weight: WEIGHTS.delivery, delivered, paid_test_buys: paid, inconclusive: dc.inconclusive, meaning: "share of Lumi's paid test-buys whose response contained data; inconclusive buys (Lumi-side, no response recorded) are excluded" },
      uptime: { value: round(uptime), weight: WEIGHTS.uptime, valid_quotes: probes.ok, probes: probes.n, meaning: "share of free probes that got a valid x402 402 quote with an XRPL option to a listed address" },
      latency: { value: round(latency), weight: WEIGHTS.latency, median_ms: med == null ? null : Math.round(med), samples: probes.latencies.length, meaning: "median time to a valid 402 quote; 500 ms or less = 1, 5 s or more = 0" },
      agent_reports: { value: round(agentReports), weight: WEIGHTS.agent_reports, counted, meaning: "agent reports (on-ledger payment + payer signature), after a 24 h hold; excluded when there are none" },
    },
    samples: { paid_test_buys: paid, delivered, inconclusive_test_buys: dc.inconclusive, ...(paid90 != null ? { paid_test_buys_90d: paid90 } : {}), probes: probes.n, probes_ok: probes.ok, verified_reports_counted: counted },
  };
}


// ---------------------------------------------------------------- report stats

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function latencyStats(xs: number[]) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const r = (x: number | null) => (x == null ? null : Math.round(x));
  return {
    samples: s.length,
    min_ms: r(s[0] ?? null),
    p50_ms: r(quantile(s, 0.5)),
    p90_ms: r(quantile(s, 0.9)),
    p95_ms: r(quantile(s, 0.95)),
    max_ms: r(s.length ? s[s.length - 1] : null),
    mean_ms: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null,
  };
}

const pct = (num: number, den: number) => (den ? Math.round((1000 * num) / den) / 10 : null);

export function confidenceOf(paid: number, probes: number): "low" | "medium" | "high" {
  return paid < 5 || probes < 10 ? "low" : paid < 20 ? "medium" : "high";
}

/** Neutral comparison of two medians; "insufficient data" below `min` samples on either side. */
function compare(recent: number[], previous: number[], unit: string, min = 10) {
  const a = median(recent);
  const b = median(previous);
  if (recent.length < min || previous.length < min || a == null || b == null) {
    return { recent_median: a == null ? null : Math.round(a), previous_median: b == null ? null : Math.round(b), recent_samples: recent.length, previous_samples: previous.length, direction: "insufficient data", unit };
  }
  const change = a - b;
  const rel = b ? change / b : 0;
  return {
    recent_median: Math.round(a),
    previous_median: Math.round(b),
    recent_samples: recent.length,
    previous_samples: previous.length,
    change: Math.round(change),
    change_pct: Math.round(rel * 1000) / 10,
    direction: Math.abs(rel) < 0.1 ? "about the same" : change < 0 ? "lower" : "higher",
    unit,
  };
}

// ---------------------------------------------------------------- docs

export function methodologyDoc(base: string) {
  return {
    kind: "trust_methodology",
    version: "v0",
    url: `${base}/v1/trust/methodology`,
    label: LABEL,
    seller_monitoring: { ...MONITOR_METHODOLOGY, docs: `${base}/v1/monitor`, corrections: `${base}/v1/monitor/corrections` },
    what_is_measured: [
      "Free probes: every 30 minutes Lumi sends one unpaid request to each curated vendor endpoint and records whether it answers with a valid x402 v2 402 quote that offers an XRPL (xrpl:0) option paying an address listed for that vendor (curated list; Bazaar catalog listings get their own quote checks, see x402_catalog), the quoted price and asset, whether the quote carries a sourceTag, and the response time. Probes never send a payment.",
      "Paid test-buys, by chain. Curated vendor list (/v1/trust/vendors): bought on XRPL (xrpl:0) in RLUSD or XRP from Lumi's XRPL wallet, periodic single calls within shared hard caps (about $0.50 a day: 0.30 RLUSD + 0.10 XRP per day in total across all curated vendors, plus up to 0.15 USDC a day on Stellar, so not every vendor is bought every day; no endpoint priced above 0.05; actual counts per vendor are in coverage). Since 2026-10-25 the curated list follows a seller rotation: " + TEST_BUY_SCHEDULE + " The field daily_test_buy is kept for compatibility and means 'on the test-buy list'; see test_buy_schedule. CDP Bazaar catalog listings: bought in USDC on Base (eip155:8453) from Lumi's Base buyer wallet, through the facilitator the seller's own 402 names, one buy per seller domain plus queued re-buys (no listing priced above $0.05; re-buys capped at $0.10 per day). Stellar (stellar:pubnet) x402 sellers found in the Bazaar catalog: bought in USDC from Lumi's Stellar wallet within that shared daily cap (up to 0.15 USDC a day, no listing priced above $0.05). Catalog listings are not test-bought on XRPL and curated vendors are not test-bought on Base. Every test-buy tx is checked on-chain (successful, sent by a Lumi wallet, received by a listed payTo) before it is stored. Each record (in the paid vendor report or paid trust/check; free surfaces show only date, HTTP status and data yes/no) shows the amount, asset, tx hash, HTTP status, whether the response contained data, latency, and a signed receipt (see receipts).",
      "Agent reports: any agent that paid a listed vendor can POST /v1/reports. A report counts only if the payment is validated on-ledger (tesSUCCESS, sent by the reporter, delivered to a pay-to address listed for that vendor, within the last 7 days) AND the payer signs the challenge `lumi-report:<network>:<tx_hash>`. Unverified submissions are stored privately for abuse review and are never shown or scored.",
    ],
    x402_catalog: {
      source: "CDP x402 Bazaar discovery API (free), ingested daily at 02:00 UTC. x402scan's resource API is paid, so it is not ingested.",
      lookup: `${base}/v1/trust/vendors?url=<resource> | ?domain=<host> | ?payTo=<address> (case-insensitive)`,
      free_tier: "Free lookups are answer-only: tier, listed price, last quote check (valid, pays listed address, price matches) and test-buy count/date, up to 5 entries. Tx hashes, explorer links, check history, latency and domain age are in the paid /v1/trust/check ($0.02) and the curated vendor report ($0.02). GET /v1/trust/catalog is a teaser of the 100 most-used listings (25 per page), not a full export. Free calls are rate-limited per hashed client IP (catalog 10/min and 40/day; lookups 30/min and 300/day).",
      quote_checks: "Catalogued http resources get free, unpaid requests in rotating slices every 30 minutes, fanned out over a queue; not every resource is checked every day (see counts.quote_checked_24h in the catalog summary for live coverage). Recorded: HTTP status, whether a readable x402 quote came back, whether it pays an address in the listing, quoted price vs listed price, latency, and the last 30 results. MCP listings are not probed. The registrable domain's registration date is read from RDAP about monthly (shared hosting hosts such as workers.dev are skipped). TLS certificate age is not measured.",
      tiers: {
        "catalogued, not yet checked": "Listed in the Bazaar; no quote check yet.",
        "quote-checked, low confidence": "A valid x402 quote in the last 48 h. This shows the endpoint is up and asks for payment as listed; it says nothing about what a paid call returns.",
        "quote-checked: no valid x402 quote at the last check": "The last free request did not return a readable 402 quote (e.g. it answered 200, 404, timed out, or quoted a different payTo). Often a parameter issue; not a judgment of the seller.",
        "test-bought": "Lumi paid for one call from its own wallet. Bazaar catalog listings are bought in USDC on Base; the curated vendor list is bought on XRPL (see the curated list below). The two are counted separately (catalog summary purchase_verified_by_chain) and never added into one XRPL figure; the payment is confirmed on-chain before it is stored, with HTTP status, data returned yes/no and latency.",
        "self, not scored": "Lumi's own endpoints.",
      },
      no_match: "{observed:false, note}: Lumi has not seen this seller. No observation is not a negative finding.",
      not_scored: "Catalog entries get labels, not scores; scores apply only to the curated XRPL list below.",
      free_evidence: {
        bazaar_quality: "Coinbase CDP Bazaar publishes per-listing quality fields (30-day call count, 30-day unique payers, last called). Lumi stores them at most every 20 h and shows them as bazaar_quality, attributed to Coinbase Bazaar and dated (as_of).",
        payto_census: "For payTo lookups and trust/check, Lumi reads the payTo's incoming payments: on XRPL the latest 200 ledger transactions (x402-style = SourceTag 804681468 or an InvoiceID); on Base the USDC Transfer logs into Bazaar-listed payTos, indexed forward from the index start date (no back history). Lumi's own wallets, known test wallets and the seller's payTos are excluded, payers are grouped by the account that funded them (a funder that funded 20+ indexed payers, e.g. an exchange, is not used for grouping), and payers funded by excluded wallets are dropped. Output: organic payer clusters, payments, last organic date. Free lookups show counts and dates only; tx hashes and samples are in the paid trust/check.",
        third_party: "vet402 observatory test results (KIZUNA Creation, CC BY 4.0, https://vet402.com/observatory) are imported for catalogued resources and shown separately as third_party.vet402 with a link, licence and retrieval date. They are never added to Lumi's own test-bought counts.",
        demand_driven_buys: "When a paid trust/check hits a listing with no Lumi purchase in 30 days and a warning signal, the listing is queued for Lumi's daily test-buy routine (same caps); nothing is bought during the check.",
      },
      by_chain: `test-bought counts are split by chain. base_usdc: Bazaar catalog resources Lumi bought once each in USDC on Base (nearly all test-bought entries). xrpl: endpoints of the small curated vendor list that Lumi test-bought on XRPL in the last 30 days, with how many buys returned data; plus xrpl.bazaar_sweep, a dated one-off sweep of the XRPL-paying hosts in the CDP Bazaar catalog: ${XRPL_BAZAAR_SWEEP.statement}. Sweep buys merged into the trust dataset were re-verified on the XRPL ledger at merge time and carry signed receipts; a few sweep hosts that are not (yet) in the ingested Bazaar catalog or the curated list are not merged. Hosts listed after the sweep date are not covered by it.`,
    },
    score: {
      range: "0-100, over the last 30 days",
      weights: WEIGHTS,
      formula: "weighted mean of the components that have data (a component with no data is left out and the weights are renormalised)",
      delivery: "delivered / paid test-buys",
      uptime: "valid 402 quotes / probes",
      latency: "1 - (median_ms - 500) / 4500, clipped to 0..1",
      agent_reports: "positive / (positive + negative) checked agent reports; a negative report gets weight 1.5 when a Lumi test-buy within 6 h also returned no data; max 1 counted report per reporter per day and 5 per 30 days; 24 h hold before counting",
      confidence: "low when there are fewer than 5 paid test-buys in the last 90 days or fewer than 10 probes in the last 30 days; medium below 20 paid test-buys in 90 days; otherwise high (the score itself uses the last 30 days)",
      ordering: "vendors are listed in allowlist order, not ranked",
    },
    data_returned_rule:
      "A response 'contained data' when the HTTP status is 2xx and the body has non-empty content for that endpoint (e.g. a non-empty result list). Error bodies, empty lists and empty objects count as no data. A paid call where Lumi recorded no HTTP response at all (Lumi's client timed out or Lumi's run was interrupted) is inconclusive: delivery unknown, shown as data_returned null and delivery \"inconclusive\", excluded from delivery rates and scores, and never a reason for a warn or block verdict. Corrections are logged at /v1/monitor/corrections.",
    right_to_reply: rightToReply(base),
    reports: {
      endpoint: `POST ${base}/v1/reports`,
      challenge: "lumi-report:<network>:<tx_hash>  (XRPL: tx hash uppercase; Base: 0x-prefixed lowercase)",
      xrpl_signature: "ripple-keypairs sign(<UTF-8 bytes of the challenge as hex>, privateKey), verified against the tx's SigningPubKey (single-signed payments only)",
      base_signature: "EIP-191 personal_sign of the challenge by the address that sent the USDC",
      fields: {
        vendor_id: "id from /v1/trust/vendors",
        network: "xrpl:0 | eip155:8453",
        tx_hash: "payment tx",
        reporter: "address that paid (XRPL r-address or 0x address)",
        signature: "hex signature of the challenge",
        outcome: REPORT_OUTCOMES.join(" | "),
        http_status: "optional, the status the vendor answered with",
        response_excerpt: "optional, up to 4000 chars; kept private",
      },
      limits: "20 per IP per day, 5 per minute; one verified report per tx",
    },
    receipts: {
      format: "counterparty_delivery_receipt v0.1 (proposed ARS evidence type): seller {vendor_id, endpoint, domain, pay_to}, payment {network, asset, amount, tx_hash, payer, ledger_result, ledger_index|block_number}, delivery {observed_at, http_status, data_returned, outcome, latency_ms}, issuer {methodology_url}, receipt_hash (SHA-256 of the canonical JSON body) and signer.",
      signing: "Signed by the wallet that paid: message `lumi-receipt:<network>:<tx_hash>:<receipt_hash>`; XRPL via ripple-keypairs (UTF-8 hex of the message, with public_key), Base via EIP-191 personal_sign. Signed on Lumi's operator box; the API never holds wallet keys.",
      coverage: "One per stored test-buy, curated (XRPL) and catalog (Base); earlier buys were backfilled (issued_at is the signing time, delivery.observed_at the buy time). Lumi's test-buys of its own endpoints are not counterparty evidence and get no receipt.",
      served: "Paid only: paid_test_buys.history[].receipt in the vendor report (/v1/trust/vendors/{id}/report) and entries[].purchases[].receipt in paid catalog lookups (POST /v1/feed/lookup on the Feed and Feed Pro plans). The paid /v1/trust/check returns a verdict with reasons, not receipts. Free lookups stay answer-only.",
      verify: `GET ${base}/v1/trust/receipts/verify (how-to, free) and POST ${base}/v1/trust/receipts/verify with a receipt (free; ?ledger=1 also checks the payment on-chain).`,
    },
    tips: { endpoint: `POST ${base}/v1/tips`, privacy: "Stored privately. Never shown, published, or returned by any endpoint, MCP tool or A2A skill." },
    self: "Lumi does not list or score its own API.",
  };
}

function rightToReply(base: string) {
  return {
    email: CONTACT_EMAIL,
    endpoint: `POST ${base}/v1/trust/replies`,
    how:
      "Sign `lumi-reply:<vendor_id>:<sha256 hex of your reply text>` with the key of a pay-to address listed for your entry (XRPL: ripple-keypairs over the UTF-8 hex of the message, and include public_key; EVM: EIP-191 personal_sign) and POST {vendor_id, text, network, address, public_key?, signature}. Verified replies are shown with your entry. Or email us and we will add it.",
  };
}

const DISCLAIMER =
  "Automated observations by Lumi, reported as measured. They describe how an endpoint answered Lumi's requests at the times shown, not the intent or quality of the business behind it. Vendors can reply; see right_to_reply.";

/** Free trust surfaces: per hashed-IP limits (salted HMAC, never the raw IP) plus a global daily ceiling. */
export const FREE_LIMITS = {
  catalog: { perMinute: 10, perDay: 40, globalPerDay: 20_000 },
  lookup: { perMinute: 30, perDay: 300, globalPerDay: 60_000 },
} as const;
/** Free lookups are also limited per caller key or wallet (same 30 a minute / 300 a day), so rotating IPs does not lift the limit. */
export const KEY_LIMIT_HEADERS = ["X-Lumi-Key", "X-Wallet", "X-Lumi-Wallet"] as const;
/** Shown on a free-lookup 429: where to go for volume. */
export const FREE_LIMIT_MORE = "Free lookups are limited to 30 a minute and 300 a day per IP and per key or wallet. For more: the $0.02 live check (/v1/trust/check, x402, no account), or a Feed key and the platform licence (see /v1/feed).";

/** Free, answer-only view of a paid test-buy: outcome only; tx hashes and explorer links of the history are in the paid vendor report. */
function obsFreeView(o: ObservationRow) {
  return { observed_at: iso(o.ts), endpoint: o.endpoint, network: o.network, http_status: o.http_status, data_returned: dataReturnedView(o), delivery: deliveryState(o), source: o.source === "lumi_buy" ? "Lumi paid buy (seeded)" : "Lumi daily test-buy" };
}

/**
 * Free view of a vendor's LATEST paid test-buy only: the outcome plus its on-chain tx hash and explorer link, so anyone
 * can check that one payment for free. Older hashes, signed receipts and the full history stay in the paid vendor report.
 */
function obsLatestFreeView(o: ObservationRow) {
  return { ...obsFreeView(o), tx_hash: o.tx_hash, explorer: explorer(o.network, o.tx_hash) };
}

function obsView(o: ObservationRow) {
  const evidence = `paid ${o.amount} ${o.asset} on ${iso(o.ts).replace(".000Z", "Z")}, tx ${o.tx_hash}, HTTP ${o.http_status ?? "none"}, ${deliveryText(o)}`;
  return {
    observed_at: iso(o.ts),
    endpoint: o.endpoint,
    network: o.network,
    amount: o.amount,
    asset: o.asset,
    tx_hash: o.tx_hash,
    explorer: explorer(o.network, o.tx_hash),
    http_status: o.http_status,
    data_returned: dataReturnedView(o),
    delivery: deliveryState(o),
    ...(inconclusiveReason(o) ? { inconclusive_reason: inconclusiveReason(o) } : {}),
    latency_ms: o.latency_ms,
    summary: o.summary,
    ...(o.corrected_at ? { corrected_at: iso(o.corrected_at) } : {}),
    evidence,
    source: o.source === "lumi_buy" ? "Lumi paid buy (seeded)" : "Lumi daily test-buy",
  };
}

function probeView(p: ProbeRow) {
  return {
    checked_at: iso(p.ts),
    endpoint: p.endpoint,
    http_status: p.http_status,
    valid_quote: p.ok,
    price: p.price,
    asset: p.asset,
    pay_to: p.pay_to,
    source_tag_in_quote: p.source_tag,
    latency_ms: p.latency_ms,
    note: p.error,
  };
}

// ---------------------------------------------------------------- factory

/** A free-limit 429 with the active safety findings added (the normal answer stays withheld). */
export async function withSafety(lim: Response, safety: Record<string, unknown>): Promise<Response> {
  const body = (await lim.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const headers = new Headers(lim.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ ...body, safety }), { status: lim.status, headers });
}

export function createTrust(deps: TrustDeps): Trust {
  const { store, now } = deps;

  async function gather(v: Vendor) {
    const since = now() - WINDOW_DAYS * DAY;
    const [probes, obs90, reports, replies] = await Promise.all([
      store.probeSummary(v.id, since),
      store.observations(v.id, now() - CONFIDENCE_WINDOW_DAYS * DAY),
      store.verifiedReports(v.id, since),
      store.verifiedReplies(v.id),
    ]);
    const obs = obs90.filter((o) => o.ts >= since);
    return { probes, obs, reports, replies, score: scoreVendor(probes, obs, reports, now(), obs90.length) };
  }

  /** A vendor is "unreachable" when the last 3 probes of every endpoint got 404/410 or no answer at all. */
  async function reachability(v: Vendor): Promise<{ status: "live" | "unreachable"; note?: string }> {
    const hist = await store.probeHistory(v.id, now() - 7 * DAY, 25 * Math.max(1, v.endpoints.length));
    const dead = (st: number | null) => st === null || st === 404 || st === 410;
    const perEndpoint = v.endpoints.map((e) => hist.filter((p) => p.endpoint === e.url).slice(0, 3));
    if (perEndpoint.length && perEndpoint.every((ps) => ps.length >= 3 && ps.every((p) => dead(p.http_status)))) {
      const codes = [...new Set(perEndpoint.flat().map((p) => (p.http_status === null ? "no answer" : String(p.http_status))))].join("/");
      return { status: "unreachable", note: `The last 3 checks of every endpoint returned ${codes}. Do not pay this vendor until it answers again.` };
    }
    return { status: "live" };
  }

  function header(base: string) {
    return {
      label: LABEL,
      methodology: `${base}/v1/trust/methodology`,
      window_days: WINDOW_DAYS,
      generated_at: iso(now()),
    };
  }

  /**
   * Opt-in (vendor.label_unsettled_payments) and only while Lumi has no paid test-buy of the vendor: how many signed XRPL
   * test payments the seller's endpoint did not accept, and since when. Informational; never an input to the score.
   */
  async function paymentAttempts(v: Vendor, paidTestBuys: number) {
    if (!v.label_unsettled_payments || paidTestBuys > 0) return null;
    const a = await store.unsettledAttempts(v.id);
    if (!a.count || a.first == null || a.last == null) return null;
    return {
      status: "test_payment_not_accepted_yet",
      label: "Test payment not accepted yet on XRPL",
      network: "xrpl:0",
      network_name: "XRPL",
      count: a.count,
      first_attempt: new Date(a.first).toISOString(),
      last_attempt: new Date(a.last).toISOString(),
      note: "Signed XRPL test payments Lumi sent that the seller's endpoint did not accept, so none reached the ledger and nothing was paid. Informational only; not part of the score. Shown until the first paid test-buy succeeds.",
    };
  }

  async function vendorsDoc(base: string) {
    const rows = await Promise.all(
      VENDORS.map(async (v) => {
        const [g, reach] = await Promise.all([gather(v), reachability(v)]);
        const last = g.obs[0];
        const attempts = await paymentAttempts(v, g.score.samples.paid_test_buys);
        return {
          id: v.id,
          name: v.name,
          homepage: v.homepage,
          status: reach.status,
          ...(reach.note ? { status_note: reach.note } : {}),
          score: g.score.value,
          score_status: g.score.status,
          ...(g.score.reason ? { score_reason: g.score.reason } : {}),
          confidence: g.score.confidence,
          samples: g.score.samples,
          last_paid_observation: last ? obsLatestFreeView(last) : null,
          ...(attempts ? { payment_attempts: attempts } : {}),
          latest_probes: g.probes.latest.map(probeView),
          replies: g.replies.length,
          detail: `${base}/v1/trust/vendors/${v.id}`,
        };
      }),
    );
    return {
      kind: "trust_vendors",
      ...header(base),
      count: rows.length,
      ordering: "allowlist order (not ranked)",
      vendors: rows,
      self: { name: "Lumi Trades API", url: base, label: "self, not scored", note: "Lumi's own endpoints are listed for completeness; Lumi does not score or quote-check itself." },
      ...(deps.catalog ? { catalog: await deps.catalog.summary(base) } : {}),
      right_to_reply: rightToReply(base),
      disclaimer: DISCLAIMER,
    };
  }

  // ---------------- precomputed vendors index (GET /v1/trust/vendors was ~2 s cold: 4 store reads per vendor + catalog)
  let vendorsMemo: { at: number; base: string; doc: Record<string, unknown> } | undefined;

  async function rebuildVendorsIndex(base: string) {
    const doc = (await vendorsDoc(base)) as Record<string, unknown>;
    const entry = { at: now(), base, doc };
    vendorsMemo = entry;
    await deps.cache?.set(VENDORS_KEY, JSON.stringify(entry)).catch((e) => deps.log({ event: "vendors_index_store_error", error: String(e) }));
    return entry;
  }

  async function cachedVendorsDoc(base: string): Promise<{ doc: Record<string, unknown>; cache: "memo" | "index" | "rebuilt" }> {
    const t = now();
    if (vendorsMemo && vendorsMemo.base === base && t - vendorsMemo.at < VENDORS_MEMO_MS) return { doc: vendorsMemo.doc, cache: "memo" };
    const raw = await deps.cache?.get(VENDORS_KEY).catch(() => null);
    if (raw) {
      try {
        const e = JSON.parse(raw) as { at: number; base: string; doc: Record<string, unknown> };
        if (e.base === base && t - e.at >= 0 && t - e.at < VENDORS_INDEX_TTL_MS) {
          vendorsMemo = { ...e, at: Math.max(e.at, t - VENDORS_MEMO_MS + 15_000) };
          return { doc: e.doc, cache: "index" };
        }
      } catch { /* rebuild */ }
    }
    return { doc: (await rebuildVendorsIndex(base)).doc, cache: "rebuilt" };
  }

  async function invalidateVendorsIndex() {
    vendorsMemo = undefined;
    await deps.cache?.set(VENDORS_KEY, "").catch(() => {});
  }

  async function vendorDoc(id: string, base: string) {
    const v = vendorById(id);
    if (!v) return null;
    const [g, reach] = await Promise.all([gather(v), reachability(v)]);
    const doc: Record<string, unknown> = {
      kind: "trust_vendor",
      ...header(base),
      id: v.id,
      name: v.name,
      homepage: v.homepage,
      status: reach.status,
      ...(reach.note ? { status_note: reach.note } : {}),
      pay_to: v.pay_to,
      endpoints: v.endpoints.map((e) => ({ url: e.url, method: e.method, listed_price: e.listed_price, listed_asset: e.listed_asset, daily_test_buy: !!e.test_buy, test_buy: !!e.test_buy, test_buy_schedule: e.test_buy ? TEST_BUY_SCHEDULE : null })),
      score: { value: g.score.value, status: g.score.status, ...(g.score.reason ? { reason: g.score.reason } : {}), confidence: g.score.confidence, components: g.score.components, samples: g.score.samples },
      observations: g.obs.slice(0, 10).map(obsFreeView),
      observations_total: g.obs.length,
      evidence: `Answer-only. The latest test-buy's tx hash is free in last_paid_observation on ${base}/v1/trust/vendors. All other tx hashes, explorer links, latency stats, signed receipts and the full 90-day history are in the paid report: ${base}/v1/trust/vendors/${v.id}/report ($0.02).`,
      latest_probes: g.probes.latest.map(probeView),
      agent_reports: g.reports.slice(0, 10).map((r) => ({
        reported_at: iso(r.ts),
        network: r.network,
        amount: r.amount,
        asset: r.asset,
        http_status: r.http_status,
        outcome: r.outcome,
        counts_from: iso(r.ts + REPORT_HOLD_MS),
      })),
      vendor_replies: g.replies.map((r) => ({ replied_at: iso(r.ts), via: r.via, text: r.text })),
      right_to_reply: rightToReply(base),
      disclaimer: DISCLAIMER,
    };
    return deps.annotate ? deps.annotate(doc, payTosIn({ pay_to: v.pay_to })).catch(() => doc) : doc;
  }


  async function vendorReport(id: string, base: string): Promise<VendorReportResult> {
    const v = vendorById(id);
    if (!v) return { ok: false, reason: "unknown_vendor" };
    const t = now();
    const [probes, obs, reports, replies] = await Promise.all([
      store.probeHistory(v.id, t - REPORT_PROBE_DAYS * DAY, REPORT_MAX_PROBES),
      store.observations(v.id, 0),
      store.verifiedReports(v.id, 0),
      store.verifiedReplies(v.id),
    ]);
    const last = Math.max(probes[0]?.ts ?? 0, obs[0]?.ts ?? 0);
    if (!last || last < t - REPORT_FRESH_MS) return { ok: false, reason: "stale", last_observed_at: last ? iso(last) : null };
    const rcpts: Map<string, Receipt> = deps.receipts ? await deps.receipts.byTx(obs.map((o) => o.tx_hash)).catch(() => new Map()) : new Map();
    const g = await gather(v);

    const windows = [1, 7, 30, 90].map((d) => {
      const since = t - d * DAY;
      const p = probes.filter((x) => x.ts >= since);
      const o = obs.filter((x) => x.ts >= since);
      const valid = p.filter((x) => x.ok).length;
      const dcw = deliveryCounts(o);
      const delivered = dcw.delivered;
      return {
        window: d === 1 ? "24h" : `${d}d`,
        probes: p.length,
        valid_quotes: valid,
        uptime_pct: pct(valid, p.length),
        quote_latency: latencyStats(p.filter((x) => x.ok && x.latency_ms != null).map((x) => x.latency_ms!)),
        paid_test_buys: o.length,
        delivered,
        inconclusive: dcw.inconclusive,
        delivery_pct: pct(delivered, dcw.conclusive),
        confidence: confidenceOf(o.length, p.length),
      };
    });

    // UTC daily series over the probe retention window (oldest first).
    const days = new Map<string, { probes: number; valid: number; lat: number[]; buys: number; delivered: number }>();
    for (let d = REPORT_PROBE_DAYS - 1; d >= 0; d--) days.set(iso(t - d * DAY).slice(0, 10), { probes: 0, valid: 0, lat: [], buys: 0, delivered: 0 });
    for (const p of probes) {
      const k = days.get(iso(p.ts).slice(0, 10));
      if (!k) continue;
      k.probes++;
      if (p.ok) { k.valid++; if (p.latency_ms != null) k.lat.push(p.latency_ms); }
    }
    for (const o of obs) {
      const k = days.get(iso(o.ts).slice(0, 10));
      if (!k) continue;
      k.buys++;
      if (deliveryState(o) === "delivered") k.delivered++;
    }
    const daily = [...days.entries()]
      .filter(([, k]) => k.probes || k.buys)
      .map(([date, k]) => {
        const m = median(k.lat);
        return { date, probes: k.probes, valid_quotes: k.valid, uptime_pct: pct(k.valid, k.probes), quote_latency_p50_ms: m == null ? null : Math.round(m), paid_test_buys: k.buys, delivered: k.delivered };
      });

    const lat = (from: number, to: number) => probes.filter((p) => p.ok && p.latency_ms != null && p.ts >= from && p.ts < to).map((p) => p.latency_ms!);
    const upDaily = (from: number, to: number) => daily.filter((d) => d.date >= iso(from).slice(0, 10) && d.date < iso(to).slice(0, 10) && d.uptime_pct != null).map((d) => d.uptime_pct!);
    const w7 = t - 7 * DAY;
    const w14 = t - 14 * DAY;
    const latencyTrend = compare(lat(w7, t + 1), lat(w14, w7), "ms");
    const uptimeTrend = compare(upDaily(w7, t + DAY), upDaily(w14, w7), "daily uptime %", 3);

    // Per endpoint (listed endpoints first, then any older ones seen in the history).
    const urls = [...new Set([...v.endpoints.map((e) => e.url), ...probes.map((p) => p.endpoint), ...obs.map((o) => o.endpoint)])];
    const endpoints = urls.map((url) => {
      const listed = v.endpoints.find((e) => e.url === url);
      const p = probes.filter((x) => x.endpoint === url);
      const o = obs.filter((x) => x.endpoint === url);
      const valid = p.filter((x) => x.ok);
      // Quoted price changes, oldest first.
      const prices: { from: string; price: string | null; asset: string | null }[] = [];
      for (const x of [...valid].reverse()) {
        const prev = prices[prices.length - 1];
        if (!prev || prev.price !== x.price || prev.asset !== x.asset) prices.push({ from: iso(x.ts), price: x.price, asset: x.asset });
      }
      const failures = new Map<string, number>();
      for (const x of p) if (!x.ok) {
        const key = x.error ? x.error.slice(0, 80) : `HTTP ${x.http_status ?? "none"}`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
      return {
        url,
        listed: !!listed,
        method: listed?.method ?? null,
        listed_price: listed?.listed_price ?? null,
        listed_asset: listed?.listed_asset ?? null,
        daily_test_buy: !!listed?.test_buy,
        test_buy_schedule: listed?.test_buy ? TEST_BUY_SCHEDULE : null,
        probes: p.length,
        valid_quotes: valid.length,
        uptime_pct: pct(valid.length, p.length),
        quote_latency: latencyStats(valid.filter((x) => x.latency_ms != null).map((x) => x.latency_ms!)),
        quotes_with_source_tag: valid.filter((x) => x.source_tag).length,
        quoted_price_history: prices,
        probe_results_without_valid_quote: [...failures.entries()].map(([result, count]) => ({ result, count })).sort((a, b) => b.count - a.count),
        paid_test_buys: o.length,
        delivered: deliveryCounts(o).delivered,
        inconclusive: deliveryCounts(o).inconclusive,
      };
    });
    const epIndex = new Map(urls.map((u, i) => [u, i]));

    const spent = new Map<string, number>();
    for (const o of obs) spent.set(o.asset, (spent.get(o.asset) ?? 0) + Number(o.amount || 0));
    const statuses = new Map<string, number>();
    for (const o of obs) statuses.set(String(o.http_status ?? "none"), (statuses.get(String(o.http_status ?? "none")) ?? 0) + 1);
    const dcAll = deliveryCounts(obs);
    const delivered = dcAll.delivered;

    const confidence = g.score.confidence;
    const doc = {
      kind: "trust_vendor_report",
      ...header(base),
      report_version: "v1",
      id: v.id,
      name: v.name,
      homepage: v.homepage,
      pay_to: v.pay_to,
      confidence_label:
        confidence === "low"
          ? "LOW CONFIDENCE: few samples (fewer than 5 paid test-buys in the last 90 days or fewer than 10 probes in the last 30 days). Treat these numbers as early observations."
          : confidence === "medium"
          ? "Medium confidence: fewer than 20 paid test-buys in the last 90 days."
          : "High confidence by Lumi's sample-size rule (20+ paid test-buys in the last 90 days and 10+ probes in the last 30 days).",
      score: { value: g.score.value, status: g.score.status, ...(g.score.reason ? { reason: g.score.reason } : {}), confidence, window_days: WINDOW_DAYS, components: g.score.components, samples: g.score.samples },
      coverage: {
        first_probe_at: probes.length ? iso(probes[probes.length - 1].ts) : null,
        last_probe_at: probes.length ? iso(probes[0].ts) : null,
        first_paid_test_buy_at: obs.length ? iso(obs[obs.length - 1].ts) : null,
        last_paid_test_buy_at: obs.length ? iso(obs[0].ts) : null,
        probe_retention_days: REPORT_PROBE_DAYS,
        probes_in_report: probes.length,
        probes_truncated: probes.length >= REPORT_MAX_PROBES,
        paid_test_buys_in_report: obs.length,
      },
      windows,
      trend: {
        quote_latency: { ...latencyTrend, compares: "median time to a valid 402 quote, last 7 days vs the 7 days before" },
        uptime: { ...uptimeTrend, compares: "median daily uptime %, last 7 days vs the 7 days before" },
      },
      daily,
      endpoints,
      paid_test_buys: {
        count: obs.length,
        delivered,
        not_delivered: dcAll.not_delivered,
        inconclusive: dcAll.inconclusive,
        delivery_pct: pct(delivered, dcAll.conclusive),
        delivery_note: "inconclusive = Lumi never recorded an HTTP response (our client timed out or our run was interrupted); delivery unknown, excluded from delivery_pct and the score, not counted against the vendor.",
        spent: [...spent.entries()].map(([asset, amount]) => ({ asset, amount: String(Math.round(amount * 1e6) / 1e6) })),
        http_statuses: Object.fromEntries(statuses),
        latency: latencyStats(obs.filter((o) => o.latency_ms != null).map((o) => o.latency_ms!)),
        history: obs.map((o) => ({ ...obsView(o), delivered: { delivered: "yes", not_delivered: "no", inconclusive: "unknown (inconclusive, Lumi-side)" }[deliveryState(o)], ...(rcpts.has(o.tx_hash) ? { receipt: rcpts.get(o.tx_hash) } : {}) })),
        receipts: { signed: obs.filter((o) => rcpts.has(o.tx_hash)).length, of: obs.length, format: "counterparty_delivery_receipt v0.1, signed by the paying wallet", verify: `${base}/v1/trust/receipts/verify` },
      },
      quote_checks: {
        about: "Every free probe in the retention window, newest first. endpoint is an index into endpoints[]. valid_quote = a valid x402 402 quote with an XRPL option paying a listed address.",
        columns: ["checked_at", "endpoint", "http_status", "valid_quote", "price", "asset", "source_tag_in_quote", "latency_ms", "note"],
        rows: probes.map((p) => [iso(p.ts), epIndex.get(p.endpoint) ?? -1, p.http_status, p.ok, p.price, p.asset, p.source_tag, p.latency_ms, p.error]),
      },
      agent_reports: {
        about: "Checked agent reports only (on-ledger payment + payer signature). Unverified submissions are never shown.",
        count: reports.length,
        delivered: reports.filter((r) => r.outcome === "delivered").length,
        other_outcomes: reports.filter((r) => r.outcome !== "delivered").length,
        history: reports.map((r) => ({
          reported_at: iso(r.ts),
          network: r.network,
          tx_hash: r.tx_hash,
          explorer: explorer(r.network, r.tx_hash),
          amount: r.amount,
          asset: r.asset,
          http_status: r.http_status,
          outcome: r.outcome,
          counts_from: iso(r.ts + REPORT_HOLD_MS),
        })),
      },
      vendor_replies: replies.map((r) => ({ replied_at: iso(r.ts), via: r.via, text: r.text })),
      right_to_reply: rightToReply(base),
      free_summary: `${base}/v1/trust/vendors/${v.id}`,
      disclaimer: DISCLAIMER,
    };
    if (deps.annotate) { const d2 = await deps.annotate(doc as Record<string, unknown>, payTosIn({ pay_to: v.pay_to })).catch(() => null); if (d2) return { ok: true, doc: d2 as typeof doc }; }
    return { ok: true, doc };
  }

  // ---------------- probes (free, unpaid)

  async function probeEndpoint(v: Vendor, ep: VendorEndpoint): Promise<ProbeRow> {
    const t0 = Date.now();
    const row: ProbeRow = {
      vendor_id: v.id, endpoint: ep.url, ts: now(), http_status: null, ok: false, price: null, asset: null, pay_to: null, source_tag: null, latency_ms: null, error: null,
    };
    try {
      const r = await deps.fetch(ep.url, {
        method: ep.method,
        headers: {
          Accept: "application/json",
          "User-Agent": "LumiTrustProbe/0.6 (+https://api.lumitrades.io/v1/trust/methodology; unpaid quote check)",
          ...(ep.method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: ep.method === "POST" ? JSON.stringify(ep.body ?? {}) : undefined,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const text = await r.text();
      row.latency_ms = Date.now() - t0;
      row.http_status = r.status;
      if (r.status !== 402) { row.error = `answered HTTP ${r.status} instead of a 402 quote`; return row; }
      let pr: any;
      const h = r.headers.get("PAYMENT-REQUIRED");
      try { pr = h ? decodeB64Json(h) : JSON.parse(text); } catch { /* below */ }
      if (!pr || !Array.isArray(pr.accepts)) { row.error = "402 without a readable x402 quote"; return row; }
      const xrpl = pr.accepts.filter((a: any) => a?.network === "xrpl:0");
      if (!xrpl.length) { row.error = "quote has no xrpl:0 option"; return row; }
      const pick = xrpl.find((a: any) => priceLabel(a).asset === ep.listed_asset) ?? xrpl[0];
      const { price, asset } = priceLabel(pick);
      row.price = price;
      row.asset = asset;
      row.pay_to = typeof pick.payTo === "string" ? pick.payTo.slice(0, 64) : null;
      row.source_tag = pick.extra?.sourceTag != null;
      if (!row.pay_to || !v.pay_to.xrpl.includes(row.pay_to)) { row.error = "quote pays an address not listed for this vendor"; return row; }
      row.ok = true;
      return row;
    } catch (e) {
      row.latency_ms = Date.now() - t0;
      row.error = /timeout|abort/i.test(String(e)) ? "no answer within 15 s" : "network error";
      return row;
    }
  }

  async function runProbes() {
    const rows = await Promise.all(VENDORS.flatMap((v) => v.endpoints.map((ep) => probeEndpoint(v, ep))));
    await store.addProbes(rows);
    await store.prune(now());
    const ok = rows.filter((r) => r.ok).length;
    deps.log({ event: "trust_probe", probes: rows.length, ok });
    if (deps.publicBase) await rebuildVendorsIndex(deps.publicBase).catch((e) => deps.log({ event: "vendors_index_error", error: String(e) }));
    return { probes: rows.length, ok };
  }

  // ---------------- rate limits (salted IP hashes only)

  async function ipHash(request: Request) {
    const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
    return hmacHex(deps.ipSecret, `ip:${ip}`);
  }

  const READ_ONLY_BUCKETS = new Set(["catalog"]);
  /** Hashed caller key or wallet (X-Lumi-Key, X-Wallet / X-Lumi-Wallet, or a non-owner Bearer token); null when none is sent. */
  async function keyHash(request: Request): Promise<string | null> {
    let k = "";
    for (const h of KEY_LIMIT_HEADERS) { k = request.headers.get(h)?.trim() ?? ""; if (k) break; }
    if (!k) k = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
    if (!k) return null;
    return hmacHex(deps.ipSecret, `key:${k.slice(0, 200).toLowerCase()}`);
  }

  /** The free lookup limit: per hashed IP, plus per hashed key / wallet when one is sent. */
  async function lookupLimit(request: Request): Promise<Response | null> {
    const l = FREE_LIMITS.lookup;
    const byIp = await limited("lookup", await ipHash(request), l.perMinute, l.perDay, l.globalPerDay);
    const kh = byIp ? null : await keyHash(request);
    const hit = byIp ?? (kh ? await limited("lookup_key", kh, l.perMinute, l.perDay, l.globalPerDay) : null);
    if (!hit) return null;
    const body = (await hit.json().catch(() => ({}))) as Record<string, unknown>;
    return json(429, { ...body, more: FREE_LIMIT_MORE }, Object.fromEntries(hit.headers));
  }

  async function limited(bucket: string, who: string, perMinute: number, perDay: number, globalPerDay: number): Promise<Response | null> {
    const t = now();
    const checks: [string, number, number][] = [
      [`${bucket}:m:${Math.floor(t / 60_000)}:${who}`, perMinute, (Math.floor(t / 60_000) + 1) * 60_000],
      [`${bucket}:d:${Math.floor(t / DAY)}:${who}`, perDay, (Math.floor(t / DAY) + 1) * DAY],
      [`${bucket}:d:${Math.floor(t / DAY)}:*`, globalPerDay, (Math.floor(t / DAY) + 1) * DAY],
    ];
    for (const [key, max, expires] of checks) {
      let n: number;
      try {
        n = await store.hit(key, expires);
      } catch (e) {
        // Read-only buckets fail open when D1's daily write limit is hit: a free GET must not 503
        // just because its rate-limit counter cannot be written (resets 00:00 UTC).
        if (READ_ONLY_BUCKETS.has(bucket) && isStorageQuotaError(e)) return null;
        throw e;
      }
      if (n > max) {
        return json(429, { error: "rate_limited", retry_after_seconds: Math.ceil((expires - t) / 1000) }, { "Retry-After": String(Math.ceil((expires - t) / 1000)) });
      }
    }
    return null;
  }

  async function isOwner(request: Request) {
    const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
    return isOwnerKey(m?.[1], deps.ownerKey);
  }

  // ---------------- POST /v1/reports

  async function postReport(request: Request, base: string): Promise<Response> {
    const who = await ipHash(request);
    const rl = await limited("report", who, 5, 20, 2000);
    if (rl) return rl;
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const vendorErr = vendorIdError(b.vendor_id, base);
    if (vendorErr) return vendorErr;
    const vendor = vendorById(b.vendor_id as string)!;
    const network = b.network ?? "xrpl:0";
    if (network !== "xrpl:0" && network !== "eip155:8453") return bad("network", "xrpl:0 or eip155:8453");
    const evm = network === "eip155:8453";
    const txRaw = typeof b.tx_hash === "string" ? b.tx_hash.trim() : "";
    const tx = evm ? txRaw.toLowerCase() : txRaw.toUpperCase();
    if (!(evm ? EVM_TX_RE : XRPL_TX_RE).test(tx)) return bad("tx_hash", evm ? "0x + 64 hex chars" : "64 hex chars");
    const reporterRaw = typeof b.reporter === "string" ? b.reporter.trim() : "";
    if (!(evm ? EVM_ADDR_RE : XRPL_ADDR_RE).test(reporterRaw)) return bad("reporter", evm ? "0x address" : "XRPL r-address");
    const reporter = evm ? reporterRaw.toLowerCase() : reporterRaw;
    const outcome = b.outcome;
    if (typeof outcome !== "string" || !(REPORT_OUTCOMES as readonly string[]).includes(outcome)) return bad("outcome", REPORT_OUTCOMES.join(" | "));
    const httpStatus = b.http_status == null ? null : Number(b.http_status);
    if (httpStatus != null && !(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) return bad("http_status", "integer 100-599");
    if (b.response_excerpt != null && (typeof b.response_excerpt !== "string" || b.response_excerpt.length > 4000)) return bad("response_excerpt", "string, max 4000 chars");
    const signature = typeof b.signature === "string" ? b.signature.trim() : "";
    if (signature && !/^(0x)?[0-9a-fA-F]{64,300}$/.test(signature)) return bad("signature", "hex");

    if (await store.hasVerifiedReport(tx)) return json(409, { error: "duplicate_report", detail: "A verified report for this transaction already exists." });

    const challenge = `lumi-report:${network}:${tx}`;
    let reason: string | null = null;
    let pay: LedgerPayment | undefined;
    const look = evm ? await lookupBaseUsdc(deps.fetch, deps.baseRpc, tx) : await lookupXrplPayment(deps.fetch, deps.xrplRpc, tx);
    if (!look.ok && look.reason === "ledger_unavailable") {
      return json(503, { error: "ledger_unavailable", detail: "Could not reach the ledger to verify this transaction; nothing was stored. Try again later.", retryable: true }, { "Retry-After": "60" });
    }
    if (!look.ok) reason = look.reason;
    else {
      const payTos = evm ? (vendor.pay_to.evm ?? []).map((a) => a.toLowerCase()) : vendor.pay_to.xrpl;
      const fromReporter = look.payments.filter((p) => p.from === reporter);
      pay = fromReporter.find((p) => payTos.includes(p.to));
      if (!fromReporter.length) reason = "sender_mismatch";
      else if (!pay) reason = "recipient_not_vendor";
      else if (!(pay.ts <= now() + 60_000 && pay.ts >= now() - REPORT_MAX_AGE_MS)) reason = "tx_too_old";
      else if (!signature) reason = "signature_required";
      else if (evm) {
        if (recoverEvmSigner(challenge, signature) !== reporter) reason = "bad_signature";
      } else if (!pay.signingPubKey) reason = "multisig_unsupported";
      else if (!verifyXrplSignature(challenge, signature, pay.signingPubKey)) reason = "bad_signature";
    }
    const verified = reason == null;
    const row: ReportRow = {
      id: crypto.randomUUID(),
      vendor_id: vendor.id,
      network: String(network),
      tx_hash: tx,
      reporter,
      tx_ts: pay?.ts ?? null,
      amount: pay?.amount ?? null,
      asset: pay?.asset ?? null,
      http_status: httpStatus,
      outcome,
      excerpt: typeof b.response_excerpt === "string" ? cleanText(b.response_excerpt).slice(0, 4000) : null,
      signed: !!signature,
      verified,
      reason,
      ip_hash: who,
      ts: now(),
    };
    const ins = await store.addReport(row);
    if (ins === "duplicate") return json(409, { error: "duplicate_report", detail: "A verified report for this transaction already exists." });
    deps.log({ event: "trust_report", vendor: vendor.id, verified, reason });
    if (!verified) {
      return json(422, {
        accepted: false,
        verified: false,
        reason,
        challenge,
        note: "Not verified: this report is stored privately for abuse review and is not shown or scored. See the methodology for what a verified report needs.",
        methodology: "/v1/trust/methodology",
      });
    }
    return json(201, {
      accepted: true,
      verified: true,
      id: row.id,
      vendor_id: vendor.id,
      counts_from: iso(row.ts + REPORT_HOLD_MS),
      note: "Verified (on-ledger payment + payer signature). Shown on the vendor entry now; counts toward the score after a 24 h hold.",
    });
  }

  // ---------------- POST /v1/tips (private)

  async function postTip(request: Request): Promise<Response> {
    const who = await ipHash(request);
    const rl = await limited("tip", who, 3, 10, 1000);
    if (rl) return rl;
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const text = typeof b.text === "string" ? cleanText(b.text) : "";
    if (text.length < 10 || text.length > 1000) return bad("text", "string, 10-1000 chars");
    let coins: string[] = [];
    if (b.coins != null) {
      if (!Array.isArray(b.coins) || b.coins.length > 10 || !b.coins.every((c) => typeof c === "string" && /^[A-Za-z0-9]{1,12}$/.test(c))) return bad("coins", "up to 10 symbols, 1-12 alphanumeric chars");
      coins = (b.coins as string[]).map((c) => c.toUpperCase());
    }
    let urls: string[] = [];
    if (b.source_urls != null) {
      const ok = Array.isArray(b.source_urls) && b.source_urls.length <= 5 && b.source_urls.every((u) => {
        if (typeof u !== "string" || u.length > 300) return false;
        try { return new URL(u).protocol === "https:"; } catch { return false; }
      });
      if (!ok) return bad("source_urls", "up to 5 https URLs, max 300 chars each");
      urls = b.source_urls as string[];
    }
    const id = crypto.randomUUID();
    await store.addTip({ id, text, coins: coins.length ? coins.join(",") : null, urls: urls.length ? JSON.stringify(urls) : null, ip_hash: who, ts: now() });
    deps.log({ event: "trust_tip" });
    return json(202, { received: true, id, privacy: "Stored privately. Tips are never shown, published, or returned by any endpoint." });
  }

  // ---------------- POST /v1/trust/replies

  async function postReply(request: Request, base: string): Promise<Response> {
    const owner = await isOwner(request);
    const who = await ipHash(request);
    if (!owner) {
      const rl = await limited("reply", who, 3, 10, 500);
      if (rl) return rl;
    }
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const vendorErr = vendorIdError(b.vendor_id, base);
    if (vendorErr) return vendorErr;
    const vendor = vendorById(b.vendor_id as string)!;
    const text = typeof b.text === "string" ? scrubText(cleanText(b.text)) : "";
    if (text.length < 1 || text.length > 1000) return bad("text", "string, 1-1000 chars");
    if (owner) {
      if (b.via !== "email") return bad("via", "owner replies must set via: \"email\"");
      await store.addReply({ id: crypto.randomUUID(), vendor_id: vendor.id, text, via: "email", verified: true, ts: now() });
      return json(201, { accepted: true, verified: true, via: "email" });
    }
    const network = b.network ?? "xrpl:0";
    const address = typeof b.address === "string" ? b.address.trim() : "";
    const signature = typeof b.signature === "string" ? b.signature.trim() : "";
    if (!/^(0x)?[0-9a-fA-F]{64,300}$/.test(signature)) return bad("signature", "hex signature of the challenge");
    const challenge = `lumi-reply:${vendor.id}:${await sha256Hex(text)}`;
    let ok = false;
    let reason = "bad_signature";
    if (network === "eip155:8453") {
      if (!EVM_ADDR_RE.test(address)) return bad("address", "0x address");
      const listed = (vendor.pay_to.evm ?? []).map((a) => a.toLowerCase());
      if (!listed.includes(address.toLowerCase())) reason = "address_not_listed_for_vendor";
      else ok = recoverEvmSigner(challenge, signature) === address.toLowerCase();
    } else if (network === "xrpl:0") {
      if (!XRPL_ADDR_RE.test(address)) return bad("address", "XRPL r-address");
      const pub = typeof b.public_key === "string" ? b.public_key.trim() : "";
      if (!/^[0-9A-Fa-f]{66}$/.test(pub)) return bad("public_key", "33-byte hex public key");
      if (!vendor.pay_to.xrpl.includes(address)) reason = "address_not_listed_for_vendor";
      else if (verifyXrplSignature(challenge, signature, pub)) {
        const derived = xrplAddressOf(pub);
        if (derived === address) ok = true;
        else {
          const regular = await xrplRegularKey(deps.fetch, deps.xrplRpc, address);
          if (regular === undefined) return json(503, { error: "ledger_unavailable", retryable: true }, { "Retry-After": "60" });
          ok = !!regular && regular === derived;
          if (!ok) reason = "key_not_authorized_for_address";
        }
      }
    } else return bad("network", "xrpl:0 or eip155:8453");
    if (!ok) return json(422, { accepted: false, verified: false, reason, challenge, note: "Not stored. Sign the challenge with a key of a pay-to address listed for this vendor, or email " + CONTACT_EMAIL });
    await store.addReply({ id: crypto.randomUUID(), vendor_id: vendor.id, text, via: `signed:${address}`, verified: true, ts: now() });
    deps.log({ event: "trust_reply", vendor: vendor.id });
    return json(201, { accepted: true, verified: true, note: "Shown with the vendor entry." });
  }

  // ---------------- POST /v1/trust/observations (owner)

  async function postObservation(request: Request, base: string): Promise<Response> {
    if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const vendorErr = vendorIdError(b.vendor_id, base);
    if (vendorErr) return vendorErr;
    const vendor = vendorById(b.vendor_id as string)!;
    const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
    if (!vendor.endpoints.some((e) => e.url === endpoint)) return bad("endpoint", "one of the vendor's listed endpoint URLs");
    if ((b.network ?? "xrpl:0") !== "xrpl:0") return bad("network", "xrpl:0");
    const tx = typeof b.tx_hash === "string" ? b.tx_hash.trim().toUpperCase() : "";
    if (!XRPL_TX_RE.test(tx)) return bad("tx_hash", "64 hex chars");
    const httpStatus = b.http_status == null ? null : Number(b.http_status);
    if (httpStatus != null && !(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) return bad("http_status", "integer 100-599 or null");
    if (typeof b.data_returned !== "boolean") return bad("data_returned", "boolean");
    const latency = b.latency_ms == null ? null : Number(b.latency_ms);
    if (latency != null && !(Number.isInteger(latency) && latency >= 0 && latency <= 600_000)) return bad("latency_ms", "integer ms 0-600000 or null");
    const summary = typeof b.summary === "string" ? cleanText(b.summary) : "";
    if (summary.length < 1 || summary.length > 300) return bad("summary", "string, 1-300 chars");
    if (BANNED_WORDS.test(summary)) return bad("summary", "factual wording only (describe what was observed)");

    const look = await lookupXrplPayment(deps.fetch, deps.xrplRpc, tx);
    if (!look.ok) {
      if (look.reason === "ledger_unavailable") return json(503, { error: "ledger_unavailable", retryable: true }, { "Retry-After": "30" });
      return json(422, { recorded: false, reason: look.reason });
    }
    const pay = look.payments[0];
    if (!deps.buyers.includes(pay.from)) return json(422, { recorded: false, reason: "sender_not_lumi_wallet" });
    if (!vendor.pay_to.xrpl.includes(pay.to)) return json(422, { recorded: false, reason: "recipient_not_vendor" });
    if (b.amount != null && Math.abs(Number(b.amount) - Number(pay.amount)) > 1e-9) return json(422, { recorded: false, reason: "amount_mismatch", ledger_amount: pay.amount });
    if (b.asset != null && b.asset !== pay.asset) return json(422, { recorded: false, reason: "asset_mismatch", ledger_asset: pay.asset });

    if (b.inconclusive != null && !isInconclusiveReason(b.inconclusive)) return bad("inconclusive", Object.keys(INCONCLUSIVE_REASONS).join(" | "));
    // Guard: no HTTP status + no data is inconclusive (Lumi-side), never "no data returned".
    const row: ObservationRow = guardBuy({
      vendor_id: vendor.id,
      endpoint,
      ts: Number.isFinite(pay.ts) ? pay.ts : now(),
      network: "xrpl:0",
      tx_hash: tx,
      amount: pay.amount,
      asset: pay.asset,
      http_status: httpStatus,
      data_returned: b.data_returned,
      latency_ms: latency,
      summary,
      source: "lumi_test_buy",
      inconclusive: b.inconclusive ?? null,
    });
    let ins: Awaited<ReturnType<TrustStore["addObservation"]>>;
    try {
      ins = await store.addObservation(row);
    } catch (e) {
      if (!isStorageQuotaError(e)) throw e;
      deps.log({ event: "trust_observation_storage_unavailable", vendor: vendor.id, tx });
      const su = storageUnavailableBody(now());
      return json(503, { ...su.body, tx_hash: tx }, { "Retry-After": String(su.retryAfter) });
    }
    deps.log({ event: "trust_observation", vendor: vendor.id, inserted: ins === "inserted" });
    if (ins === "duplicate") return json(200, { recorded: false, duplicate: true, tx_hash: tx });
    return json(201, { recorded: true, observation: obsView(row) });
  }

  // ---------------- POST /v1/trust/attempts (owner): a signed test payment the seller did not accept (never on-ledger)

  async function postAttempt(request: Request, base: string): Promise<Response> {
    if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const vendorErr = vendorIdError(b.vendor_id, base);
    if (vendorErr) return vendorErr;
    const vendor = vendorById(b.vendor_id as string)!;
    const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
    let host = "";
    try { host = new URL(endpoint).host; } catch { /* invalid */ }
    if (!host || !endpoint.startsWith("https://") || host !== new URL(vendor.homepage).host) return bad("endpoint", "an https URL on the vendor's own host");
    if ((b.network ?? "xrpl:0") !== "xrpl:0") return bad("network", "xrpl:0");
    const tx = typeof b.tx_hash === "string" ? b.tx_hash.trim().toUpperCase() : "";
    if (!XRPL_TX_RE.test(tx)) return bad("tx_hash", "64 hex chars");
    const ts = typeof b.signed_at === "string" ? Date.parse(b.signed_at) : NaN;
    if (!Number.isFinite(ts) || ts > now() + 60_000 || ts < now() - 120 * DAY) return bad("signed_at", "ISO time within the last 120 days");
    const httpStatus = b.http_status == null ? null : Number(b.http_status);
    if (httpStatus != null && !(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) return bad("http_status", "integer 100-599 or null");
    const amount = b.amount == null ? null : String(b.amount);
    if (amount != null && !(Number(amount) > 0)) return bad("amount", "positive number or null");
    const asset = b.asset == null ? null : String(b.asset);
    if (asset != null && !/^[A-Z]{3,12}$/.test(asset)) return bad("asset", "asset code such as RLUSD or XRP");
    const detail = b.detail == null ? null : cleanText(String(b.detail));
    if (detail != null && (detail.length > 200 || BANNED_WORDS.test(detail))) return bad("detail", "factual wording, at most 200 chars");

    // Only a payment that never reached the ledger counts; a settled one is a paid test-buy (POST /v1/trust/observations).
    const look = await lookupXrplPayment(deps.fetch, deps.xrplRpc, tx);
    if (look.ok) return json(409, { recorded: false, reason: "payment_on_ledger", detail: "This payment settled; record it with POST /v1/trust/observations." });
    if (look.reason === "ledger_unavailable") return json(503, { error: "ledger_unavailable", retryable: true }, { "Retry-After": "30" });
    const row: UnsettledAttemptRow = { vendor_id: vendor.id, endpoint, ts, network: "xrpl:0", tx_hash: tx, amount, asset, http_status: httpStatus, detail };
    const ins = await store.addUnsettledAttempt(row);
    deps.log({ event: "trust_unsettled_attempt", vendor: vendor.id, inserted: ins === "inserted", ledger: look.reason });
    if (ins === "duplicate") return json(200, { recorded: false, duplicate: true, tx_hash: tx });
    return json(201, { recorded: true, attempt: { ...row, signed_at: new Date(ts).toISOString(), ledger: look.reason } });
  }

  // ---------------- POST /v1/trust/buys/inconclusive (owner): correct a stored buy to "delivery unknown, Lumi-side"

  async function postInconclusive(request: Request): Promise<Response> {
    if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const b = parsed.body;
    const tx = typeof b.tx_hash === "string" ? b.tx_hash.trim() : "";
    if (!/^(0x[0-9a-fA-F]{64}|[0-9A-Fa-f]{64})$/.test(tx)) return bad("tx_hash", "XRPL (64 hex) or Base (0x + 64 hex) tx hash");
    if (!isInconclusiveReason(b.reason)) return bad("reason", Object.keys(INCONCLUSIVE_REASONS).join(" | "));
    const norm = tx.startsWith("0x") ? tx.toLowerCase() : tx.toUpperCase();
    const prior = deps.receipts ? await deps.receipts.buy(norm) : null;
    if (!prior) return json(404, { error: "unknown_test_buy", tx_hash: norm });
    if (prior.data_returned && b.force !== true) return json(409, { error: "buy_returned_data", detail: "This buy is recorded as delivered; not reclassified." });
    const summary = guardBuy({ http_status: prior.http_status, data_returned: false, inconclusive: b.reason, summary: prior.summary }).summary;
    const at = now();
    const row = prior.kind === "catalog"
      ? await deps.catalog?.markInconclusive(norm, b.reason, summary)
      : await store.markObservationInconclusive(norm, b.reason, summary, at);
    if (!row) return json(404, { error: "unknown_test_buy", tx_hash: norm });
    deps.log({ event: "buy_marked_inconclusive", tx: norm, kind: prior.kind, reason: b.reason });
    return json(200, { corrected: true, tx_hash: norm, kind: prior.kind, reason: b.reason, summary_before: prior.summary, summary, delivery: deliveryState(row), data_returned: dataReturnedView(row), note: "Prior summary kept (summary_before). Log the public correction at POST /v1/owner/corrections and upload a superseding receipt." });
  }

  async function lookup(q: LookupQuery, base: string, opts: { free?: boolean } = {}): Promise<Record<string, unknown>> {
    if (deps.catalog) {
      const doc = await deps.catalog.lookupDoc(q, base, { free: !!opts.free });
      if (!deps.annotate) return doc;
      return deps.annotate(doc, payTosIn(doc, q)).catch(() => doc);
    }
    return { kind: "trust_lookup", query: q, observed: false, note: "Catalog lookups are unavailable on this deployment." };
  }

  // ---------------- signed test-buy receipts

  async function receiptRoutes(request: Request, path: string, base: string): Promise<Response | null> {
    const method = request.method;
    if (path === "/v1/trust/receipts/verify") {
      if (method === "GET" || method === "HEAD") return json(200, receiptVerifyDoc(base), { "Cache-Control": "public, max-age=3600" });
      if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST, OPTIONS" });
      const lim = await limited("receipt", await ipHash(request), RECEIPT_FREE_LIMITS.perMinute, RECEIPT_FREE_LIMITS.perDay, RECEIPT_FREE_LIMITS.globalPerDay);
      if (lim) return lim;
      let r: any;
      try {
        const text = await request.text();
        if (text.length > MAX_BODY) return json(413, { error: "body_too_large", max_bytes: MAX_BODY });
        r = JSON.parse(text);
      } catch { return json(400, { error: "invalid_json" }); }
      if (r && typeof r === "object" && r.receipt && !r.type) r = r.receipt;
      const check = await verifyReceipt(r);
      const out: Record<string, unknown> = { kind: "receipt_verification_result", ...check };
      if (check.hash_ok && deps.receipts) {
        const known = (await deps.receipts.byTx([String(r.payment.tx_hash)]).catch(() => new Map())).get(String(r.payment.tx_hash));
        const current = !!known && known.receipt_hash === r.receipt_hash;
        const old = current ? null : await deps.receipts.superseded(String(r.receipt_hash)).catch(() => null);
        out.issued_by_lumi = current || !!old;
        out.status = current ? "current" : old ? "superseded" : "unknown";
        if (old) out.superseded = { at: iso(old.superseded_at), by_receipt_hash: old.superseded_by, reason: old.reason, corrections: `${base}/v1/monitor/corrections` };
      }
      if (new URL(request.url).searchParams.get("ledger") === "1" && check.ok) {
        const p = r.payment;
        const look = p.network === "xrpl:0" ? await lookupXrplPayment(deps.fetch, deps.xrplRpc, String(p.tx_hash))
          : p.network === "stellar:pubnet" ? await lookupStellarUsdc(deps.fetch, deps.stellarHorizon ?? STELLAR_HORIZON, String(p.tx_hash))
          : await lookupBaseUsdc(deps.fetch, deps.baseRpc, String(p.tx_hash));
        if (!look.ok) out.ledger = { ok: false, reason: look.reason };
        else {
          const pay = look.payments.find((x) => x.from.toLowerCase() === String(p.payer).toLowerCase() && x.to.toLowerCase() === String(r.seller.pay_to).toLowerCase());
          const errs: string[] = [];
          if (!pay) errs.push("no_transfer_from_payer_to_pay_to");
          else {
            if (Math.abs(Number(pay.amount) - Number(p.amount)) > 1e-9) errs.push("amount_mismatch");
            if (pay.asset !== p.asset) errs.push("asset_mismatch");
            if (p.network === "xrpl:0" && pay.signingPubKey && r.signer.public_key && pay.signingPubKey.toUpperCase() !== String(r.signer.public_key).toUpperCase()) errs.push("signing_key_differs_from_tx");
          }
          out.ledger = { ok: !errs.length, errors: errs, checked_at: iso(now()) };
        }
      }
      out.note = "Hash and signature prove the paying wallet signed this receipt (signature_ok is only true when the signature covers this exact body). delivery.* is the tester's signed statement; it cannot be proven on-chain. status superseded = Lumi replaced this receipt with a correction (see superseded).";
      return json(200, out, { "Cache-Control": "no-store" });
    }
    if (!deps.receipts) return json(404, { error: "not_found" });
    if (path === "/v1/trust/receipts/pending" && (method === "GET" || method === "HEAD")) {
      if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      const one = new URL(request.url).searchParams.get("tx");
      if (one) {
        // Re-sign one stored buy (correction): its current row and the receipt it would supersede.
        const buy = await deps.receipts.buy(one);
        const cur = buy ? (await deps.receipts.byTx([buy.tx_hash]).catch(() => new Map<string, Receipt>())).get(buy.tx_hash) : undefined;
        return json(buy ? 200 : 404, { pending: buy ? [buy] : [], current_receipt_hash: cur?.receipt_hash ?? null, current_receipt: cur ?? null }, { "Cache-Control": "no-store" });
      }
      const n = Number(new URL(request.url).searchParams.get("limit") ?? 100);
      return json(200, { pending: await deps.receipts.pending(Number.isFinite(n) ? n : 100), stored: await deps.receipts.count() }, { "Cache-Control": "no-store" });
    }
    if (path === "/v1/trust/receipts" && method === "POST") {
      if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      let b: any;
      try { b = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
      const list: any[] = Array.isArray(b?.receipts) ? b.receipts.slice(0, 5) : [];
      const xr = new Set(deps.buyers), ev = new Set((deps.evmBuyers ?? []).map((x) => x.toLowerCase())), stb = new Set(deps.stellarBuyers ?? []);
      const results: Record<string, unknown>[] = [];
      const ok: { tx_hash: string; network: string; kind: "vendor" | "catalog"; ref: string; receipt: Receipt }[] = [];
      for (const r of list) {
        const c = await verifyReceipt(r);
        const tx = String(r?.payment?.tx_hash ?? "");
        if (!c.ok) { results.push({ tx_hash: tx, stored: false, errors: c.errors }); continue; }
        const payer = String(r.payment.payer);
        if (!(r.payment.network === "xrpl:0" ? xr.has(payer) : r.payment.network === "stellar:pubnet" ? stb.has(payer) : ev.has(payer.toLowerCase()))) { results.push({ tx_hash: tx, stored: false, errors: ["payer_not_lumi_wallet"] }); continue; }
        const buy = await deps.receipts.buy(tx);
        if (!buy) { results.push({ tx_hash: tx, stored: false, errors: ["unknown_test_buy"] }); continue; }
        const mm = receiptMatchesBuy(r, buy);
        if (mm) { results.push({ tx_hash: tx, stored: false, errors: [mm] }); continue; }
        // Replacing a stored receipt is a correction: the new receipt must name the one it supersedes, and the old one is
        // archived verbatim (still verifiable, marked superseded) instead of being silently overwritten.
        const cur = (await deps.receipts.byTx([tx]).catch(() => new Map<string, Receipt>())).get(tx);
        if (cur && cur.receipt_hash === r.receipt_hash) { results.push({ tx_hash: tx, stored: false, duplicate: true }); continue; }
        if (cur && r.supersedes?.receipt_hash !== cur.receipt_hash) { results.push({ tx_hash: tx, stored: false, errors: ["supersedes_required"], current_receipt_hash: cur.receipt_hash }); continue; }
        if (!cur && r.supersedes) { results.push({ tx_hash: tx, stored: false, errors: ["nothing_to_supersede"] }); continue; }
        if (cur) await deps.receipts.archive({ receipt_hash: cur.receipt_hash, tx_hash: tx, receipt: cur, superseded_at: now(), superseded_by: r.receipt_hash, reason: String(r.supersedes.reason ?? "").slice(0, 300) });
        ok.push({ tx_hash: tx, network: buy.network, kind: buy.kind, ref: buy.ref, receipt: r });
        results.push({ tx_hash: tx, stored: true, ...(cur ? { superseded: cur.receipt_hash } : {}) });
      }
      await deps.receipts.put(ok);
      deps.log({ event: "receipts_stored", n: ok.length, rejected: list.length - ok.length });
      return json(200, { stored: ok.length, results });
    }
    return null;
  }

  async function handle(request: Request, path: string, base: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null> {
    const r = await handleInner(request, path, base, ctx);
    // A successful trust write (verified report/observation/reply, manual probe) can change scores: drop the index.
    if (r && request.method === "POST" && r.status < 300 && TRUST_POST_PATHS.includes(path)) await invalidateVendorsIndex();
    return r;
  }

  async function handleInner(request: Request, path: string, base: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null> {
    const method = request.method;
    if (deps.catalog && path.startsWith("/v1/trust/catalog")) {
      if ((method === "GET" || method === "HEAD") && path === "/v1/trust/catalog") {
        const lim = await limited("catalog", await ipHash(request), FREE_LIMITS.catalog.perMinute, FREE_LIMITS.catalog.perDay, FREE_LIMITS.catalog.globalPerDay);
        if (lim) return lim;
      }
      const r = await deps.catalog.handle(request, new URL(request.url), base);
      if (r) return r;
    }
    if (path.startsWith("/v1/trust/receipts")) {
      const r = await receiptRoutes(request, path, base);
      if (r) return r;
    }
    if (method === "GET" || method === "HEAD") {
      if (path === "/v1/trust/methodology") return json(200, methodologyDoc(base), { "Cache-Control": "public, max-age=3600" });
      if (path === "/v1/trust/vendors") {
        const sp = new URL(request.url).searchParams;
        const q = lookupQuery(sp);
        const err = lookupError(q ?? {}, lookupPresent(sp));
        if (err) return json(400, err, { "Cache-Control": "no-store" });
        if (q) {
          if (q.domain) q.domain = q.domain.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/:\d+$/, "").toLowerCase();
          const lim = await lookupLimit(request);
          if (lim) return deps.safetyFor ? withSafety(lim, await deps.safetyFor(q, base)) : lim;
          const doc = await lookup(q, base, { free: true });
          if (deps.onFreeCheck) {
            const p = deps.onFreeCheck(q, base).catch((e) => deps.log({ event: "buy_queue_error", source: "free_lookup", error: String(e) }));
            if (ctx) ctx.waitUntil(p); else await p;
          }
          return json(200, doc, { "Cache-Control": "public, max-age=300" });
        }
        const v = await cachedVendorsDoc(base);
        return json(200, v.doc, { "Cache-Control": "public, max-age=120", "X-Lumi-Cache": v.cache });
      }
      const m = path.match(/^\/v1\/trust\/vendors\/([a-z0-9-]{1,64})$/);
      if (m) {
        const doc = await vendorDoc(m[1], base);
        return doc ? json(200, doc, { "Cache-Control": "public, max-age=120" }) : json(404, { error: "unknown_vendor", vendors: VENDORS.map((v) => v.id) });
      }
      if (TRUST_POST_PATHS.includes(path)) return json(405, { error: "method_not_allowed", detail: "POST only." }, { Allow: "POST, OPTIONS" });
      return null;
    }
    if (method !== "POST") return TRUST_POST_PATHS.includes(path) || path.startsWith("/v1/trust/") ? json(405, { error: "method_not_allowed" }, { Allow: "GET, POST, OPTIONS" }) : null;
    switch (path) {
      case "/v1/reports":
        return postReport(request, base);
      case "/v1/tips":
        return postTip(request);
      case "/v1/trust/replies":
        return postReply(request, base);
      case "/v1/trust/observations":
        return postObservation(request, base);
      case "/v1/trust/buys/inconclusive":
        return postInconclusive(request);
      case "/v1/trust/attempts":
        return postAttempt(request, base);
      case "/v1/trust/probe":
        if (!(await isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
        return json(200, { ran: true, ...(await runProbes()) });
    }
    return null;
  }

  async function vendorScore(id: string) {
    const v = vendorById(id);
    if (!v) return null;
    const [g, reach] = await Promise.all([gather(v), reachability(v)]);
    const last = g.obs.map(deliveryState).find((d) => d !== "inconclusive") ?? null;
    return { vendor_id: v.id, name: v.name, score: g.score, status: reach.status, last_conclusive: last as "delivered" | "not_delivered" | null };
  }

  async function freeLimit(request: Request, bucket: "lookup") {
    return lookupLimit(request);
  }

  return { handle, runProbes, vendorsDoc, vendorDoc, vendorReport, lookup, vendorScore, freeLimit, vendorReplies: (id: string) => store.verifiedReplies(id) };
}
