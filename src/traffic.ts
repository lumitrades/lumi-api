/**
 * Private request log for the owner (GET /v1/owner/traffic): path, status, UA class, Referer host, country and a
 * daily-rotating keyed IP hash. Raw IPs, query strings, Authorization and other headers are never stored.
 * Logging is best-effort (waitUntil) and never affects a response. Requests are aggregated in memory per isolate and
 * written as one batch row per flush (TrafficBuffer), not one row per request (D1 write budget).
 */
import type { D1Like } from "./config";

export interface TrafficRow {
  ts: number;
  day: string;
  method: string;
  path: string;
  status: number;
  ua: string | null;
  ua_class: string;
  ref_host: string | null;
  ip_hash: string | null;
  country: string | null;
  is_402: boolean;
  paid: boolean;
  /** Paid by one of Lumi's own wallets (sales is_test); set by the app from the recorded sale, absent on legacy rows. */
  paid_test?: boolean;
  /** Set when the request carried a payment header and was refused (see payFailFrom). */
  pay_fail?: PayFail;
}

/**
 * One refused payment attempt (request carried PAYMENT-SIGNATURE or X-PAYMENT, response >= 400). Built from the request
 * path, the refusal body's error code and the payment header's x402Version / scheme / network only. Never the payer
 * address, signature, authorization, tx blob or any other payload field; addresses inside reason strings are masked.
 */
export interface PayFail {
  ts: number;
  route: string;
  status: number;
  reason: string;
  network: string;
  scheme: string;
  x402_version: number | null;
  ua_family: string;
}

/** One flushed aggregate: every request counted in one isolate during one flush window (single UTC day). */
export interface TrafficBatch {
  day: string;
  from: number;
  to: number;
  requests: number;
  r402: number;
  paid: number;
  /** Of `paid`, calls paid by Lumi's own test wallets (absent on batches written before Oct 25 2026). */
  paid_test?: number;
  browser: number;
  /** path -> [requests, 402s, paid] */
  paths: Record<string, [number, number, number]>;
  status: Record<string, number>;
  clients: Record<string, number>;
  /** "ua_class: ua" -> requests */
  uas: Record<string, number>;
  refs: Record<string, number>;
  countries: Record<string, number>;
  /** distinct daily-rotating IP hashes seen in this batch (never raw IPs) */
  ips: string[];
  /** Refused payment attempts in this batch (capped at PAY_FAIL_BATCH_MAX; overflow counted in pay_fails_dropped). */
  pay_fails?: PayFail[];
  pay_fails_dropped?: number;
}

export interface TrafficStore {
  /** Write one aggregate batch (1 D1 row). */
  addBatch(b: TrafficBatch): Promise<void>;
  /** Batches flushed at or after tsMs. */
  batches(tsMs: number): Promise<TrafficBatch[]>;
  /** Legacy raw rows (written before the Oct 23 2026 aggregation change; read until they age out). */
  since(tsMs: number, limit: number): Promise<TrafficRow[]>;
  prune(beforeMs: number): Promise<void>;
}

export const TRAFFIC_RETENTION_DAYS = 90;

/** Rough client class from the User-Agent. */
export function uaClass(ua: string | null | undefined): string {
  const u = (ua ?? "").toLowerCase();
  if (!u) return "other";
  if (/gptbot|chatgpt|oai-searchbot|claude|anthropic|perplexity|bytespider|ccbot|cohere|google-extended|meta-externalagent|amazonbot|applebot-extended|mistral|grok|xai|youbot|duckassist/.test(u)) return "ai-agent";
  if (/mcp|x402|axios|node-fetch|undici|python-requests|python-httpx|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|got \(|ky\/|deno|bun\//.test(u) || /^node$/.test(u)) return "sdk";
  if (/curl|wget|httpie|postman|insomnia/.test(u)) return "cli";
  if (/bot|crawler|spider|crawl|slurp|facebookexternalhit|preview|monitor|uptime|scan|headless|lighthouse|python|scrapy/.test(u)) return "bot";
  if (/mozilla\/|safari|chrome|firefox|edg\//.test(u)) return "browser";
  return "other";
}

/** Short UA family: the "(compatible; Name/1.0" product for Mozilla-style bot UAs, else the first product token. */
export function uaFamily(ua: string | null | undefined): string {
  const u = (ua ?? "").trim();
  if (!u) return "none";
  const compat = /\(compatible;\s*([^;)\s]+)/i.exec(u);
  const tok = compat && /^mozilla\//i.test(u) ? compat[1] : u.split(/[\s(]/)[0];
  return tok.replace(/[^\x21-\x7e]/g, "").slice(0, 28) || "other";
}

/** Client type stored on each sale: "<ua_class>: <UA family>", at most 40 chars. Built from the User-Agent only (no IP). */
export function clientLabel(ua: string | null | undefined): string {
  return `${uaClass(ua)}: ${uaFamily(ua)}`.slice(0, 40);
}

/** Pathname with secrets stripped: /mcp/<owner key> becomes /mcp/:key. Capped at 200 chars. */
export function safePath(pathname: string): string {
  const p = pathname.startsWith("/mcp/") ? "/mcp/:key" : pathname;
  return p.slice(0, 200);
}

function refHost(ref: string | null): string | null {
  if (!ref) return null;
  try { return new URL(ref).hostname.slice(0, 120) || null; } catch { return null; }
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return [...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The inbound x402 payment header (PAYMENT-SIGNATURE, else X-PAYMENT), or null. */
export function paymentHeaderOf(request: Request): string | null {
  return request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT") || null;
}

const SAFE_TOKEN = /^[A-Za-z0-9:_.\-]{1,48}$/;
/** x402Version / scheme / network from a payment header (v2: accepted.*, v1: top level). Nothing else is read out. */
export function payHeaderMeta(header: string): { x402_version: number | null; scheme: string; network: string } {
  const out = { x402_version: null as number | null, scheme: "unknown", network: "unknown" };
  if (header.length > 16 * 1024) return { ...out, scheme: "oversize", network: "oversize" };
  let obj: any;
  try {
    const b = atob(header.trim().replace(/-/g, "+").replace(/_/g, "/"));
    obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
  } catch {
    return { ...out, scheme: "undecodable", network: "undecodable" };
  }
  if (!obj || typeof obj !== "object") return { ...out, scheme: "undecodable", network: "undecodable" };
  const v = Number(obj.x402Version);
  out.x402_version = Number.isInteger(v) && v >= 0 && v < 100 ? v : null;
  const src = obj.accepted && typeof obj.accepted === "object" ? obj.accepted : obj;
  if (typeof src.scheme === "string") out.scheme = SAFE_TOKEN.test(src.scheme) ? src.scheme : "other";
  if (typeof src.network === "string") out.network = SAFE_TOKEN.test(src.network) ? src.network : "other";
  return out;
}

/** Refusal reason safe to store: wallet addresses / hashes / long opaque tokens masked, short charset, 80 chars. */
export function safeReason(raw: string): string {
  return raw
    .replace(/0x[0-9a-fA-F]{6,}/g, "0x*")
    .replace(/\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g, "r*")
    .replace(/\b[GCM][A-Z2-7]{55,68}\b/g, "G*")
    .replace(/[A-Za-z0-9+/=]{24,}/g, "*")
    .replace(/[^A-Za-z0-9:_.\- *]/g, "_")
    .slice(0, 80) || "unknown";
}

/**
 * The refused-payment event for a request/response pair, or null when the request carried no payment header or the
 * response is not a refusal. `body` is the (JSON) response body text, read from a clone by the caller.
 */
export function payFailFrom(request: Request, status: number, body: string | null, now: number): PayFail | null {
  const header = paymentHeaderOf(request);
  if (!header || status < 400) return null;
  let reason = `http_${status}`;
  try {
    const j = body ? JSON.parse(body) : null;
    if (j && typeof j === "object") {
      const e = typeof j.error === "string" ? j.error : typeof j.reason === "string" ? j.reason : null;
      if (e) reason = typeof j.reason === "string" && j.reason !== e ? `${e}:${j.reason}` : e;
    }
  } catch { /* non-JSON refusal: keep http_<status> */ }
  if (/header is required/i.test(reason)) reason = "payment_header_missing";
  const meta = payHeaderMeta(header);
  return { ts: now, route: safePath(new URL(request.url).pathname), status, reason: safeReason(reason), ...meta, ua_family: uaFamily(request.headers.get("User-Agent")) };
}

/** Build the log row for one request/response pair. `secret` keys the IP hash (no secret = no hash). */
export async function trafficRow(request: Request, response: Response, secret: string | undefined, now: number): Promise<TrafficRow> {
  const url = new URL(request.url);
  const day = new Date(now).toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? null;
  const ua = request.headers.get("User-Agent");
  const cf = (request as unknown as { cf?: { country?: string } }).cf;
  return {
    ts: now,
    day,
    method: request.method.slice(0, 10),
    path: safePath(url.pathname),
    status: response.status,
    ua: ua ? ua.slice(0, 160) : null,
    ua_class: uaClass(ua),
    ref_host: refHost(request.headers.get("Referer")),
    ip_hash: ip && secret ? await hmacHex(secret, `traffic|${day}|${ip}`) : null,
    country: cf?.country ?? null,
    is_402: response.status === 402,
    paid: response.status < 400 && response.headers.has("PAYMENT-RESPONSE"),
  };
}

export class MemoryTrafficStore implements TrafficStore {
  /** legacy raw rows */
  rows: TrafficRow[] = [];
  list: { ts: number; b: TrafficBatch }[] = [];
  async addBatch(b: TrafficBatch) { this.list.push({ ts: b.to, b: JSON.parse(JSON.stringify(b)) }); }
  async batches(tsMs: number) { return this.list.filter((x) => x.ts >= tsMs).map((x) => x.b); }
  async since(tsMs: number, limit: number) { return this.rows.filter((r) => r.ts >= tsMs).sort((a, b) => b.ts - a.ts).slice(0, limit); }
  async prune(beforeMs: number) { this.rows = this.rows.filter((r) => r.ts >= beforeMs); this.list = this.list.filter((x) => x.ts >= beforeMs); }
  /** Total requests counted in batches (tests). */
  get counted() { return this.list.reduce((n, x) => n + x.b.requests, 0); }
}

const NO_TABLE = (e: unknown) => /no such table: traffic_batches/i.test(String((e as { message?: string })?.message ?? e));
/** Same DDL as migrations/0014_traffic_batches.sql. */
export const TRAFFIC_BATCHES_DDL =
  "CREATE TABLE IF NOT EXISTS traffic_batches (ts INTEGER NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (ts, id)) WITHOUT ROWID";

export class D1TrafficStore implements TrafficStore {
  constructor(private db: D1Like) {}
  async addBatch(b: TrafficBatch) {
    const id = [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const ins = () => this.db.prepare("INSERT INTO traffic_batches (ts, id, day, doc) VALUES (?,?,?,?)").bind(b.to, id, b.day, JSON.stringify(b)).run();
    try {
      await ins();
    } catch (e) {
      // Self-heal if this code is live before migration 0014 is applied (same DDL; the migration is then a no-op).
      if (!NO_TABLE(e)) throw e;
      await this.db.prepare(TRAFFIC_BATCHES_DDL).run();
      await ins();
    }
  }
  async batches(tsMs: number) {
    try {
      const out = await this.db.prepare("SELECT doc FROM traffic_batches WHERE ts >= ?").bind(tsMs).all<{ doc: string }>();
      return (out.results ?? []).flatMap((x) => { try { return [JSON.parse(String(x.doc)) as TrafficBatch]; } catch { return []; } });
    } catch (e) {
      if (NO_TABLE(e)) return [];
      throw e;
    }
  }
  async since(tsMs: number, limit: number) {
    const out = await this.db
      .prepare("SELECT ts, day, method, path, status, ua, ua_class, ref_host, ip_hash, country, is_402, paid FROM traffic WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
      .bind(tsMs, limit)
      .all<Record<string, unknown>>();
    return (out.results ?? []).map((x) => ({ ...(x as unknown as TrafficRow), is_402: Number(x.is_402) === 1, paid: Number(x.paid) === 1 }));
  }
  async prune(beforeMs: number) {
    // Both are no-ops (0 rows written) until rows are 90 days old.
    await this.db.prepare("DELETE FROM traffic WHERE ts < ?").bind(beforeMs).run();
    await this.db.prepare("DELETE FROM traffic_batches WHERE ts < ?").bind(beforeMs).run().catch((e) => { if (!NO_TABLE(e)) throw e; });
  }
}

const emptyBatch = (day: string, t: number): TrafficBatch => ({ day, from: t, to: t, requests: 0, r402: 0, paid: 0, browser: 0, paths: {}, status: {}, clients: {}, uas: {}, refs: {}, countries: {}, ips: [] });
const inc = (m: Record<string, number>, k: string | null, n = 1) => { if (k !== null) m[k] = (m[k] ?? 0) + n; };

/** Count one request into a batch (in memory). */
export function countRow(b: TrafficBatch, r: TrafficRow, ips?: Set<string>) {
  b.requests++;
  b.from = Math.min(b.from, r.ts);
  b.to = Math.max(b.to, r.ts);
  if (r.is_402) b.r402++;
  if (r.paid) b.paid++;
  if (r.paid && r.paid_test) b.paid_test = (b.paid_test ?? 0) + 1;
  if (r.ua_class === "browser") b.browser++;
  const p = (b.paths[r.path] ??= [0, 0, 0]);
  p[0]++;
  if (r.is_402) p[1]++;
  if (r.paid) p[2]++;
  inc(b.status, String(r.status));
  inc(b.clients, r.ua_class);
  inc(b.uas, r.ua ? `${r.ua_class}: ${r.ua}` : null);
  inc(b.refs, r.ref_host);
  inc(b.countries, r.country);
  if (r.ip_hash && (!ips || !ips.has(r.ip_hash))) { ips?.add(r.ip_hash); b.ips.push(r.ip_hash); }
  if (r.pay_fail) {
    const list = (b.pay_fails ??= []);
    if (list.length < PAY_FAIL_BATCH_MAX) list.push(r.pay_fail);
    else b.pay_fails_dropped = (b.pay_fails_dropped ?? 0) + 1;
  }
}

export const PAY_FAIL_BATCH_MAX = 100;
/** A refused payment flushes its batch at once, but at most once per this window per isolate (D1 write budget). */
export const PAY_FAIL_FLUSH_MS = 10_000;

export const TRAFFIC_FLUSH_MS = 120_000;
export const TRAFFIC_FLUSH_MAX = 500;

/**
 * Per-isolate request counter. add() returns a flush promise when the open batch is older than flushMs, has maxRequests
 * requests, or the UTC day changed; the caller hands it to waitUntil. One D1 row per flush instead of 3 per request.
 * Best-effort: counts still in memory when an isolate is evicted are lost (at most one flush window per isolate).
 */
export class TrafficBuffer {
  private open: { b: TrafficBatch; ips: Set<string>; started: number } | undefined;
  private lastFailFlush = -Infinity;
  constructor(private store: TrafficStore, private opts: { flushMs?: number; maxRequests?: number } = {}) {}
  add(row: TrafficRow, now: number): Promise<void> | undefined {
    let pending: Promise<void> | undefined;
    if (this.open && this.open.b.day !== row.day) pending = this.flush();
    if (!this.open) this.open = { b: emptyBatch(row.day, row.ts), ips: new Set(), started: now };
    countRow(this.open.b, row, this.open.ips);
    // A paid call flushes at once: paid calls are rare (one extra D1 row each) and often arrive in a short burst on an
    // isolate that then idles and is evicted before the 2-minute window would flush, which silently lost them (Oct 23-25 2026).
    // A refused payment attempt also flushes at once (rare, and the evidence we need), rate-capped per isolate so a client
    // retrying a bad header in a loop costs at most one D1 row per PAY_FAIL_FLUSH_MS; the rest ride the normal window.
    const failDue = !!row.pay_fail && now - this.lastFailFlush >= PAY_FAIL_FLUSH_MS;
    if (failDue) this.lastFailFlush = now;
    const due = row.paid || failDue || now - this.open.started >= (this.opts.flushMs ?? TRAFFIC_FLUSH_MS) || this.open.b.requests >= (this.opts.maxRequests ?? TRAFFIC_FLUSH_MAX);
    if (due) {
      const f = this.flush();
      pending = pending ? Promise.all([pending, f]).then(() => {}) : f;
    }
    return pending;
  }
  /** Write the open batch now (also used by the cron in this isolate). */
  flush(): Promise<void> {
    const o = this.open;
    this.open = undefined;
    if (!o || !o.b.requests) return Promise.resolve();
    return this.store.addBatch(o.b);
  }
  get size() { return this.open?.b.requests ?? 0; }
}

const topOf = (m: Map<string, number>, n: number) =>
  [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([key, requests]) => ({ key, requests }));
const addAll = (m: Map<string, number>, o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) m.set(k, (m.get(k) ?? 0) + v); };

/** Minimal view of the sales ledger (one row per settled payment) used for the authoritative paid counts. */
export interface PaidSource {
  since(tsMs: number): Promise<{ ts: number; isTest: boolean; usd: number | null }[]>;
}

const usd6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Owner summary over the last `days` (1-90) days: aggregate batches plus any legacy raw rows in the window.
 * With `sales`, daily and total `paid` come from the sales ledger (authoritative: one row per settled payment, UTC day of
 * the settlement), split into paid_outside / paid_test (Lumi's own wallets) with USD; `paid_logged` keeps the request-log
 * count. A lost isolate flush can no longer zero paid. Without `sales` (or if it fails) paid is the request-log count.
 */
export async function trafficSummary(store: TrafficStore, now: number, days: number, salesSrc?: PaidSource) {
  const d = Math.max(1, Math.min(TRAFFIC_RETENTION_DAYS, Math.floor(days) || 7));
  const startDay = new Date(now - (d - 1) * 86_400_000).toISOString().slice(0, 10);
  const since = Date.parse(`${startDay}T00:00:00Z`);
  const LIMIT = 100_000;
  const legacy = await store.since(since, LIMIT);
  const batches = (await store.batches(since)).filter((b) => b.day >= startDay);
  // Legacy raw rows become one batch per day so everything below reads one shape.
  const byDay = new Map<string, TrafficBatch>();
  for (const r of legacy) {
    const b = byDay.get(r.day) ?? emptyBatch(r.day, r.ts);
    byDay.set(r.day, b);
    countRow(b, r);
  }
  const all = [...batches, ...byDay.values()];
  const fails: PayFail[] = [];
  let failsDropped = 0;
  for (const b of batches) { if (b.pay_fails) fails.push(...b.pay_fails); failsDropped += b.pay_fails_dropped ?? 0; }
  const daily = new Map<string, { requests: number; visitors: Set<string>; r402: number; paid: number; browser: number }>();
  for (let t = since; t <= now; t += 86_400_000) daily.set(new Date(t).toISOString().slice(0, 10), { requests: 0, visitors: new Set(), r402: 0, paid: 0, browser: 0 });
  const paths = new Map<string, number>(), p402 = new Map<string, number>(), ppaid = new Map<string, number>();
  const status = new Map<string, number>(), clients = new Map<string, number>(), uas = new Map<string, number>(), refs = new Map<string, number>(), countries = new Map<string, number>();
  for (const b of all) {
    const e = daily.get(b.day) ?? { requests: 0, visitors: new Set<string>(), r402: 0, paid: 0, browser: 0 };
    e.requests += b.requests;
    e.r402 += b.r402;
    e.paid += b.paid;
    e.browser += b.browser;
    for (const ip of b.ips) e.visitors.add(ip);
    daily.set(b.day, e);
    for (const [p, [n, n402, np]] of Object.entries(b.paths)) {
      paths.set(p, (paths.get(p) ?? 0) + n);
      if (n402) p402.set(p, (p402.get(p) ?? 0) + n402);
      if (np) ppaid.set(p, (ppaid.get(p) ?? 0) + np);
    }
    addAll(status, b.status); addAll(clients, b.clients); addAll(uas, b.uas); addAll(refs, b.refs); addAll(countries, b.countries);
  }
  const days_ = [...daily.entries()].sort();
  const sum = (f: (e: (typeof days_)[number][1]) => number) => days_.reduce((n, [, e]) => n + f(e), 0);
  const paidLogged = sum((e) => e.paid);
  // Authoritative paid counts from the sales ledger (small table; one indexed range read).
  let ledger: Map<string, { outside: number; test: number; usd_outside: number; usd_test: number }> | undefined;
  if (salesSrc) {
    try {
      const rows = await salesSrc.since(since);
      ledger = new Map(days_.map(([day]) => [day, { outside: 0, test: 0, usd_outside: 0, usd_test: 0 }]));
      for (const r of rows) {
        const day = new Date(r.ts).toISOString().slice(0, 10);
        if (day < startDay) continue;
        const e = ledger.get(day) ?? { outside: 0, test: 0, usd_outside: 0, usd_test: 0 };
        if (r.isTest) { e.test++; e.usd_test += r.usd ?? 0; } else { e.outside++; e.usd_outside += r.usd ?? 0; }
        ledger.set(day, e);
      }
    } catch {
      ledger = undefined;
    }
  }
  const paidOf = (day: string, e: (typeof days_)[number][1]) => (ledger ? (ledger.get(day)?.outside ?? 0) + (ledger.get(day)?.test ?? 0) : e.paid);
  const requests = sum((e) => e.requests), r402 = sum((e) => e.r402), paid = days_.reduce((n, [day, e]) => n + paidOf(day, e), 0);
  const L = (day: string) => ledger?.get(day) ?? { outside: 0, test: 0, usd_outside: 0, usd_test: 0 };
  const ledgerTotals = ledger
    ? days_.reduce((t, [day]) => { const x = L(day); return { outside: t.outside + x.outside, test: t.test + x.test, usd_outside: t.usd_outside + x.usd_outside, usd_test: t.usd_test + x.usd_test }; }, { outside: 0, test: 0, usd_outside: 0, usd_test: 0 })
    : undefined;
  return {
    kind: "owner_traffic",
    generated_at: new Date(now).toISOString(),
    window: { days: d, from: startDay, to: new Date(now).toISOString().slice(0, 10) },
    truncated: legacy.length >= LIMIT,
    privacy: "No raw IPs are stored: visitors are counted with a daily-rotating keyed hash. Pathnames only (no query strings); /mcp/<key> is stored as /mcp/:key.",
    paid_source: ledger ? "sales_ledger" : "traffic_log",
    paid_note: "paid = settled payments in the sales ledger by UTC day (paid_outside = outside customers, paid_test = Lumi's own test wallets; usd_* at list/settled value). paid_logged = paid requests seen by the request log (best-effort; can undercount). top_paid_paths is from the request log.",
    method_note: "Since Oct 23 2026 requests are counted in memory and written as aggregate batches (about one D1 row per isolate every 2 minutes) instead of one row per request; counts held by an isolate that is evicted before it flushes are lost, so totals are a slight undercount.",
    totals: {
      requests,
      visitor_days: sum((e) => e.visitors.size),
      payment_required_402: r402,
      paid,
      ...(ledgerTotals ? { paid_outside: ledgerTotals.outside, paid_test: ledgerTotals.test, usd_outside: usd6(ledgerTotals.usd_outside), usd_test: usd6(ledgerTotals.usd_test) } : {}),
      paid_logged: paidLogged,
      paid_per_402: r402 ? Number((paid / r402).toFixed(4)) : null,
      by_status: Object.fromEntries(topOf(status, 20).map((x) => [x.key, x.requests])),
      by_client: Object.fromEntries(topOf(clients, 10).map((x) => [x.key, x.requests])),
    },
    daily: days_.map(([day, e]) => ({
      day, requests: e.requests, visitors: e.visitors.size, payment_required_402: e.r402, paid: paidOf(day, e),
      ...(ledger ? { paid_outside: L(day).outside, paid_test: L(day).test, usd_outside: usd6(L(day).usd_outside), usd_test: usd6(L(day).usd_test) } : {}),
      paid_logged: e.paid, browser: e.browser, non_browser: e.requests - e.browser,
    })),
    payment_failures: payFailSummary(fails, failsDropped),
    top_paths: topOf(paths, 25),
    top_402_paths: topOf(p402, 15),
    top_paid_paths: topOf(ppaid, 15),
    top_user_agents: topOf(uas, 25),
    top_referrers: topOf(refs, 20),
    top_countries: topOf(countries, 20),
  };
}

/** Refused payment attempts by reason / route / network / scheme / x402 version / UA family / day, plus the latest 25. */
export function payFailSummary(fails: PayFail[], dropped = 0) {
  const by = (f: (x: PayFail) => string) => {
    const m = new Map<string, number>();
    for (const x of fails) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
    return Object.fromEntries(topOf(m, 30).map((x) => [x.key, x.requests]));
  };
  return {
    note: "Requests that carried PAYMENT-SIGNATURE or X-PAYMENT and were refused (HTTP >= 400). No payer addresses or signatures are stored.",
    total: fails.length + dropped,
    detailed: fails.length,
    dropped_over_batch_cap: dropped,
    by_reason: by((x) => x.reason),
    by_route: by((x) => x.route),
    by_network: by((x) => x.network),
    by_scheme: by((x) => x.scheme),
    by_x402_version: by((x) => (x.x402_version === null ? "unknown" : `v${x.x402_version}`)),
    by_ua_family: by((x) => x.ua_family),
    daily: by((x) => new Date(x.ts).toISOString().slice(0, 10)),
    daily_by_reason: fails.reduce<Record<string, Record<string, number>>>((o, x) => {
      const d = (o[new Date(x.ts).toISOString().slice(0, 10)] ??= {});
      d[x.reason] = (d[x.reason] ?? 0) + 1;
      return o;
    }, {}),
    recent: [...fails].sort((a, b) => b.ts - a.ts).slice(0, 25).map((x) => ({ ...x, at: new Date(x.ts).toISOString() })),
  };
}
