/** Cloudflare Workers entry point. */
import { createApp, type App } from "./app";
import type { Env } from "./config";
import type { CatalogJob } from "./trust/catalog_service";
import { legacyBadgeRedirect } from "./trust/badge";
import { CrawlerLimiter, defaultEdgeCache, isEdgeCacheable, serveEdgeCached } from "./edge_cache";

/** Per-isolate crawler guard for the free public pages (429 + Retry-After instead of slow misses). */
const limiter = new CrawlerLimiter();

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
 * Free public pages (trust vendors/catalog/methodology, samples, and the "Tested by Lumi" /trust/v/{key} pages) go
 * through the edge cache with stale-while-revalidate, one rebuild per key, a miss deadline and a light crawler limit
 * (see edge_cache.ts). Badge pages are deliberately not traffic-logged (hot-linked) and skip the pricer.
 */
async function servePublic(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, url: URL): Promise<Response> {
  const badge = /^\/trust\/v\//i.test(url.pathname);
  const res = await serveEdgeCached(
    request,
    async (req) => (badge ? ((await appFor(env).badge(req)) ?? new Response("Not found", { status: 404 })) : appFor(env).fetch(req, ctx)),
    { cache: defaultEdgeCache(), waitUntil: (p) => ctx.waitUntil(p), limiter },
  );
  if (!badge) appFor(env).logTraffic(request, res, ctx);
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" || request.method === "HEAD") {
      // Legacy /badge: 301 to the signed /v1/badge route, query kept.
      const legacy = legacyBadgeRedirect(url);
      if (legacy) return legacy;
    }
    if (isEdgeCacheable(request, url)) return servePublic(request, env, ctx, url);
    const res = await appFor(env).fetch(request, ctx);
    appFor(env).logTraffic(request, res, ctx);
    return res;
  },
  /** Cron triggers. LIVE_CRON (every minute): a no-op since the market feeds were retired (2026-10-25).
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
    // Lumi Check contributions (lumi-contrib-writes): the whole batch lands in ONE D1 batch, on its own write budget.
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
