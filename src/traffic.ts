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
}

/** One flushed aggregate: every request counted in one isolate during one flush window (single UTC day). */
export interface TrafficBatch {
  day: string;
  from: number;
  to: number;
  requests: number;
  r402: number;
  paid: number;
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
}

export const TRAFFIC_FLUSH_MS = 120_000;
export const TRAFFIC_FLUSH_MAX = 500;

/**
 * Per-isolate request counter. add() returns a flush promise when the open batch is older than flushMs, has maxRequests
 * requests, or the UTC day changed; the caller hands it to waitUntil. One D1 row per flush instead of 3 per request.
 * Best-effort: counts still in memory when an isolate is evicted are lost (at most one flush window per isolate).
 */
export class TrafficBuffer {
  private open: { b: TrafficBatch; ips: Set<string>; started: number } | undefined;
  constructor(private store: TrafficStore, private opts: { flushMs?: number; maxRequests?: number } = {}) {}
  add(row: TrafficRow, now: number): Promise<void> | undefined {
    let pending: Promise<void> | undefined;
    if (this.open && this.open.b.day !== row.day) pending = this.flush();
    if (!this.open) this.open = { b: emptyBatch(row.day, row.ts), ips: new Set(), started: now };
    countRow(this.open.b, row, this.open.ips);
    const due = now - this.open.started >= (this.opts.flushMs ?? TRAFFIC_FLUSH_MS) || this.open.b.requests >= (this.opts.maxRequests ?? TRAFFIC_FLUSH_MAX);
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

/** Owner summary over the last `days` (1-90) days: aggregate batches plus any legacy raw rows in the window. */
export async function trafficSummary(store: TrafficStore, now: number, days: number) {
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
  const requests = sum((e) => e.requests), r402 = sum((e) => e.r402), paid = sum((e) => e.paid);
  return {
    kind: "owner_traffic",
    generated_at: new Date(now).toISOString(),
    window: { days: d, from: startDay, to: new Date(now).toISOString().slice(0, 10) },
    truncated: legacy.length >= LIMIT,
    privacy: "No raw IPs are stored: visitors are counted with a daily-rotating keyed hash. Pathnames only (no query strings); /mcp/<key> is stored as /mcp/:key.",
    method_note: "Since Oct 23 2026 requests are counted in memory and written as aggregate batches (about one D1 row per isolate every 2 minutes) instead of one row per request; counts held by an isolate that is evicted before it flushes are lost, so totals are a slight undercount.",
    totals: {
      requests,
      visitor_days: sum((e) => e.visitors.size),
      payment_required_402: r402,
      paid,
      paid_per_402: r402 ? Number((paid / r402).toFixed(4)) : null,
      by_status: Object.fromEntries(topOf(status, 20).map((x) => [x.key, x.requests])),
      by_client: Object.fromEntries(topOf(clients, 10).map((x) => [x.key, x.requests])),
    },
    daily: days_.map(([day, e]) => ({ day, requests: e.requests, visitors: e.visitors.size, payment_required_402: e.r402, paid: e.paid, browser: e.browser, non_browser: e.requests - e.browser })),
    top_paths: topOf(paths, 25),
    top_402_paths: topOf(p402, 15),
    top_paid_paths: topOf(ppaid, 15),
    top_user_agents: topOf(uas, 25),
    top_referrers: topOf(refs, 20),
    top_countries: topOf(countries, 20),
  };
}
