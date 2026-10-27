/**
 * Edge cache + crawler guard for Lumi's free, public, read-only pages (buyer-fixes 2026-10-27).
 *
 * Why: the edge saw ~100-330 504s a day on /v1/trust/vendors, /v1/trust/catalog, /v1/trust/methodology, /v1/samples and
 * /trust/v/{key} (badge pages), almost all on cache misses during crawler bursts (Agent402 on Oct 27: 289 of 531). A miss
 * rebuilds the document from D1; N concurrent misses in one isolate did N rebuilds, and an expired entry made every
 * caller wait for a rebuild.
 *
 * What this does (GET/HEAD only, never paid routes, never 402s, never requests with Authorization or a payment header):
 *  - caches 200 responses whose Cache-Control is `public, max-age=N` in caches.default under a normalized key
 *    (sorted query string), stored with a stale window so the entry outlives its freshness;
 *  - fresh hit: served as-is; stale hit (age <= max-age + stale window): served at once and refreshed in the background
 *    (stale-while-revalidate), one refresh per key per isolate;
 *  - miss: one rebuild per key per isolate (concurrent misses share it), bounded by a deadline; past the deadline the
 *    caller gets a stale copy if one exists, else 503 + Retry-After (never a hung request / edge 504);
 *  - a light per-client token bucket (per isolate, keyed by IP, falling back to UA): cache hits cost 1, misses cost 5;
 *    an empty bucket answers 429 + Retry-After. Normal clients never notice; a burst crawler is slowed, not timed out.
 */

export interface EdgeCacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

export interface EdgeOpts {
  cache?: EdgeCacheLike;
  now?: () => number;
  waitUntil?: (p: Promise<unknown>) => void;
  /** ms before a miss gives up (stale copy or 503). */
  deadlineMs?: number;
  limiter?: CrawlerLimiter;
}

/** Free public documents handled here. Paid routes (402) never match. */
export const PUBLIC_CACHED = /^\/(v1\/(samples|trust\/vendors|trust\/catalog|trust\/methodology)|trust\/v\/[^/]{1,300})\/?$/i;

/** Header holding the app's own Cache-Control on the stored copy (see restoreHit in index.ts). */
export const ORIGIN_CC = "X-Lumi-Cache-Control";
/** Header holding the store time (ms) on the stored copy. */
export const STORED_AT = "X-Lumi-Stored-At";
/** Diagnostic header on responses that went through the edge layer: hit | stale | miss | shared | timeout-stale. */
export const EDGE_STATUS = "X-Lumi-Edge";

export const DEFAULT_DEADLINE_MS = 20_000;
/** Stale window: 5x the max-age, at least 10 min, at most 6 h. */
export function staleWindowS(maxAge: number): number {
  return Math.min(6 * 3600, Math.max(600, maxAge * 5));
}

export function maxAgeOf(cc: string | null | undefined): number | null {
  const c = cc ?? "";
  if (!/\bpublic\b/i.test(c) || /no-store|no-cache|private/i.test(c)) return null;
  const m = /(?:^|[\s,])max-age=(\d+)/i.exec(c);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cache key: origin + path (trailing slash dropped; /trust/v/ keys lowercased) + sorted query. */
export function edgeKey(url: URL): string {
  let path = url.pathname.replace(/\/+$/, "") || "/";
  // Badge pages: lowercased, query dropped (?v=123 cache-busting must not turn into extra D1 reads).
  if (/^\/trust\/v\//i.test(path)) return `${url.origin}${path.toLowerCase()}`;
  const q = [...url.searchParams.entries()].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const qs = q.length ? "?" + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  return `${url.origin}${path}${qs}`;
}

/** True when this request may use the public edge cache. */
export function isEdgeCacheable(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (!PUBLIC_CACHED.test(url.pathname)) return false;
  for (const h of ["Authorization", "PAYMENT-SIGNATURE", "X-PAYMENT", "SIGN-IN-WITH-X", "X-Lumi-Trial"]) if (request.headers.has(h)) return false;
  return true;
}

/** Per-isolate token bucket per client. Light by design: memory-only, bounded map. */
export class CrawlerLimiter {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private opts: { capacity?: number; refillPerS?: number; maxKeys?: number } = {}) {}
  get capacity() { return this.opts.capacity ?? 120; }
  get refill() { return this.opts.refillPerS ?? 2; }
  /** Take `cost` tokens; returns 0 when allowed, else seconds until enough tokens exist. */
  take(key: string, cost: number, nowMs: number): number {
    const cap = this.capacity, r = this.refill;
    let e = this.b.get(key);
    if (!e) {
      if (this.b.size >= (this.opts.maxKeys ?? 5000)) this.b.delete(this.b.keys().next().value as string);
      e = { tokens: cap, at: nowMs };
      this.b.set(key, e);
    }
    e.tokens = Math.min(cap, e.tokens + ((nowMs - e.at) / 1000) * r);
    e.at = nowMs;
    if (e.tokens >= cost) { e.tokens -= cost; return 0; }
    return Math.max(1, Math.ceil((cost - e.tokens) / r));
  }
}

export function clientKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
  return ip ? `ip:${ip}` : `ua:${(request.headers.get("User-Agent") ?? "").slice(0, 120)}`;
}

export const HIT_COST = 1;
export const MISS_COST = 5;

function tooMany(retryAfter: number, head: boolean): Response {
  const body = head ? null : JSON.stringify({ error: "rate_limited", detail: "Too many requests to Lumi's free public pages from this client. Retry after the given seconds; cached copies refresh every few minutes.", retry_after_s: retryAfter });
  return new Response(body, { status: 429, headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(retryAfter), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}

function unavailable(head: boolean): Response {
  const body = head ? null : JSON.stringify({ error: "busy", detail: "This free page is being rebuilt; retry shortly.", retry_after_s: 30 });
  return new Response(body, { status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "30", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}

/** Statuses worth caching when the app marks them public (a 404 "unknown key" is as cacheable as a 200; never 402/429/5xx). */
const STORABLE_STATUS = new Set([200, 400, 404]);

/** The copy that goes into the cache: same response, app Cache-Control kept aside, store time, longer max-age for SWR. */
export function toStored(res: Response, nowMs: number): Response | null {
  const cc = res.headers.get("Cache-Control");
  const maxAge = maxAgeOf(cc);
  if (!STORABLE_STATUS.has(res.status) || maxAge === null) return null;
  const h = new Headers(res.headers);
  h.set(ORIGIN_CC, cc ?? "");
  h.set(STORED_AT, String(nowMs));
  h.set("Cache-Control", `public, max-age=${maxAge + staleWindowS(maxAge)}`);
  h.delete(EDGE_STATUS);
  return new Response(res.clone().body, { status: res.status, statusText: res.statusText, headers: h });
}

/** A stored copy turned back into a client response (original Cache-Control, helper headers removed). */
export function fromStored(hit: Response, status: string, head: boolean): Response {
  const h = new Headers(hit.headers);
  const cc = h.get(ORIGIN_CC);
  if (cc) h.set("Cache-Control", cc);
  h.delete(ORIGIN_CC);
  h.delete(STORED_AT);
  h.set(EDGE_STATUS, status);
  return new Response(head ? null : hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
}

function ageOf(hit: Response, nowMs: number): { ageS: number; maxAge: number } | null {
  const at = Number(hit.headers.get(STORED_AT));
  const maxAge = maxAgeOf(hit.headers.get(ORIGIN_CC));
  if (!Number.isFinite(at) || at <= 0 || maxAge === null) return null;
  return { ageS: Math.max(0, (nowMs - at) / 1000), maxAge };
}

// One rebuild / refresh per key per isolate.
const inflight = new Map<string, Promise<Response>>();
const refreshing = new Set<string>();
/** Tests only. */
export function _resetEdgeState() { inflight.clear(); refreshing.clear(); }

/**
 * Serve a public page through the edge cache. `produce` builds the response (always called with a GET request for the
 * normalized URL so GET and HEAD share one entry). Returns the client response.
 */
export async function serveEdgeCached(request: Request, produce: (req: Request) => Promise<Response>, opts: EdgeOpts): Promise<Response> {
  const now = opts.now ?? Date.now;
  const head = request.method === "HEAD";
  const key = edgeKey(new URL(request.url));
  const cache = opts.cache;
  const limiter = opts.limiter;
  const ck = clientKey(request);
  const keep = (p: Promise<unknown>) => (opts.waitUntil ? opts.waitUntil(p) : void p.catch(() => {}));

  const build = (): Promise<Response> => {
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        const res = await produce(new Request(key, { method: "GET", headers: request.headers }));
        const stored = cache ? toStored(res, now()) : null;
        if (stored && cache) keep(cache.put(key, stored).catch(() => {}));
        return res;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p.then((r) => r.clone());
  };

  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  const age = hit ? ageOf(hit, now()) : null;
  if (hit && age && age.ageS <= age.maxAge + staleWindowS(age.maxAge)) {
    if (limiter) { const wait = limiter.take(ck, HIT_COST, now()); if (wait) return tooMany(wait, head); }
    if (age.ageS <= age.maxAge) return fromStored(hit, "hit", head);
    if (!refreshing.has(key)) {
      refreshing.add(key);
      keep(build().then(() => undefined, () => undefined).finally(() => refreshing.delete(key)));
    }
    return fromStored(hit, "stale", head);
  }

  if (limiter) { const wait = limiter.take(ck, MISS_COST, now()); if (wait) return tooMany(wait, head); }
  const shared = inflight.has(key);
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((ok) => { timer = setTimeout(() => ok("timeout"), deadline); });
  const work = build();
  keep(work.catch(() => undefined)); // the rebuild may finish after the deadline and still fill the cache
  const r = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  if (r === "timeout") {
    if (hit) return fromStored(hit, "timeout-stale", head);
    return unavailable(head);
  }
  const h = new Headers(r.headers);
  h.set(EDGE_STATUS, shared ? "shared" : "miss");
  return new Response(head ? null : r.body, { status: r.status, statusText: r.statusText, headers: h });
}

/** caches.default adapter (string keys). */
export function defaultEdgeCache(): EdgeCacheLike | undefined {
  const c = (globalThis as any).caches?.default as Cache | undefined;
  if (!c) return undefined;
  return { match: (k) => c.match(k), put: (k, r) => c.put(k, r) };
}
