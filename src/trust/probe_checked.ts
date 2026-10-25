/**
 * Free "probe-checked" seller tier: checks Lumi can run without paying anyone.
 *
 * A probe-checked seller answered one unpaid request with a readable x402 402 quote, and Lumi looked at
 * public facts around it (TLS, domain age, whether the payTo has any public on-chain history, listing completeness).
 *
 * Integrity rules (enforced here and in tests):
 *  - Probe-only sellers are labelled PROBE_LABEL ("Checked, not test-bought") everywhere and are never `verified`.
 *  - A probe can never weigh as much as a delivered test-buy: PROBE_MAX_WEIGHT < BUY_MIN_WEIGHT.
 *  - Paying Lumi never changes any of this; nothing here reads billing or subscription state.
 *  - Failures use neutral, factual wording (FAIL_TEXT). No accusations.
 *  - On-chain history is a count band only. Never a balance, income figure or counterparty.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { optUsd } from "./catalog";
import type { D1Like } from "../config";

export const PROBE_LABEL = "Checked, not test-bought" as const;
export const PROBE_LABEL_NOTE =
  "Lumi sent this seller one free, unpaid request and checked its x402 payment response, whether it was reachable, its TLS certificate, its domain age, whether its payment address has any public on-chain history, and whether its listing is complete. Lumi has not paid this seller, so these checks say nothing about what a paid call returns.";
/** Shown wherever a domain age is blank (no RDAP registration date). */
export const DOMAIN_AGE_UNAVAILABLE = "domain age unavailable";
export const PROBE_RULES_VERSION = "2026-10-25.p1";

/** Score weights. A probe pass can add at most PROBE_MAX_WEIGHT; one delivered test-buy alone is worth BUY_MIN_WEIGHT. */
export const PROBE_MAX_WEIGHT = 0.25;
export const BUY_MIN_WEIGHT = 1;

export type CheckState = "pass" | "fail" | "unknown";
export type CheckId = "x402_quote" | "quote_fields" | "price_matches_listing" | "pay_to_format" | "reachable" | "tls" | "domain_age" | "pay_to_history" | "listing_complete";

/** Neutral wording for every failure. Facts only. */
export const FAIL_TEXT: Record<string, string> = {
  no_402: "did not answer with an x402 payment request",
  payment_response_invalid: "payment response invalid",
  quote_fields_missing: "payment response is missing required fields",
  price_differs: "quoted price differs from the listing",
  pay_to_not_listed: "quote pays an address not in the listing",
  pay_to_format: "payment address format does not match its network",
  pay_to_checksum: "payment address checksum does not match",
  unreachable: "no answer within 10 s",
  network_error: "network error",
  tls_invalid: "TLS certificate could not be validated",
  tls_expiring: "TLS certificate expires within 7 days",
  young_domain: "domain registered less than 30 days ago",
  no_public_history: "payment address has no public on-chain history yet",
  listing_incomplete: "listing has no description or input schema",
  robots_disallowed: "robots.txt asks crawlers not to fetch this path, so it was not checked",
};

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const XRPL_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const BASE_NETS = new Set(["base", "eip155:8453"]);
export const isBase = (n: unknown) => BASE_NETS.has(String(n ?? "").toLowerCase());

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** EIP-55: all-lowercase / all-uppercase addresses carry no checksum and are accepted; mixed case must match. */
export function eip55Ok(addr: string): boolean {
  if (!EVM_RE.test(addr)) return false;
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const h = hex(keccak_256(new TextEncoder().encode(body.toLowerCase())));
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (/[a-f]/i.test(c) && (parseInt(h[i], 16) >= 8 ? c !== c.toUpperCase() : c !== c.toLowerCase())) return false;
  }
  return true;
}

export function payToFormat(network: string, payTo: string): { ok: boolean; code?: string } {
  const n = String(network ?? "").toLowerCase();
  if (n.startsWith("eip155:") || ["base", "polygon", "base-sepolia", "avalanche", "sei", "iotex", "peaq"].includes(n)) {
    if (!EVM_RE.test(payTo)) return { ok: false, code: "pay_to_format" };
    if (/^0x0{40}$/i.test(payTo)) return { ok: false, code: "pay_to_format" };
    return eip55Ok(payTo) ? { ok: true } : { ok: false, code: "pay_to_checksum" };
  }
  if (n.startsWith("solana")) return SOL_RE.test(payTo) ? { ok: true } : { ok: false, code: "pay_to_format" };
  if (n.startsWith("xrpl")) return XRPL_RE.test(payTo) ? { ok: true } : { ok: false, code: "pay_to_format" };
  if (n.startsWith("stellar")) return STELLAR_RE.test(payTo) ? { ok: true } : { ok: false, code: "pay_to_format" };
  return { ok: payTo.length > 0 && payTo.length < 200 };
}

export interface QuoteEval {
  x402: boolean;
  version: number | null;
  fields_ok: boolean;
  missing: string[];
  base_offer: boolean;
  pay_to: string | null;
  network: string | null;
  price_usd: number | null;
  price_match: boolean | null;
  pay_to_listed: boolean | null;
  pay_to_format_ok: boolean;
  codes: string[];
}

/**
 * Evaluate one unpaid 402 response body (already decoded from the PAYMENT-REQUIRED header or JSON body).
 * `listing` is what the public listing said (Bazaar/x402scan); any field may be missing.
 */
export function evaluateQuote(status: number | null, pr: any, listing: { price_usd?: string | null; pay_tos?: string[] } = {}): QuoteEval {
  const out: QuoteEval = { x402: false, version: null, fields_ok: false, missing: [], base_offer: false, pay_to: null, network: null, price_usd: null, price_match: null, pay_to_listed: null, pay_to_format_ok: false, codes: [] };
  if (status !== 402) { out.codes.push("no_402"); return out; }
  if (!pr || typeof pr !== "object" || !Array.isArray(pr.accepts) || !pr.accepts.length) { out.codes.push("payment_response_invalid"); return out; }
  out.x402 = true;
  out.version = Number.isFinite(Number(pr.x402Version)) ? Number(pr.x402Version) : null;
  const accepts = pr.accepts.filter((a: any) => a && typeof a === "object");
  const pick = accepts.find((a: any) => isBase(a.network)) ?? accepts[0];
  out.base_offer = accepts.some((a: any) => isBase(a.network));
  const need = ["scheme", "network", "asset", "payTo"];
  out.missing = need.filter((k) => pick?.[k] == null || pick?.[k] === "");
  if (pick?.amount == null && pick?.maxAmountRequired == null) out.missing.push("amount");
  out.fields_ok = out.missing.length === 0;
  if (!out.fields_ok) out.codes.push("quote_fields_missing");
  out.pay_to = pick?.payTo != null ? String(pick.payTo) : null;
  out.network = pick?.network != null ? String(pick.network) : null;
  if (out.pay_to && out.network) {
    const f = payToFormat(out.network, out.pay_to);
    out.pay_to_format_ok = f.ok;
    if (!f.ok) out.codes.push(f.code ?? "pay_to_format");
  }
  const usd = accepts.map(optUsd).find((x: number | null) => x != null) ?? null;
  out.price_usd = usd;
  if (usd != null && listing.price_usd != null && listing.price_usd !== "") {
    out.price_match = Math.abs(Number(listing.price_usd) - usd) < 1e-9;
    if (!out.price_match) out.codes.push("price_differs");
  }
  if (listing.pay_tos?.length) {
    const listed = listing.pay_tos.map((p) => p.toLowerCase());
    out.pay_to_listed = accepts.some((a: any) => listed.includes(String(a?.payTo ?? "").toLowerCase()));
    if (!out.pay_to_listed) out.codes.push("pay_to_not_listed");
  }
  return out;
}

/** On-chain history as a band only. Never store a balance, amount or counterparty. */
export type HistoryBand = "none" | "1-9" | "10-99" | "100+" | "unknown";
export function historyBand(n: number | null | undefined): HistoryBand {
  if (n == null || !Number.isFinite(n)) return "unknown";
  if (n <= 0) return "none";
  if (n < 10) return "1-9";
  if (n < 100) return "10-99";
  return "100+";
}

export interface EndpointProbe {
  endpoint: string;
  ts: number;
  status: number | null;
  latency_ms: number | null;
  error: string | null; // "unreachable" | "network_error" | "robots_disallowed" | null
  quote: QuoteEval | null;
}

export interface SellerProbeInput {
  seller: string; // registrable domain
  endpoints: EndpointProbe[];
  tls?: { ok: boolean; days_left: number | null } | null;
  domain_age_days?: number | null;
  pay_to_history?: HistoryBand;
  listing_complete?: boolean | null;
  /** Delivered Lumi test-buys for this seller (any age); used only to choose the label, never mixed into the probe score. */
  delivered_test_buys?: number;
}

export interface SellerProbeResult {
  seller: string;
  label: string;
  verified: false;
  score_weight: number;
  checks: Record<CheckId, CheckState>;
  passed: number;
  failed: number;
  outcome: "pass" | "partial" | "fail" | "not_checked";
  notes: string[];
  endpoints_checked: number;
  endpoints_quoting: number;
  median_latency_ms: number | null;
  rules_version: string;
  /** Normalised origin+path of every endpoint this run probed (no query string). Lets a check tell "the probe failed on the
   * endpoint Lumi test-bought" apart from "the probe hit some other endpoint on the same domain". */
  probed_endpoints?: string[];
}

/** origin + path, lower-case host, no query/fragment, no trailing slash. null when not an http(s) URL. */
export function normEndpoint(u: string): string | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") return null;
    const path = x.pathname.replace(/\/+$/, "");
    return `${x.protocol}//${x.host.toLowerCase().replace(/^www\./, "")}${path}`.slice(0, 300);
  } catch { return null; }
}
export const PROBE_MAX_ENDPOINTS_RECORDED = 10;

const med = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Roll endpoint probes and public facts up to one seller. Pure. */
export function rollupSeller(i: SellerProbeInput): SellerProbeResult {
  const eps = i.endpoints.filter((e) => e.error !== "robots_disallowed");
  const quoting = eps.filter((e) => e.quote?.x402);
  const st = (b: boolean | null | undefined): CheckState => (b == null ? "unknown" : b ? "pass" : "fail");
  const anyEp = eps.length > 0;
  const reachable = anyEp ? eps.some((e) => e.status != null) : null;
  const checks: Record<CheckId, CheckState> = {
    x402_quote: st(anyEp ? quoting.length > 0 : null),
    quote_fields: st(quoting.length ? quoting.every((e) => e.quote!.fields_ok) : null),
    price_matches_listing: st((() => { const m = quoting.map((e) => e.quote!.price_match).filter((x) => x != null); return m.length ? m.every(Boolean) : null; })()),
    pay_to_format: st(quoting.length ? quoting.every((e) => e.quote!.pay_to_format_ok) : null),
    reachable: st(reachable),
    tls: st(i.tls == null ? null : i.tls.ok && (i.tls.days_left == null || i.tls.days_left >= 7)),
    domain_age: st(i.domain_age_days == null ? null : i.domain_age_days >= 30),
    pay_to_history: st(i.pay_to_history == null || i.pay_to_history === "unknown" ? null : i.pay_to_history !== "none"),
    listing_complete: st(i.listing_complete),
  };
  const notes = new Set<string>();
  for (const e of i.endpoints) {
    if (e.error && FAIL_TEXT[e.error]) notes.add(FAIL_TEXT[e.error]);
    for (const c of e.quote?.codes ?? []) if (FAIL_TEXT[c]) notes.add(FAIL_TEXT[c]);
  }
  if (checks.tls === "fail") notes.add(i.tls?.ok ? FAIL_TEXT.tls_expiring : FAIL_TEXT.tls_invalid);
  if (checks.domain_age === "fail") notes.add(FAIL_TEXT.young_domain);
  if (checks.pay_to_history === "fail") notes.add(FAIL_TEXT.no_public_history);
  if (checks.listing_complete === "fail") notes.add(FAIL_TEXT.listing_incomplete);
  const vals = Object.values(checks);
  const passed = vals.filter((v) => v === "pass").length;
  const failed = vals.filter((v) => v === "fail").length;
  const core = checks.x402_quote === "pass" && checks.quote_fields === "pass" && checks.pay_to_format === "pass" && checks.price_matches_listing !== "fail";
  const outcome: SellerProbeResult["outcome"] = !anyEp ? "not_checked" : checks.x402_quote !== "pass" ? "fail" : core && failed === 0 ? "pass" : core ? "partial" : "fail";
  const known = passed + failed;
  const score_weight = outcome === "not_checked" || known === 0 ? 0 : Number(((PROBE_MAX_WEIGHT * passed) / known).toFixed(3));
  const lat = eps.filter((e) => e.quote?.x402 && e.latency_ms != null).map((e) => e.latency_ms!);
  return {
    seller: i.seller,
    label: (i.delivered_test_buys ?? 0) > 0 ? "test-bought" : PROBE_LABEL,
    verified: false,
    score_weight: Math.min(score_weight, PROBE_MAX_WEIGHT),
    checks,
    passed,
    failed,
    outcome,
    notes: [...notes],
    endpoints_checked: eps.length,
    endpoints_quoting: quoting.length,
    median_latency_ms: med(lat),
    rules_version: PROBE_RULES_VERSION,
    probed_endpoints: [...new Set(eps.map((e) => normEndpoint(e.endpoint)).filter((x): x is string => !!x))].slice(0, PROBE_MAX_ENDPOINTS_RECORDED),
  };
}

/**
 * Combined evidence weight. Probe weight is capped and only fills in when there is no delivered buy;
 * a seller with a delivered buy always outranks every probe-only seller. Payment to Lumi is not an input.
 */
export function evidenceWeight(o: { delivered_test_buys: number; probe_weight: number }): number {
  if (o.delivered_test_buys > 0) return BUY_MIN_WEIGHT + Math.min(o.delivered_test_buys - 1, 4) * 0.1;
  return Math.min(Math.max(o.probe_weight, 0), PROBE_MAX_WEIGHT);
}

/** Public view: safe fields only (no payTo, no amounts, no counterparties). */
export function probePublicView(r: SellerProbeResult, checked_at: number) {
  return {
    tier: r.label,
    verified: false as const,
    test_bought: r.label !== PROBE_LABEL,
    note: r.label === PROBE_LABEL ? PROBE_LABEL_NOTE : undefined,
    outcome: r.outcome,
    checks: r.checks,
    domain_age_note: r.checks.domain_age === "pass" || r.checks.domain_age === "fail" ? null : DOMAIN_AGE_UNAVAILABLE,
    notes: r.notes,
    endpoints_checked: r.endpoints_checked,
    endpoints_quoting: r.endpoints_quoting,
    median_latency_ms: r.median_latency_ms,
    checked_at: new Date(checked_at).toISOString(),
    rules_version: r.rules_version,
  };
}

// ---------------------------------------------------------------- storage (D1 table probe_checked, migration 0028)

export interface ProbeRow {
  seller: string; checked_at: number; outcome: SellerProbeResult["outcome"]; checks: string; notes: string;
  endpoints_checked: number; endpoints_quoting: number; median_latency_ms: number | null; score_weight: number; rules_version: string;
  /** JSON array of normalised probed endpoints (migration 0029); null on rows written before it. */
  probed_endpoints?: string | null;
}
export interface ProbeStore { get(seller: string): Promise<ProbeRow | null>; put(rows: ProbeRow[]): Promise<number>; count(): Promise<number> }
export const PROBE_MAX_ROWS_PER_LOAD = 2000;
const OUTCOMES = new Set(["pass", "partial", "fail", "not_checked"]);
const CHECK_IDS: CheckId[] = ["x402_quote", "quote_fields", "price_matches_listing", "pay_to_format", "reachable", "tls", "domain_age", "pay_to_history", "listing_complete"];
// Hostname-shaped only (registrable domain or platform tenant host); wallet addresses are never a seller key.
const SELLER_RE = /^(?=.{3,253}$)(?!0x[0-9a-f]{40}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

export function toRow(r: SellerProbeResult, checked_at: number): ProbeRow {
  return { seller: r.seller, checked_at, outcome: r.outcome, checks: JSON.stringify(r.checks), notes: JSON.stringify(r.notes), endpoints_checked: r.endpoints_checked,
    endpoints_quoting: r.endpoints_quoting, median_latency_ms: r.median_latency_ms, score_weight: Math.min(r.score_weight, PROBE_MAX_WEIGHT), rules_version: r.rules_version,
    probed_endpoints: JSON.stringify(r.probed_endpoints ?? []) };
}

/** Validate one uploaded row. Rejects anything that looks like an address, amount or free text beyond the fixed notes. */
export function parseProbeRow(x: any): ProbeRow | string {
  if (!x || typeof x !== "object") return "not_an_object";
  const seller = String(x.seller ?? "").trim().toLowerCase();
  if (!SELLER_RE.test(seller)) return "invalid_seller";
  if (!OUTCOMES.has(x.outcome)) return "invalid_outcome";
  const checks = typeof x.checks === "string" ? safeJson(x.checks) : x.checks;
  if (!checks || typeof checks !== "object" || Object.keys(checks).some((k) => !CHECK_IDS.includes(k as CheckId)) || Object.values(checks).some((v) => !["pass", "fail", "unknown"].includes(String(v)))) return "invalid_checks";
  const notes = typeof x.notes === "string" ? safeJson(x.notes) : x.notes;
  const allowed = new Set(Object.values(FAIL_TEXT));
  if (!Array.isArray(notes) || notes.some((n) => !allowed.has(n))) return "invalid_notes";
  const int = (v: any) => (Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null);
  const ts = Number(x.checked_at);
  if (!Number.isFinite(ts) || ts <= 0) return "invalid_checked_at";
  const w = Number(x.score_weight);
  if (!Number.isFinite(w) || w < 0 || w > PROBE_MAX_WEIGHT) return "invalid_score_weight";
  let probed: string[] | null = null;
  if (x.probed_endpoints != null) {
    const arr = typeof x.probed_endpoints === "string" ? safeJson(x.probed_endpoints) : x.probed_endpoints;
    if (!Array.isArray(arr) || arr.length > PROBE_MAX_ENDPOINTS_RECORDED || arr.some((u) => typeof u !== "string" || normEndpoint(u) !== u)) return "invalid_probed_endpoints";
    probed = arr;
  }
  return { seller, checked_at: ts, outcome: x.outcome, checks: JSON.stringify(checks), notes: JSON.stringify(notes), endpoints_checked: int(x.endpoints_checked) ?? 0,
    endpoints_quoting: int(x.endpoints_quoting) ?? 0, median_latency_ms: int(x.median_latency_ms), score_weight: w, rules_version: String(x.rules_version ?? PROBE_RULES_VERSION).slice(0, 40),
    probed_endpoints: probed ? JSON.stringify(probed) : null };
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }

export type ProbeScope = "bought_endpoint" | "other_endpoint" | "endpoint_not_recorded";
export const PROBE_SCOPE_TEXT: Record<ProbeScope, string> = {
  bought_endpoint: "The free probe failed on the same endpoint Lumi test-bought. That is newer than the last delivered test-buy, so the label is check_first until a probe or test-buy succeeds again.",
  other_endpoint: "The free probe failed on a different endpoint of this domain, not the one Lumi test-bought. It says nothing about the bought endpoint; the label rests on Lumi's paid test-buys.",
  endpoint_not_recorded: "This probe run did not record which endpoint it hit (older run). Lumi's paid test-buys of the bought endpoint delivered, so the label rests on them; the next probe run checks the bought endpoint first.",
};

/**
 * Where did a failed free probe land, relative to the endpoints Lumi test-bought with delivery? Only meaningful when the probe
 * failed and there is at least one delivered test-buy; otherwise null. Pure.
 */
export function probeScope(row: ProbeRow | null, boughtEndpoints: string[], deliveredTestBuys: number): ProbeScope | null {
  if (!row || row.outcome !== "fail" || deliveredTestBuys <= 0) return null;
  const probed = row.probed_endpoints ? (safeJson(row.probed_endpoints) as string[] | null) : null;
  if (!Array.isArray(probed) || !probed.length) return "endpoint_not_recorded";
  const bought = new Set(boughtEndpoints.map(normEndpoint).filter(Boolean));
  return probed.some((u) => bought.has(normEndpoint(u))) ? "bought_endpoint" : "other_endpoint";
}

export function probeRowPublic(row: ProbeRow | null, deliveredTestBuys: number, scope: ProbeScope | null = null) {
  if (!row) return null;
  const res: SellerProbeResult = { seller: row.seller, label: deliveredTestBuys > 0 ? "test-bought" : PROBE_LABEL, verified: false, score_weight: row.score_weight,
    checks: safeJson(row.checks) ?? {}, passed: 0, failed: 0, outcome: row.outcome, notes: safeJson(row.notes) ?? [], endpoints_checked: row.endpoints_checked,
    endpoints_quoting: row.endpoints_quoting, median_latency_ms: row.median_latency_ms, rules_version: row.rules_version };
  const probed = row.probed_endpoints ? safeJson(row.probed_endpoints) : null;
  return {
    ...probePublicView(res, row.checked_at),
    endpoints_probed: Array.isArray(probed) ? probed : null,
    ...(scope ? { failure_scope: scope, failure_scope_note: PROBE_SCOPE_TEXT[scope] } : {}),
  };
}

export class MemoryProbeStore implements ProbeStore {
  rows = new Map<string, ProbeRow>();
  async get(s: string) { return this.rows.get(s) ?? null; }
  async put(rows: ProbeRow[]) { let n = 0; for (const r of rows) { const p = this.rows.get(r.seller); if (!p || JSON.stringify(p) !== JSON.stringify(r)) { this.rows.set(r.seller, r); n++; } } return n; }
  async count() { return this.rows.size; }
}

export class D1ProbeStore implements ProbeStore {
  constructor(private db: D1Like) {}
  async get(s: string) {
    try { return (await this.db.prepare("SELECT * FROM probe_checked WHERE seller = ?1").bind(s).first<ProbeRow>()) ?? null; } catch { return null; } // table absent = no block
  }
  async put(rows: ProbeRow[]) {
    // Write only when something changed, or the stored row is older than 20 h (keeps daily writes ~= changed sellers).
    const stmts = rows.map((r) => this.db.prepare(
      `INSERT INTO probe_checked (seller, checked_at, outcome, checks, notes, endpoints_checked, endpoints_quoting, median_latency_ms, score_weight, rules_version, probed_endpoints)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(seller) DO UPDATE SET checked_at = excluded.checked_at, outcome = excluded.outcome, checks = excluded.checks, notes = excluded.notes,
         endpoints_checked = excluded.endpoints_checked, endpoints_quoting = excluded.endpoints_quoting, median_latency_ms = excluded.median_latency_ms,
         score_weight = excluded.score_weight, rules_version = excluded.rules_version, probed_endpoints = excluded.probed_endpoints
       WHERE probe_checked.outcome <> excluded.outcome OR probe_checked.checks <> excluded.checks OR probe_checked.notes <> excluded.notes
         OR COALESCE(probe_checked.probed_endpoints, '') <> COALESCE(excluded.probed_endpoints, '')
         OR probe_checked.checked_at < excluded.checked_at - 72000000`,
    ).bind(r.seller, r.checked_at, r.outcome, r.checks, r.notes, r.endpoints_checked, r.endpoints_quoting, r.median_latency_ms, r.score_weight, r.rules_version, r.probed_endpoints ?? null));
    let n = 0;
    for (let i = 0; i < stmts.length; i += 100) for (const x of (await this.db.batch(stmts.slice(i, i + 100))) as { meta?: { changes?: number } }[]) n += x.meta?.changes ?? 0;
    return n;
  }
  async count() { try { return Number((await this.db.prepare("SELECT COUNT(*) AS n FROM probe_checked").first<{ n: number }>())?.n ?? 0); } catch { return 0; } }
}
