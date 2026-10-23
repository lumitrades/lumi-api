/** Cloudflare Workers entry point. */
import { createApp, type App } from "./app";
import type { Env } from "./config";
import type { CatalogJob } from "./trust/catalog_service";
import { BADGE_PATH_RE } from "./trust/badge";

/** Must match the one-minute entry in wrangler.toml [triggers] crons. */
const LIVE_CRON = "* * * * *";

// One app per isolate (keeps the data cache and replay guard warm between requests).
let app: App | undefined;
let appEnv: Env | undefined;

function appFor(env: Env): App {
  if (!app || appEnv !== env) {
    app = createApp(env);
    appEnv = env;
  }
  return app;
}

/** Free, public, read-only documents served from the Cloudflare edge cache (TTL = their Cache-Control max-age). */
const EDGE_CACHED = /^\/v1\/(samples|trust\/vendors|trust\/catalog|trust\/methodology)$/;

function edgeCache(): Cache | undefined {
  return (globalThis as any).caches?.default as Cache | undefined;
}

/** Header that keeps the app's own Cache-Control on the stored copy. Cloudflare's zone "Browser Cache TTL" (4 h by default)
 * rewrites Cache-Control on Cache-API hits, which would let clients keep trust lookups for 4 h instead of 5 min. */
const ORIGIN_CC = "X-Lumi-Cache-Control";

/** A cache hit with the app's original Cache-Control restored (and the helper header dropped). */
export function restoreHit(hit: Response): Response {
  const h = new Headers(hit.headers);
  const cc = h.get(ORIGIN_CC);
  if (cc) h.set("Cache-Control", cc);
  h.delete(ORIGIN_CC);
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
}

/** The copy stored in the edge cache: the same response plus the helper header. */
export function storable(res: Response): Response {
  const h = new Headers(res.headers);
  h.set(ORIGIN_CC, res.headers.get("Cache-Control") ?? "");
  return new Response(res.clone().body, { status: res.status, statusText: res.statusText, headers: h });
}

/**
 * Cache key for the public badge paths: origin + lowercased path, no query string and no trailing slash, so
 * `?v=123` cache-busting or case variants cannot turn into extra D1 reads. GET and HEAD share the entry.
 */
export function badgeCacheKey(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
}

/**
 * "Tested by Lumi" badge + result page. Served from the edge cache (1 h); on a miss the app reads at most a few indexed
 * D1 rows and writes nothing. Deliberately not traffic-logged (embedded badges are hot-linked and would only add
 * traffic rows) and never routed through the pricer or rate limiter.
 */
async function serveBadge(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, url: URL): Promise<Response> {
  const head = request.method === "HEAD";
  const cache = edgeCache();
  const key = badgeCacheKey(url);
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const out = restoreHit(hit);
      return head ? new Response(null, { status: out.status, headers: out.headers }) : out;
    }
  }
  const res = (await appFor(env).badge(new Request(key, { method: "GET" }))) ?? new Response("Not found", { status: 404 });
  if (cache && res.status < 500 && /public, max-age=\d+/.test(res.headers.get("Cache-Control") ?? "")) {
    ctx.waitUntil(cache.put(key, storable(res)).catch(() => {}));
  }
  return head ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && BADGE_PATH_RE.test(url.pathname)) return serveBadge(request, env, ctx, url);
    const cache = request.method === "GET" && !request.headers.has("Authorization") && EDGE_CACHED.test(url.pathname) ? edgeCache() : undefined;
    if (cache) {
      const hit = await cache.match(request).catch(() => undefined);
      if (hit) {
        const out = restoreHit(hit);
        appFor(env).logTraffic(request, out, ctx);
        return out;
      }
    }
    const res = await appFor(env).fetch(request, ctx);
    appFor(env).logTraffic(request, res, ctx);
    if (cache && res.status === 200 && /public, max-age=\d+/.test(res.headers.get("Cache-Control") ?? "")) {
      ctx.waitUntil(cache.put(request, storable(res)).catch(() => {}));
    }
    return res;
  },
  /** Cron triggers. LIVE_CRON (every minute): live signals for the stalest slice of the top-50 coins.
   * Every 30 min: free, unpaid 402-quote probes of the trust allowlist; schedules catalog jobs. */
  async scheduled(event: { cron?: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (event?.cron === LIVE_CRON) {
      ctx.waitUntil(appFor(env).liveRefresh().catch((e) => console.error(JSON.stringify({ event: "live_refresh_error", error: String(e) }))));
      return;
    }
    ctx.waitUntil(appFor(env).scheduled().catch((e) => console.error(JSON.stringify({ event: "trust_probe_error", error: String(e) }))));
  },
  /** Queue consumer (lumi-trust-jobs, batch size 1): one catalog ingest page or one quote-check slice per invocation. */
  async queue(batch: { queue?: string; messages: { body: CatalogJob; ack(): void; retry(o?: { delaySeconds?: number }): void }[] }, env: Env): Promise<void> {
    const a = appFor(env);
    // Scanner-kit contributions (lumi-contrib-writes): the whole batch lands in ONE D1 batch, on its own write budget.
    if (batch.queue === CONTRIB_QUEUE_NAME || (batch.messages[0]?.body as any)?.kind === "contrib_write") {
      try {
        await a.contribQueue(batch.messages.map((m) => m.body));
        for (const m of batch.messages) m.ack();
      } catch (e) {
        console.error(JSON.stringify({ event: "contrib_write_error", n: batch.messages.length, error: String(e) }));
        for (const m of batch.messages) m.retry({ delaySeconds: 120 });
      }
      return;
    }
    for (const m of batch.messages) {
      try {
        await a.queue(m.body);
        m.ack();
      } catch (e) {
        console.error(JSON.stringify({ event: "catalog_job_error", kind: m.body?.kind, error: String(e) }));
        m.retry({ delaySeconds: /\b429\b/.test(String(e)) ? 300 + Math.floor(Math.random() * 600) : 60 });
      }
    }
  },
};

const CONTRIB_QUEUE_NAME = "lumi-contrib-writes";

export { InvoiceGuard } from "./invoice-guard";
