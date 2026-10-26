/**
 * x402 catalog: the CDP Bazaar discovery list ingested into D1, free rotating 402-quote checks of every entry
 * (rotating slices every 30 minutes, fanned out over a Cloudflare Queue so each invocation stays within Workers Free limits), and
 * Lumi's on-chain-confirmed test-buys. Labels are neutral: "catalogued", "quote-checked, low confidence",
 * "test-bought". Nothing here rates a seller as good or bad.
 */
import type { D1Like } from "../config";
import { dataReturnedView, deliveryCounts, deliveryState, inconclusiveReason } from "./delivery";

export const DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
/**
 * CDP discovery page size. CDP accepts limit up to 1000 (checked 2026-10-26: a full limit=1000 pass returned 75,766 items,
 * 75,729 unique, of 75,799) and snaps the offset down to a multiple of the limit, so pages must stay limit-aligned
 * (a 50-item stride over 30-item pages once skipped 40% of the catalog). 200 keeps one D1 batch (listing upserts plus
 * payTo index rows) well under the per-invocation query limit.
 */
export const INGEST_PAGE = 200;
/**
 * A full CDP pass is spread over this many 30-minute cron runs (12 = one pass every 6 h). The old one-pass-a-day pace,
 * with the total frozen at the start of the pass, fell ~20k listings behind a fast-growing catalog (55.4k vs 75.5k).
 */
export const INGEST_PASS_RUNS = 12;
/** Catalog row source for listings that come from the CDP Bazaar ingest. Other free directories use "ext:<name>". */
export const CDP_SOURCE = "cdp_bazaar";
/** Free public x402 directories (owner-approved 2026-10-26) fed by the operator box job catalog_sources.py. */
export const EXTERNAL_SOURCES = ["ext:saylor", "ext:payai", "ext:thirdweb", "ext:402index", "ext:x402list", "ext:dexter"] as const;
export const PROBE_BATCH = 36;
export const RDAP_PER_BATCH = 3;
export const RUNS_PER_DAY = 46; // */30 cron = 48 runs; 46 leaves slack so every entry is checked within 24 h
const DAY = 86_400_000;
export const REFRESH_SEEN_MS = 6 * DAY;
/**
 * Bazaar quality fields (30-day calls, unique payers, last called) are re-stored at most this often per row, and only
 * on a material change (QUALITY_MIN_DELTA). Rolling 30-day counters move for nearly every listing every day, so
 * "any change" rewrote the whole catalog (~33k rows) daily on D1 Free. Small drifts ride along with the 6-day
 * last_seen refresh; the stored values are always dated (bazaar_quality.as_of = quality_at).
 */
export const QUALITY_REFRESH_MS = 20 * 3_600_000;
/** Material change: null <-> value, zero <-> non-zero, or a move of at least 25% and at least 3. */
export const QUALITY_MIN_DELTA = { ratio: 0.25, abs: 3 } as const;
const materialMove = (a: number | null | undefined, b: number | null | undefined) => {
  if ((a == null) !== (b == null)) return true;
  const x = a ?? 0, y = b ?? 0;
  if ((x === 0) !== (y === 0)) return true;
  const d = Math.abs(x - y);
  return d >= QUALITY_MIN_DELTA.abs && d >= QUALITY_MIN_DELTA.ratio * Math.max(x, 1);
};
export const qualityChanged = (r: { calls_30d: number | null; payers_30d: number | null; last_called_at?: number | null }, l: Listing) =>
  materialMove(r.calls_30d, l.calls_30d) || materialMove(r.payers_30d, l.payers_30d) || ((r.last_called_at ?? null) === null) !== (l.last_called_at === null);
/** SQL twin of materialMove for the upsert WHERE (o = stored column, n = excluded column). */
const sqlMove = (o: string, n: string) =>
  `((${o} IS NULL) <> (${n} IS NULL) OR (COALESCE(${o}, 0) = 0) <> (COALESCE(${n}, 0) = 0)` +
  ` OR (ABS(COALESCE(${n}, 0) - COALESCE(${o}, 0)) >= ${QUALITY_MIN_DELTA.abs} AND ABS(COALESCE(${n}, 0) - COALESCE(${o}, 0)) >= ${QUALITY_MIN_DELTA.ratio} * MAX(COALESCE(${o}, 0), 1)))`;
export const QUALITY_CHANGED_SQL =
  `(${sqlMove("catalog.calls_30d", "excluded.calls_30d")} OR ${sqlMove("catalog.payers_30d", "excluded.payers_30d")}` +
  ` OR (catalog.last_called_at IS NULL) <> (excluded.last_called_at IS NULL))`;
export const DELISTED_AFTER_MS = 10 * DAY;
const PROBE_TIMEOUT_MS = 10_000;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const LABELS = {
  catalogued: "catalogued, not yet checked",
  quote_verified: "quote-checked, low confidence",
  quote_failed: "quote-checked: no valid x402 quote at the last check",
  purchase_verified: "test-bought",
  self: "self, not scored",
} as const;

export const LABEL_NOTES = {
  "quote-checked, low confidence":
    "A free, unpaid request returned a readable x402 402 quote in the last 48 h. This shows the endpoint is up and asks for payment as listed; it says nothing about what a paid call returns.",
  "test-bought": "Lumi paid for one call from its own wallet; the payment is confirmed on-chain and the outcome (data returned or not) is recorded.",
  "catalogued, not yet checked": "Listed in the CDP x402 Bazaar; no quote check yet.",
};

// ---------------------------------------------------------------- listing parsing

export interface Listing {
  resource: string;
  domain: string;
  reg_domain: string | null;
  pay_tos: string[];
  method: string; // GET | POST | MCP
  body: string | null;
  networks: string[];
  price_usd: string | null;
  accepts: string;
  service_name: string | null;
  description: string | null;
  calls_30d: number | null;
  payers_30d: number | null;
  /** Bazaar quality.lastCalledAt (epoch ms). */
  last_called_at: number | null;
  sig: string;
}

export function normalizeUrl(u: string): string | null {
  try {
    const x = new URL(u.trim());
    if (x.protocol !== "https:" && x.protocol !== "http:") return null;
    x.hash = "";
    let s = `${x.protocol}//${x.host.toLowerCase()}${x.pathname}${x.search}`;
    if (s.endsWith("/") && x.pathname !== "/" && !x.search) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

export function normalizeDomain(d: string): string {
  let s = d.trim().toLowerCase();
  if (/^https?:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch { /* keep */ }
  }
  s = s.replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return s.startsWith("www.") ? s.slice(4) : s;
}

const MULTI_SUFFIX = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "com.br", "co.nz", "co.in", "com.cn", "com.sg", "co.za", "com.mx", "co.kr", "com.tr", "com.hk"]);
/** Shared hosting platforms: the registrable part belongs to the platform, so no domain-age check. */
const PLATFORM = /\.(workers\.dev|pages\.dev|vercel\.app|netlify\.app|onrender\.com|herokuapp\.com|railway\.app|fly\.dev|github\.io|replit\.app|replit\.dev|run\.app|azurewebsites\.net|amazonaws\.com|deno\.dev|trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io|up\.railway\.app|vercel\.sh|web\.app|firebaseapp\.com|lovable\.app|supabase\.co)$/;

export function registrableDomain(host: string): string | null {
  const h = normalizeDomain(host);
  if (!h || /^[\d.]+$/.test(h) || !h.includes(".")) return null;
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  if (MULTI_SUFFIX.has(last2)) return parts.length >= 3 ? parts.slice(-3).join(".") : null;
  if (PLATFORM.test("." + h)) {
    // e.g. foo.workers.dev: keep the tenant host as the grouping key
    return h;
  }
  return last2;
}

export function isPlatformHost(host: string) {
  return PLATFORM.test("." + normalizeDomain(host));
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** Circle USDC on Stellar mainnet (SEP-41 contract, 7 decimals). */
const STELLAR_USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

export function optUsd(a: any): number | null {
  const amt = a?.amount ?? a?.maxAmountRequired;
  if (amt == null) return null;
  const asset = String(a.asset ?? "");
  const net = String(a.network ?? "");
  if ((net === "eip155:8453" || net === "base") && asset.toLowerCase() === BASE_USDC) return Number(amt) / 1e6;
  if (net.startsWith("solana") && asset === SOLANA_USDC) return Number(amt) / 1e6;
  if (net === "stellar:pubnet" && asset === STELLAR_USDC_SAC) return Number(amt) / 1e7;
  return null;
}

const fmtUsd = (n: number) => String(Number(n.toFixed(6)));

export function toListing(item: any): Listing | null {
  const resource = typeof item?.resource === "string" ? normalizeUrl(item.resource) : null;
  if (!resource) return null;
  const accepts: any[] = Array.isArray(item.accepts) ? item.accepts : [];
  const host = new URL(resource).hostname;
  const input = item.extensions?.bazaar?.info?.input ?? {};
  const isMcp = item.type === "mcp" || input.type === "mcp";
  const method = isMcp ? "MCP" : String(input.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  let body: string | null = null;
  if (method === "POST" && input.body && typeof input.body === "object") body = JSON.stringify(input.body);
  else if (method === "GET" && input.queryParams && typeof input.queryParams === "object" && !new URL(resource).search) body = JSON.stringify({ query: input.queryParams });
  if (body && body.length > 2000) body = null;
  const base = accepts.find((a) => optUsd(a) != null && String(a.network).startsWith("eip155:8453")) ?? accepts.find((a) => optUsd(a) != null);
  const pay_tos = [...new Set(accepts.map((a) => String(a?.payTo ?? "").toLowerCase()).filter(Boolean))].slice(0, 8);
  const compact = accepts.slice(0, 6).map((a) => ({ n: a.network, a: a.asset, m: String(a.amount ?? a.maxAmountRequired ?? ""), p: a.payTo }));
  const desc = typeof item.description === "string" ? item.description.replace(/\s+/g, " ").trim().slice(0, 300) : null;
  const acceptsJson = JSON.stringify(compact);
  return {
    resource,
    domain: normalizeDomain(host),
    reg_domain: registrableDomain(host),
    pay_tos,
    method,
    body,
    networks: [...new Set(accepts.map((a) => String(a.network)))].slice(0, 10),
    price_usd: base ? fmtUsd(optUsd(base)!) : null,
    accepts: acceptsJson,
    service_name: typeof item.serviceName === "string" ? item.serviceName.slice(0, 100) : null,
    description: desc,
    calls_30d: Number.isFinite(item.quality?.l30DaysTotalCalls) ? item.quality.l30DaysTotalCalls : null,
    payers_30d: Number.isFinite(item.quality?.l30DaysUniquePayers) ? item.quality.l30DaysUniquePayers : null,
    last_called_at: typeof item.quality?.lastCalledAt === "string" && Number.isFinite(Date.parse(item.quality.lastCalledAt)) ? Date.parse(item.quality.lastCalledAt) : null,
    sig: fnv(`${acceptsJson}|${method}|${body ?? ""}|${desc ?? ""}|${item.serviceName ?? ""}`),
  };
}

// ---------------------------------------------------------------- rows

export interface CatalogRow {
  id: number;
  resource: string;
  domain: string;
  reg_domain: string | null;
  pay_tos: string | null;
  method: string;
  body: string | null;
  networks: string | null;
  price_usd: string | null;
  accepts: string | null;
  service_name: string | null;
  description: string | null;
  calls_30d: number | null;
  payers_30d: number | null;
  last_called_at?: number | null;
  /** When the Bazaar quality fields were last stored (null on rows not refreshed since the column was added). */
  quality_at?: number | null;
  source: string;
  first_seen: number;
  last_seen: number;
  probe_ts: number | null;
  probe_status: number | null;
  probe_valid: number | null;
  probe_pay_to_match: number | null;
  probe_price_usd: string | null;
  probe_price_match: number | null;
  probe_latency_ms: number | null;
  probe_error: string | null;
  probe_hist: string | null;
  probe_lat_hist: string | null;
}

export interface ProbeResult {
  id: number;
  ts: number;
  status: number | null;
  valid: boolean;
  pay_to_match: boolean | null;
  price_usd: string | null;
  price_match: boolean | null;
  latency_ms: number | null;
  error: string | null;
  hist: string;
  lat_hist: string;
}

export interface BuyRow {
  resource: string;
  domain: string;
  ts: number;
  network: string;
  tx_hash: string;
  amount: string;
  asset: string;
  pay_to: string;
  facilitator: string | null;
  http_status: number | null;
  data_returned: boolean;
  latency_ms: number | null;
  summary: string;
  /** Set when Lumi never saw an HTTP response (Lumi-side): delivery unknown, never "no data" (delivery.ts). */
  inconclusive?: string | null;
  corrected_at?: number | null;
  summary_before?: string | null;
}

export interface DomainRow {
  domain: string;
  registered_at: number | null;
  checked_at: number;
  error: string | null;
}

export interface CatalogStats {
  catalogued: number;
  active: number;
  quote_checked: number;
  quote_checked_24h: number;
  quote_verified: number;
  /** Bazaar catalog resources with a Lumi test-buy (all chains in catalog_buys). */
  purchase_verified: number;
  test_buys: number;
  /** Same two counts split by CAIP-2 network (e.g. eip155:8453 = Base USDC). */
  by_network?: Record<string, { purchase_verified: number; test_buys: number }>;
  domains: number;
  computed_at: number;
}

export interface LookupQuery {
  url?: string;
  domain?: string;
  payTo?: string;
}

export interface CatalogStore {
  /** Returns D1 rows written (index entries included), for the daily write budget. */
  /**
   * `source` defaults to the CDP Bazaar. A non-CDP source never overwrites a CDP row and never changes an existing
   * row's source; a CDP upsert takes over a row first seen in another directory.
   */
  upsert(rows: Listing[], now: number, source?: string): Promise<number>;
  maxId(): Promise<number>;
  range(afterId: number, limit: number): Promise<CatalogRow[]>;
  saveProbes(rows: ProbeResult[]): Promise<number>;
  lookup(q: LookupQuery, limit: number): Promise<{ total: number; rows: CatalogRow[] }>;
  byResource(resource: string): Promise<CatalogRow | null>;
  /** Batched exact-resource lookup (licence feed). */
  byResources(resources: string[]): Promise<CatalogRow[]>;
  /** Listings paying any of these payTos (lowercase), most used first (licence feed / audits). */
  byPayTos(payTosLc: string[], limit: number): Promise<CatalogRow[]>;
  buysFor(resources: string[]): Promise<BuyRow[]>;
  /** Badge read path (read-only, catalog_buys_domain index): the newest `limit` test-buys on this exact host. */
  buysByDomain(domain: string, limit: number): Promise<BuyRow[]>;
  addBuy(row: BuyRow): Promise<"inserted" | "duplicate">;
  /** Owner correction: mark a stored buy inconclusive (Lumi-side). Keeps the old summary in summary_before. */
  markInconclusive(tx: string, reason: string, summary: string, at: number): Promise<BuyRow | null>;
  boughtResources(): Promise<string[]>;
  popular(maxUsd: number, limit: number, network: string): Promise<CatalogRow[]>;
  /** Most-used listings first (Bazaar 30-day calls), for the free teaser browse. */
  top(offset: number, limit: number): Promise<CatalogRow[]>;
  saveDomain(row: DomainRow): Promise<void>;
  domainInfo(domains: string[]): Promise<DomainRow[]>;
  computeStats(now: number): Promise<CatalogStats>;
  getMeta(k: string): Promise<string | null>;
  /** Atomically add n to an integer meta counter; returns the new value. */
  addCounter(k: string, n: number): Promise<number>;
  setMeta(k: string, v: string): Promise<void>;
}

function rowFromListing(l: Listing, id: number, now: number, source = CDP_SOURCE): CatalogRow {
  return {
    id, resource: l.resource, domain: l.domain, reg_domain: l.reg_domain, pay_tos: l.pay_tos.join(","), method: l.method, body: l.body,
    networks: l.networks.join(","), price_usd: l.price_usd, accepts: l.accepts, service_name: l.service_name, description: l.description,
    calls_30d: l.calls_30d, payers_30d: l.payers_30d, last_called_at: l.last_called_at, quality_at: now, source, first_seen: now, last_seen: now,
    probe_ts: null, probe_status: null, probe_valid: null, probe_pay_to_match: null, probe_price_usd: null, probe_price_match: null,
    probe_latency_ms: null, probe_error: null, probe_hist: null, probe_lat_hist: null,
  };
}

export class MemoryCatalogStore implements CatalogStore {
  rows: (CatalogRow & { sig?: string })[] = [];
  buys: BuyRow[] = [];
  domains = new Map<string, DomainRow>();
  meta = new Map<string, string>();
  writes = 0;
  async upsert(ls: Listing[], now: number, source = CDP_SOURCE) {
    const before = this.writes;
    const cdp = source === CDP_SOURCE;
    for (const l of ls) {
      const ex = this.rows.find((r) => r.resource === l.resource);
      if (!ex) { this.rows.push({ ...rowFromListing(l, this.rows.length + 1, now, source), sig: l.sig }); this.writes++; continue; }
      if (!cdp && ex.source === CDP_SOURCE) continue;
      if ((cdp && ex.source !== CDP_SOURCE) || ex.sig !== l.sig || ex.last_seen < now - REFRESH_SEEN_MS || ((ex.quality_at ?? 0) < now - QUALITY_REFRESH_MS && qualityChanged(ex, l))) {
        const keep = { id: ex.id, first_seen: ex.first_seen };
        const probe = Object.fromEntries(Object.entries(ex).filter(([k]) => k.startsWith("probe_")));
        Object.assign(ex, rowFromListing(l, keep.id, now, cdp ? CDP_SOURCE : ex.source), probe, keep, { sig: l.sig });
        this.writes++;
      }
    }
    return this.writes - before;
  }
  async maxId() { return this.rows.length ? Math.max(...this.rows.map((r) => r.id)) : 0; }
  async range(after: number, limit: number) { return this.rows.filter((r) => r.id > after && r.id <= after + limit); }
  async saveProbes(ps: ProbeResult[]) {
    let n = 0;
    for (const p of ps) {
      const r = this.rows.find((x) => x.id === p.id);
      if (!r) continue;
      Object.assign(r, {
        probe_ts: p.ts, probe_status: p.status, probe_valid: p.valid ? 1 : 0, probe_pay_to_match: p.pay_to_match == null ? null : p.pay_to_match ? 1 : 0,
        probe_price_usd: p.price_usd, probe_price_match: p.price_match == null ? null : p.price_match ? 1 : 0, probe_latency_ms: p.latency_ms,
        probe_error: p.error, probe_hist: p.hist, probe_lat_hist: p.lat_hist,
      });
      n++;
    }
    return n;
  }
  private match(q: LookupQuery) {
    const urls = q.url ? urlVariants(q.url) : [];
    const d = q.domain ? normalizeDomain(q.domain) : null;
    const reg = d ? registrableDomain(d) ?? d : null;
    const pt = q.payTo?.trim().toLowerCase();
    return this.rows.filter((r) =>
      (urls.length && urls.includes(r.resource)) || (d && r.reg_domain === reg && (r.reg_domain === d || r.domain === d)) || (pt && (r.pay_tos ?? "").split(",").includes(pt)));
  }
  async lookup(q: LookupQuery, limit: number) {
    const m = this.match(q).sort((a, b) => (b.calls_30d ?? 0) - (a.calls_30d ?? 0));
    return { total: m.length, rows: m.slice(0, limit) };
  }
  async byResource(resource: string) { return this.rows.find((r) => r.resource === resource) ?? null; }
  async byResources(rs: string[]) { return this.rows.filter((r) => rs.includes(r.resource)); }
  async byPayTos(ps: string[], limit: number) {
    return this.rows.filter((r) => (r.pay_tos ?? "").split(",").some((p) => ps.includes(p.toLowerCase()))).sort((a, b) => (b.calls_30d ?? 0) - (a.calls_30d ?? 0)).slice(0, limit);
  }
  async buysFor(resources: string[]) { return this.buys.filter((b) => resources.includes(b.resource)).sort((a, b) => b.ts - a.ts); }
  async buysByDomain(domain: string, limit: number) { return this.buys.filter((b) => b.domain === domain).sort((a, b) => b.ts - a.ts).slice(0, limit).map((b) => ({ ...b })); }
  async addBuy(row: BuyRow) {
    if (this.buys.some((b) => b.tx_hash === row.tx_hash)) return "duplicate" as const;
    this.buys.push({ ...row });
    return "inserted" as const;
  }
  async markInconclusive(tx: string, reason: string, summary: string, at: number) {
    const b = this.buys.find((x) => x.tx_hash === tx);
    if (!b) return null;
    if (b.summary_before == null) b.summary_before = b.summary;
    Object.assign(b, { inconclusive: reason, summary, corrected_at: at, data_returned: false });
    return { ...b };
  }
  async boughtResources() { return [...new Set(this.buys.map((b) => b.resource))]; }
  async top(offset: number, limit: number) {
    return [...this.rows].sort((a, b) => (b.calls_30d ?? 0) - (a.calls_30d ?? 0) || a.id - b.id).slice(offset, offset + limit);
  }
  async popular(maxUsd: number, limit: number, network: string) {
    return this.rows
      .filter((r) => r.price_usd != null && Number(r.price_usd) > 0 && Number(r.price_usd) <= maxUsd && (r.networks ?? "").split(",").includes(network) && r.method !== "MCP")
      .sort((a, b) => (b.calls_30d ?? 0) - (a.calls_30d ?? 0))
      .slice(0, limit);
  }
  async saveDomain(row: DomainRow) { const p = this.domains.get(row.domain); this.domains.set(row.domain, { ...row, registered_at: row.registered_at ?? p?.registered_at ?? null }); } // a failed lookup never erases a known date
  async domainInfo(ds: string[]) { return ds.map((d) => this.domains.get(d)).filter((x): x is DomainRow => !!x); }
  async computeStats(now: number): Promise<CatalogStats> {
    const r = this.rows;
    return {
      catalogued: r.length,
      active: r.filter((x) => x.last_seen > now - DELISTED_AFTER_MS).length,
      quote_checked: r.filter((x) => x.probe_ts != null).length,
      quote_checked_24h: r.filter((x) => (x.probe_ts ?? 0) > now - DAY).length,
      quote_verified: r.filter((x) => x.probe_valid === 1 && (x.probe_ts ?? 0) > now - 2 * DAY).length,
      by_network: Object.fromEntries([...new Set(this.buys.map((b) => b.network))].map((n) => { const bs = this.buys.filter((b) => b.network === n); return [n, { purchase_verified: new Set(bs.map((b) => b.resource)).size, test_buys: bs.length }]; })),
      purchase_verified: new Set(this.buys.map((b) => b.resource)).size,
      test_buys: this.buys.length,
      domains: new Set(r.map((x) => x.domain)).size,
      computed_at: now,
    };
  }
  async getMeta(k: string) { return this.meta.get(k) ?? null; }
  async addCounter(k: string, n: number) { const v = Number(this.meta.get(k) ?? "0") + n; this.meta.set(k, String(v)); return v; }
  async setMeta(k: string, v: string) { this.meta.set(k, v); }
}

export function urlVariants(u: string): string[] {
  const n = normalizeUrl(u);
  if (!n) return [];
  const out = new Set([n]);
  if (!n.includes("?")) out.add(n.endsWith("/") ? n.slice(0, -1) : n + "/");
  return [...out];
}

function rowsWritten(res: unknown, fallback: number): number {
  if (!Array.isArray(res)) return fallback;
  let n = 0;
  let seen = false;
  for (const r of res as any[]) {
    const w = r?.meta?.rows_written ?? r?.meta?.changes;
    if (typeof w === "number") { n += w; seen = true; }
  }
  return seen ? n : fallback;
}

const CAT_COLS =
  "id, resource, domain, reg_domain, pay_tos, method, body, networks, price_usd, accepts, service_name, description, calls_30d, payers_30d, last_called_at, quality_at, source, first_seen, last_seen, " +
  "probe_ts, probe_status, probe_valid, probe_pay_to_match, probe_price_usd, probe_price_match, probe_latency_ms, probe_error, probe_hist, probe_lat_hist";

export class D1CatalogStore implements CatalogStore {
  constructor(private db: D1Like) {}
  async upsert(ls: Listing[], now: number, source = CDP_SOURCE) {
    if (!ls.length) return 0;
    const cdp = source === CDP_SOURCE;
    const stmts = [];
    for (const l of ls) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO catalog (resource, domain, reg_domain, pay_tos, method, body, networks, price_usd, accepts, service_name, description, calls_30d, payers_30d, source, sig, first_seen, last_seen, last_called_at, quality_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?19, ?14, ?15, ?15, ?18, ?15)
             ON CONFLICT(resource) DO UPDATE SET pay_tos = excluded.pay_tos, method = excluded.method,
               body = excluded.body, networks = excluded.networks, price_usd = excluded.price_usd, accepts = excluded.accepts, service_name = excluded.service_name,
               description = excluded.description, calls_30d = excluded.calls_30d, payers_30d = excluded.payers_30d, sig = excluded.sig, last_seen = excluded.last_seen,
               last_called_at = excluded.last_called_at, quality_at = excluded.quality_at${cdp ? ", source = excluded.source" : ""}
             WHERE ${cdp ? "catalog.source IS NOT excluded.source OR " : "catalog.source <> '" + CDP_SOURCE + "' AND ("}catalog.sig IS NOT excluded.sig OR catalog.last_seen < ?16
               OR ((catalog.quality_at IS NULL OR catalog.quality_at < ?17) AND ${QUALITY_CHANGED_SQL})${cdp ? "" : ")"}`,
          )
          .bind(l.resource, l.domain, l.reg_domain, l.pay_tos.join(","), l.method, l.body, l.networks.join(","), l.price_usd, l.accepts, l.service_name, l.description, l.calls_30d, l.payers_30d, l.sig, now, now - REFRESH_SEEN_MS, now - QUALITY_REFRESH_MS, l.last_called_at, source),
      );
      for (const p of l.pay_tos)
        stmts.push(
          cdp
            ? this.db.prepare("INSERT OR IGNORE INTO catalog_payto (pay_to_lc, resource) VALUES (?1, ?2)").bind(p, l.resource)
            // another directory's payTo is never indexed against a CDP listing
            : this.db.prepare(`INSERT OR IGNORE INTO catalog_payto (pay_to_lc, resource) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE resource = ?2 AND source = '${CDP_SOURCE}')`).bind(p, l.resource),
        );
    }
    return rowsWritten(await this.db.batch(stmts), stmts.length);
  }
  async maxId() {
    const r = await this.db.prepare("SELECT MAX(id) AS m FROM catalog").first<{ m: number | null }>();
    return r?.m ?? 0;
  }
  async range(after: number, limit: number) {
    return (await this.db.prepare(`SELECT ${CAT_COLS} FROM catalog WHERE id > ?1 AND id <= ?2`).bind(after, after + limit).all<CatalogRow>()).results;
  }
  async saveProbes(ps: ProbeResult[]) {
    if (!ps.length) return 0;
    const res = await this.db.batch(
      ps.map((p) =>
        this.db
          .prepare(
            `UPDATE catalog SET probe_ts = ?2, probe_status = ?3, probe_valid = ?4, probe_pay_to_match = ?5, probe_price_usd = ?6, probe_price_match = ?7,
               probe_latency_ms = ?8, probe_error = ?9, probe_hist = ?10, probe_lat_hist = ?11 WHERE id = ?1`,
          )
          .bind(p.id, p.ts, p.status, p.valid ? 1 : 0, p.pay_to_match == null ? null : p.pay_to_match ? 1 : 0, p.price_usd, p.price_match == null ? null : p.price_match ? 1 : 0, p.latency_ms, p.error, p.hist, p.lat_hist),
      ),
    );
    return rowsWritten(res, ps.length);
  }
  async lookup(q: LookupQuery, limit: number) {
    const where: string[] = [];
    const args: unknown[] = [];
    const urls = q.url ? urlVariants(q.url) : [];
    for (const u of urls) { args.push(u); where.push(`resource = ?${args.length}`); }
    if (q.domain) {
      const d = normalizeDomain(q.domain);
      const reg = registrableDomain(d) ?? d;
      args.push(reg, d);
      // uses the reg_domain index; a host lookup matches that host, a registrable-domain lookup matches all its hosts
      where.push(`(reg_domain = ?${args.length - 1} AND (reg_domain = ?${args.length} OR domain = ?${args.length}))`);
    }
    if (q.payTo) {
      args.push(q.payTo.trim().toLowerCase());
      where.push(`resource IN (SELECT resource FROM catalog_payto WHERE pay_to_lc = ?${args.length})`);
    }
    if (!where.length) return { total: 0, rows: [] };
    const w = where.join(" OR ");
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM catalog WHERE ${w} LIMIT 10001)`).bind(...args).first<{ n: number }>())?.n ?? 0;
    const rows = (await this.db.prepare(`SELECT ${CAT_COLS} FROM catalog WHERE ${w} ORDER BY calls_30d DESC NULLS LAST, id LIMIT ${Math.max(1, Math.min(100, limit))}`).bind(...args).all<CatalogRow>()).results;
    return { total, rows };
  }
  async byResource(resource: string) {
    return this.db.prepare(`SELECT ${CAT_COLS} FROM catalog WHERE resource = ?1`).bind(resource).first<CatalogRow>();
  }
  async byResources(rs: string[]) {
    const l = [...new Set(rs)].slice(0, 90);
    if (!l.length) return [];
    return (await this.db.prepare(`SELECT ${CAT_COLS} FROM catalog WHERE resource IN (${l.map((_, i) => `?${i + 1}`).join(",")})`).bind(...l).all<CatalogRow>()).results;
  }
  async byPayTos(ps: string[], limit: number) {
    const l = [...new Set(ps)].slice(0, 50);
    if (!l.length) return [];
    return (await this.db
      .prepare(`SELECT ${CAT_COLS} FROM catalog WHERE resource IN (SELECT resource FROM catalog_payto WHERE pay_to_lc IN (${l.map((_, i) => `?${i + 1}`).join(",")})) ORDER BY calls_30d DESC NULLS LAST, id LIMIT ${Math.max(1, Math.min(200, limit))}`)
      .bind(...l).all<CatalogRow>()).results;
  }
  async buysFor(resources: string[]) {
    if (!resources.length) return [];
    const ph = resources.map((_, i) => `?${i + 1}`).join(",");
    const rows = (await this.db.prepare(`SELECT * FROM catalog_buys WHERE resource IN (${ph}) ORDER BY ts DESC LIMIT 200`).bind(...resources).all<any>()).results;
    return rows.map((r) => ({ ...r, data_returned: !!r.data_returned })) as BuyRow[];
  }
  async buysByDomain(domain: string, limit: number) {
    const rows = (await this.db
      .prepare(`SELECT resource, domain, ts, network, tx_hash, amount, asset, pay_to, facilitator, http_status, data_returned, latency_ms, summary, inconclusive, corrected_at FROM catalog_buys WHERE domain = ?1 ORDER BY ts DESC LIMIT ${Math.max(1, Math.min(50, limit))}`)
      .bind(domain).all<any>()).results;
    return rows.map((r) => ({ ...r, data_returned: !!r.data_returned })) as BuyRow[];
  }
  async addBuy(b: BuyRow) {
    const r: any = await this.db
      .prepare(
        `INSERT OR IGNORE INTO catalog_buys (resource, domain, ts, network, tx_hash, amount, asset, pay_to, facilitator, http_status, data_returned, latency_ms, summary, inconclusive)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(b.resource, b.domain, b.ts, b.network, b.tx_hash, b.amount, b.asset, b.pay_to, b.facilitator, b.http_status, b.data_returned ? 1 : 0, b.latency_ms, b.summary, b.inconclusive ?? null)
      .run();
    return (r?.meta?.changes ?? 1) > 0 ? "inserted" : "duplicate";
  }
  async markInconclusive(tx: string, reason: string, summary: string, at: number) {
    await this.db
      .prepare("UPDATE catalog_buys SET summary_before = COALESCE(summary_before, summary), inconclusive = ?2, summary = ?3, corrected_at = ?4, data_returned = 0 WHERE tx_hash = ?1")
      .bind(tx, reason, summary, at).run();
    const r = await this.db.prepare("SELECT * FROM catalog_buys WHERE tx_hash = ?1").bind(tx).first<any>();
    return r ? ({ ...r, data_returned: !!r.data_returned } as BuyRow) : null;
  }
  async boughtResources() {
    return (await this.db.prepare("SELECT DISTINCT resource FROM catalog_buys").all<{ resource: string }>()).results.map((r) => r.resource);
  }
  async top(offset: number, limit: number) {
    return (
      await this.db.prepare(`SELECT ${CAT_COLS} FROM catalog ORDER BY calls_30d DESC NULLS LAST, id ASC LIMIT ?1 OFFSET ?2`).bind(limit, offset).all<CatalogRow>()
    ).results;
  }
  async popular(maxUsd: number, limit: number, network: string) {
    return (
      await this.db
        .prepare(
          `SELECT ${CAT_COLS} FROM catalog WHERE price_usd IS NOT NULL AND CAST(price_usd AS REAL) > 0 AND CAST(price_usd AS REAL) <= ?1
             AND (',' || networks || ',') LIKE ?2 AND method != 'MCP' ORDER BY calls_30d DESC NULLS LAST LIMIT ?3`,
        )
        .bind(maxUsd, `%,${network},%`, limit)
        .all<CatalogRow>()
    ).results;
  }
  async saveDomain(r: DomainRow) {
    await this.db
      .prepare("INSERT INTO domains (domain, registered_at, checked_at, error) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(domain) DO UPDATE SET registered_at = COALESCE(excluded.registered_at, domains.registered_at), checked_at = excluded.checked_at, error = excluded.error")
      .bind(r.domain, r.registered_at, r.checked_at, r.error)
      .run();
  }
  async domainInfo(ds: string[]) {
    if (!ds.length) return [];
    const ph = ds.map((_, i) => `?${i + 1}`).join(",");
    return (await this.db.prepare(`SELECT * FROM domains WHERE domain IN (${ph})`).bind(...ds).all<DomainRow>()).results;
  }
  async computeStats(now: number): Promise<CatalogStats> {
    const a = await this.db
      .prepare(
        `SELECT COUNT(*) AS catalogued, SUM(last_seen > ?1) AS active, SUM(probe_ts IS NOT NULL) AS quote_checked, SUM(probe_ts > ?2) AS quote_checked_24h,
           SUM(probe_valid = 1 AND probe_ts > ?3) AS quote_verified, COUNT(DISTINCT domain) AS domains FROM catalog`,
      )
      .bind(now - DELISTED_AFTER_MS, now - DAY, now - 2 * DAY)
      .first<any>();
    const b = await this.db.prepare("SELECT COUNT(DISTINCT resource) AS pv, COUNT(*) AS n FROM catalog_buys").first<any>();
    const bn = (await this.db.prepare("SELECT network, COUNT(DISTINCT resource) AS pv, COUNT(*) AS n FROM catalog_buys GROUP BY network").all<any>()).results ?? [];
    return {
      by_network: Object.fromEntries(bn.map((x: any) => [String(x.network), { purchase_verified: Number(x.pv ?? 0), test_buys: Number(x.n ?? 0) }])),
      catalogued: a?.catalogued ?? 0, active: a?.active ?? 0, quote_checked: a?.quote_checked ?? 0, quote_checked_24h: a?.quote_checked_24h ?? 0,
      quote_verified: a?.quote_verified ?? 0, purchase_verified: b?.pv ?? 0, test_buys: b?.n ?? 0, domains: a?.domains ?? 0, computed_at: now,
    };
  }
  async addCounter(k: string, n: number) {
    const r = await this.db
      .prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + ?3 AS TEXT) RETURNING v")
      .bind(k, String(n), n)
      .first<{ v: string }>();
    return Number(r?.v ?? n);
  }
  async getMeta(k: string) {
    return (await this.db.prepare("SELECT v FROM meta WHERE k = ?1").bind(k).first<{ v: string }>())?.v ?? null;
  }
  async setMeta(k: string, v: string) {
    await this.db.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();
  }
}

// ---------------------------------------------------------------- probing (free, unpaid)

function decodeB64Json(h: string): any {
  const bin = atob(h.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

export async function probeRow(f: typeof fetch, row: CatalogRow, now: number): Promise<ProbeResult> {
  const t0 = Date.now();
  const res: ProbeResult = {
    id: row.id, ts: now, status: null, valid: false, pay_to_match: null, price_usd: null, price_match: null, latency_ms: null, error: null,
    hist: row.probe_hist ?? "", lat_hist: row.probe_lat_hist ?? "",
  };
  try {
    let url = row.resource;
    let body: string | undefined;
    if (row.body) {
      const b = JSON.parse(row.body);
      if (row.method === "GET" && b?.query && typeof b.query === "object") {
        const u = new URL(url);
        for (const [k, v] of Object.entries(b.query)) if (v != null && typeof v !== "object") u.searchParams.set(k, String(v));
        url = u.toString();
      } else if (row.method === "POST") body = row.body;
    }
    const r = await f(url, {
      method: row.method === "POST" ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "LumiTrustProbe/0.9 (+https://api.lumitrades.io/v1/trust/methodology; unpaid quote check)",
        ...(row.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: row.method === "POST" ? body ?? "{}" : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    res.latency_ms = Date.now() - t0;
    res.status = r.status;
    let pr: any = null;
    const h = r.headers.get("PAYMENT-REQUIRED");
    if (r.status === 402) {
      try {
        if (h) pr = decodeB64Json(h);
        else {
          const len = Number(r.headers.get("content-length") ?? "0");
          if (len <= 65_536 && /json/i.test(r.headers.get("content-type") ?? "")) pr = JSON.parse(await r.text());
        }
      } catch { /* unreadable */ }
    }
    if (!r.bodyUsed) await r.body?.cancel().catch(() => {});
    if (r.status !== 402) res.error = `answered HTTP ${r.status} instead of a 402 quote`;
    else if (!pr || !Array.isArray(pr.accepts) || !pr.accepts.length) res.error = "402 without a readable x402 quote";
    else {
      res.valid = true;
      const listed = (row.pay_tos ?? "").split(",").filter(Boolean);
      // Some directories (402 Index, x402-list) list a URL without a payTo: nothing to compare, so no signal either way.
      res.pay_to_match = listed.length ? pr.accepts.some((a: any) => listed.includes(String(a?.payTo ?? "").toLowerCase())) : null;
      const usd = pr.accepts.map(optUsd).find((x: number | null) => x != null);
      if (usd != null) {
        res.price_usd = fmtUsd(usd);
        res.price_match = row.price_usd != null ? Math.abs(Number(row.price_usd) - usd) < 1e-9 : null;
      }
      if (res.pay_to_match === false) res.error = "quote pays an address not in the listing";
    }
  } catch (e) {
    res.latency_ms = Date.now() - t0;
    res.error = /timeout|abort/i.test(String(e)) ? "no answer within 10 s" : "network error";
  }
  res.hist = ((res.valid ? "1" : "0") + res.hist).slice(0, 30);
  if (res.valid && res.latency_ms != null) res.lat_hist = [res.latency_ms, ...res.lat_hist.split(",").filter(Boolean)].slice(0, 7).join(",");
  return res;
}

export async function rdapRegistered(f: typeof fetch, domain: string): Promise<{ registered_at: number | null; error: string | null }> {
  try {
    const r = await f(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { Accept: "application/rdap+json, application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { registered_at: null, error: `rdap HTTP ${r.status}` }; }
    const j: any = await r.json();
    const ev = (j.events ?? []).find((e: any) => e.eventAction === "registration");
    const t = ev ? Date.parse(ev.eventDate) : NaN;
    return Number.isFinite(t) ? { registered_at: t, error: null } : { registered_at: null, error: "no registration date in RDAP" };
  } catch {
    return { registered_at: null, error: "rdap unavailable" };
  }
}

// ---------------------------------------------------------------- views

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const iso = (t: number | null | undefined) => (t == null ? null : new Date(t).toISOString());

export const BAZAAR_QUALITY_SOURCE = "Coinbase CDP x402 Bazaar (discovery quality fields)";
/** Coinbase Bazaar's own usage counters for the listing, attributed and dated. Not Lumi's measurement; not purchase evidence. */
export function bazaarQuality(row: CatalogRow) {
  if (row.calls_30d == null && row.payers_30d == null && row.last_called_at == null) return null;
  return {
    source: BAZAAR_QUALITY_SOURCE,
    calls_30d: row.calls_30d,
    unique_payers_30d: row.payers_30d,
    last_called_at: iso(row.last_called_at ?? null),
    as_of: iso(row.quality_at ?? row.last_seen),
  };
}

export function tierOf(row: CatalogRow, buys: BuyRow[], now: number): string {
  if (buys.length) return LABELS.purchase_verified;
  if (row.probe_ts == null) return LABELS.catalogued;
  if (row.probe_valid === 1 && row.probe_ts > now - 2 * DAY) return LABELS.quote_verified;
  return LABELS.quote_failed;
}

export function explorerFor(network: string, tx: string) {
  if (network === "xrpl:0") return `https://livenet.xrpl.org/transactions/${tx}`;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  if (network === "stellar:pubnet") return `https://stellar.expert/explorer/public/tx/${tx}`;
  return null;
}

export function catalogView(row: CatalogRow, buys: BuyRow[], dom: DomainRow | undefined, now: number) {
  const hist = row.probe_hist ?? "";
  const lat = (row.probe_lat_hist ?? "").split(",").filter(Boolean).map(Number);
  let accepts: any[] = [];
  try { accepts = JSON.parse(row.accepts ?? "[]"); } catch { /* ignore */ }
  return {
    resource: row.resource,
    domain: row.domain,
    service_name: row.service_name,
    description: row.description,
    method: row.method,
    listed_price_usd: row.price_usd,
    networks: (row.networks ?? "").split(",").filter(Boolean),
    // One entry per (network, address): Bazaar listings repeat payTo once per accepted asset/scheme.
    pay_to: [...new Map(accepts.filter((a) => a.p).map((a) => [`${a.n}|${String(a.p).toLowerCase()}`, { network: a.n, pay_to: a.p }])).values()],
    source: "CDP x402 Bazaar discovery",
    bazaar_calls_30d: row.calls_30d,
    bazaar_quality: bazaarQuality(row),
    tier: tierOf(row, buys, now),
    quote_checks: row.probe_ts == null
      ? null
      : {
          last_checked_at: iso(row.probe_ts),
          last_http_status: row.probe_status,
          last_valid_quote: row.probe_valid === 1,
          last_quote_pays_listed_address: row.probe_pay_to_match == null ? null : row.probe_pay_to_match === 1,
          last_quoted_price_usd: row.probe_price_usd,
          last_price_matches_listing: row.probe_price_match == null ? null : row.probe_price_match === 1,
          last_latency_ms: row.probe_latency_ms,
          last_note: row.probe_error,
          checks_recorded: hist.length,
          valid_quote_rate: hist.length ? Number((hist.split("").filter((c) => c === "1").length / hist.length).toFixed(3)) : null,
          median_latency_ms: median(lat),
        },
    domain_age: dom
      ? { registrable_domain: dom.domain, registered_at: iso(dom.registered_at), age_days: dom.registered_at ? Math.floor((now - dom.registered_at) / DAY) : null, note: dom.registered_at ? null : "domain age unavailable" }
      : row.reg_domain ? { registrable_domain: row.reg_domain, registered_at: null, age_days: null, note: "domain age unavailable" } : null,
    purchases: buys.length
      ? buys.slice(0, 5).map((b) => ({
          at: iso(b.ts), network: b.network, tx_hash: b.tx_hash, explorer: explorerFor(b.network, b.tx_hash), amount: b.amount, asset: b.asset,
          facilitator: b.facilitator, http_status: b.http_status, data_returned: dataReturnedView(b), delivery: deliveryState(b),
          ...(inconclusiveReason(b) ? { inconclusive_reason: inconclusiveReason(b) } : {}),
          latency_ms: b.latency_ms, summary: b.summary,
          ...(b.corrected_at ? { corrected_at: iso(b.corrected_at), corrections: "https://api.lumitrades.io/v1/monitor/corrections" } : {}),
        }))
      : [],
    listed_until: row.last_seen < now - DELISTED_AFTER_MS ? iso(row.last_seen) : null,
  };
}

/**
 * Free, answer-only view of one catalog entry: tier and the yes/no outcome of the latest checks. No tx hashes, receipts,
 * check history or latency series: that evidence is in the paid /v1/trust/check ($0.02) and vendor report ($0.02).
 */
export function catalogFreeView(row: CatalogRow, buys: BuyRow[], now: number) {
  let accepts: any[] = [];
  try { accepts = JSON.parse(row.accepts ?? "[]"); } catch { /* ignore */ }
  const last = buys[0];
  return {
    resource: row.resource,
    domain: row.domain,
    service_name: row.service_name,
    method: row.method,
    listed_price_usd: row.price_usd,
    networks: (row.networks ?? "").split(",").filter(Boolean),
    pay_to: [...new Map(accepts.filter((a) => a.p).map((a) => [`${a.n}|${String(a.p).toLowerCase()}`, { network: a.n, pay_to: a.p }])).values()],
    tier: tierOf(row, buys, now),
    bazaar_quality: bazaarQuality(row),
    last_quote_check: row.probe_ts == null
      ? null
      : {
          at: iso(row.probe_ts),
          valid_quote: row.probe_valid === 1,
          pays_listed_address: row.probe_pay_to_match == null ? null : row.probe_pay_to_match === 1,
          price_matches_listing: row.probe_price_match == null ? null : row.probe_price_match === 1,
        },
    test_buys: buys.length
      ? { count: buys.length, last_at: iso(last.ts), last_data_returned: dataReturnedView(last), last_delivery: deliveryState(last), ...deliveryCounts(buys) }
      : { count: 0 },
    listed_until: row.last_seen < now - DELISTED_AFTER_MS ? iso(row.last_seen) : null,
  };
}
