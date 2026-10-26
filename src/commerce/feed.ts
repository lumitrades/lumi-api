/**
 * Data licence feed for facilitators, wallets and agent frameworks: keyed, metered access to Lumi's catalog
 * observations. Keys are random secrets stored only as SHA-256 hashes. Free keys need a wallet signature; paid plans
 * (Feed, Feed Pro) and metered credits are bought via x402. Free/credit lookups are answer-only (no tx evidence);
 * Feed and Feed Pro include full evidence and signed receipts.
 */
import { json, requirePayment, assetLabel, paymentRequiredResponse, HEADER_PAYMENT_SIGNATURE, HEADER_X_PAYMENT, type Settlement, type PaymentRequirements } from "../x402";
import { catalogFreeView, catalogView, urlVariants, type CatalogRow } from "../trust/catalog";
import { vet402View, VET402 } from "../trust/evidence";
import { VENDORS } from "../vendors";
import { XRPL_ADDR_RE, EVM_ADDR_RE } from "../trust/verify";
import { DAY_MS, FEED_LIMITS, FEED_PLANS, PLANS, TEST_PRICE_USD, hmacHex, iso, isTestWallet, planPriceUsd, planQuote, randHex, sha256, PLATFORM_LICENCE, type PlanId } from "./plans";
import { FEED_LICENSE } from "./policy";
import { makeChallenge, verifyProof } from "./proof";
import { NO_STORE, bad, bearer, monthKey, readJson, safeHttpsUrl, type CommerceDeps, type WaitUntil } from "./common";
import type { FeedKey } from "./store";

const KEY_ID_RE = /^fk_[a-f0-9]{20}$/;
export const FEED_POST_PATHS = ["/v1/feed/keys", "/v1/feed/lookup", "/v1/feed/webhook"];
const ATTRIBUTION = "Trust data: Lumi (lumitrades.io)";

export function feedTier(k: FeedKey, now: number): "free" | "credits" | "feed" | "feed_pro" {
  if ((k.plan === "feed" || k.plan === "feed_pro") && (k.plan_ends_at ?? 0) > now) return k.plan;
  return k.credits > 0 ? "credits" : "free";
}

/** Quota for n lookups: which period counts it and how many prepaid credits it consumes. */
export function quotaFor(k: FeedKey, used: number, n: number, now: number): { ok: boolean; period: string; allowance: number; creditsUsed: number } {
  const tier = feedTier(k, now);
  const planned = tier === "feed" || tier === "feed_pro";
  const period = planned ? `term:${k.plan_ends_at}` : monthKey(now);
  const allowance = planned ? FEED_LIMITS.included[tier] : FEED_LIMITS.freePerMonth;
  const over = Math.max(0, used + n - Math.max(allowance, used));
  const creditsUsed = Math.min(n, over);
  return { ok: creditsUsed <= k.credits, period, allowance, creditsUsed };
}

function licenseHtml(base: string): string {
  const li = FEED_LICENSE.terms.map((t) => `<li>${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`).join("");
  const plans = ["feed_credits", "feed", "feed_pro"].map((id) => { const p = PLANS[id as PlanId]; return `<tr><td>${p.name}</td><td>$${p.usd}${p.days ? ` / ${p.days} days` : ""}</td><td>${p.summary}</td></tr>`; }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${FEED_LICENSE.title} · Lumi</title><link rel="icon" href="https://lumitrades.io/assets/favicon-32.png">
<style>:root{color-scheme:dark}body{margin:0;background:#070a12;color:#e5e7eb;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:40px 22px 60px}header{display:flex;align-items:center;gap:14px;margin-bottom:26px}
header img{width:44px;height:44px;border-radius:10px}.brand{font-weight:700;font-size:20px}
h1{font-size:30px;margin:8px 0 6px;background:linear-gradient(90deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;background-clip:text;color:transparent}
.muted{color:#9ca3af}.card{background:#0e1424;border:1px solid #1f2a44;border-radius:14px;padding:20px 22px;margin:18px 0}
li{margin:8px 0}a{color:#93c5fd}table{width:100%;border-collapse:collapse}td{padding:8px 6px;border-top:1px solid #1f2a44;vertical-align:top}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;background:linear-gradient(90deg,#3b82f6,#8b5cf6);color:#fff;font-size:12px;font-weight:600}
footer{margin-top:30px;font-size:14px}</style></head><body><div class="wrap">
<header><a href="https://lumitrades.io"><img src="https://lumitrades.io/assets/apple-touch-icon.png" alt="Lumi"></a><div><div class="brand">Lumi</div><div class="muted">x402 trust data</div></div></header>
<span class="pill">Licence terms</span><h1>${FEED_LICENSE.title}</h1><p class="muted">Version ${FEED_LICENSE.version}</p>
<div class="card"><ol>${li}</ol></div>
<div class="card"><b>Plans</b> (x402 on XRPL XRP/RLUSD/USDC or Base USDC; no auto-renew)<table>
<tr><td>Free</td><td>$0</td><td>${FEED_LIMITS.freePerMonth.toLocaleString("en-US")} lookups / month per key (wallet signature signup); answer-only.</td></tr>${plans}</table></div>
<div class="card"><b>Attribution.</b> Show <code>${ATTRIBUTION}</code> where results are displayed. vet402 data: ${VET402.source}, ${VET402.license} (<a href="${VET402.license_url}">licence</a>), cite as in each result's <code>attribution</code> field.</div>
<p>API: <a href="${base}/v1/feed">${base}/v1/feed</a> · Methodology: <a href="${base}/v1/trust/methodology">${base}/v1/trust/methodology</a></p>
<footer class="muted">Observations, not ratings or advice. Not financial advice. · <a href="https://lumitrades.io">lumitrades.io</a></footer>
</div></body></html>`;
}

export function createFeed(deps: CommerceDeps, relationships: (payTos: string[], base: string) => Promise<Map<string, Record<string, unknown>>>) {
  const { store, now } = deps;

  function doc(base: string) {
    return {
      kind: "lumi_trust_feed",
      summary: "Licensed, keyed access to Lumi's x402 trust observations (quote checks, test-buys, payTo census) for facilitators, wallets and agent frameworks.",
      plans: [
        { plan: "free", price_usd: "0", lookups: `${FEED_LIMITS.freePerMonth}/month`, evidence: "answer-only", rate_limit_per_min: FEED_LIMITS.perMinute.free, signup: `GET ${base}/v1/feed/challenge?wallet=<address>, sign it, POST ${base}/v1/feed/keys` },
        { plan: "feed_credits", price_usd: PLANS.feed_credits.usd, lookups: `${FEED_LIMITS.creditsPerPurchase} prepaid, never expire`, evidence: "answer-only", rate_limit_per_min: FEED_LIMITS.perMinute.credits, pay: `${base}/v1/feed/credits?key_id=<key id>` },
        { plan: "feed", price_usd: PLANS.feed.usd, term_days: 30, lookups: `${FEED_LIMITS.included.feed.toLocaleString("en-US")} per term`, evidence: "full (tx hashes, receipts)", delta: true, rate_limit_per_min: FEED_LIMITS.perMinute.feed, pay: `${base}/v1/feed/subscribe/feed?key_id=<key id> (omit key_id to get a new key)` },
        { plan: "feed_pro", price_usd: PLANS.feed_pro.usd, term_days: 30, lookups: `${FEED_LIMITS.included.feed_pro.toLocaleString("en-US")} per term`, evidence: "full (tx hashes, receipts)", delta: true, snapshot: true, webhooks: true, rate_limit_per_min: FEED_LIMITS.perMinute.feed_pro, pay: `${base}/v1/feed/subscribe/feed_pro?key_id=<key id>` },
        { plan: PLATFORM_LICENCE.id, price_from_usd: PLATFORM_LICENCE.from_usd, term_days: PLATFORM_LICENCE.term_days, how_to_buy: `contact ${PLATFORM_LICENCE.contact}`, summary: PLATFORM_LICENCE.summary },
      ],
      free_tier_terms: PLATFORM_LICENCE.free_tier_terms,
      metering: "Lookups beyond the included amount use prepaid credits ($1.50 per 1,000). Without credits the request is refused (HTTP 429) and nothing is charged.",
      auth: "Authorization: Bearer <api key> (or X-Lumi-Key). Keys are shown once; Lumi stores only a SHA-256 hash.",
      endpoints: {
        lookup: `POST ${base}/v1/feed/lookup {items:[{url}|{payTo}], max ${FEED_LIMITS.maxBatch}} (also GET ?url= or ?payTo=)`,
        delta: `GET ${base}/v1/feed/delta?since=<ISO time>&after_id=<id> (Feed, Feed Pro): status changes (quote validity, pays listed payTo, price match)`,
        snapshot: `GET ${base}/v1/feed/snapshot?cursor=<id> (Feed Pro): paginated full catalog export, licensed`,
        webhook: `POST ${base}/v1/feed/webhook {url} (Feed Pro): status-change webhooks, HMAC-signed`,
        usage: `GET ${base}/v1/feed/usage`,
      },
      license: `${base}/v1/feed/license`,
      attribution: { lumi: ATTRIBUTION, vet402: `${VET402.source}, ${VET402.license}` },
      auto_renew: false,
      disclaimer: "Dated observations, not ratings or advice. Not financial advice.",
    };
  }

  async function keyFor(request: Request): Promise<FeedKey | null> {
    const t = bearer(request);
    if (!t || !t.startsWith("lumi_fk_")) return null;
    return store.keyByHash(await sha256(t));
  }
  // A key that was sent but is malformed or unknown gets invalid_api_key, not api_key_required
  const needKey = (base: string, request?: Request) => request && bearer(request)
    ? json(401, { error: "invalid_api_key", detail: "The API key is malformed, unknown or was rotated.", signup: `${base}/v1/feed`, note: "Not charged." }, { ...NO_STORE, "WWW-Authenticate": 'Bearer error="invalid_token"' })
    : json(401, { error: "api_key_required", hint: "Authorization: Bearer <api key>", signup: `${base}/v1/feed`, note: "Not charged." }, { ...NO_STORE, "WWW-Authenticate": "Bearer" });

  async function newKey(wallet: string | null, network: string | null): Promise<{ key: FeedKey; secret: string }> {
    const secret = `lumi_fk_${randHex(24)}`;
    const key: FeedKey = {
      id: `fk_${randHex(10)}`, key_hash: await sha256(secret), wallet, wallet_lc: wallet?.toLowerCase() ?? null, network, plan: "free", plan_ends_at: null, credits: 0,
      is_test: isTestWallet(wallet, deps.extraTestWallets), webhook_url: null, webhook_secret: null, webhook_cursor: 0, created_at: now(), rotated_at: null,
    };
    return { key, secret };
  }

  async function signup(request: Request, base: string) {
    const b = await readJson(request);
    if (!b) return bad("invalid_json");
    const p = await verifyProof(deps.cfg.invoiceSecret, "feed-key", b, now(), deps.fetch, deps.xrplRpc);
    if (!p.ok) return json(p.reason === "ledger_unavailable_retry" ? 503 : 403, { error: "wallet_proof_failed", reason: p.reason, challenge: `${base}/v1/feed/challenge?wallet=<address>` }, NO_STORE);
    // One key per wallet; signing again rotates the secret (single-use nonce: the nonce is the rotation marker).
    const existing = await store.keyByWallet(p.address.toLowerCase());
    if (existing) {
      if (existing.rotated_at && existing.rotated_at > now() - 60_000) return json(429, { error: "rotated_recently" }, NO_STORE);
      const secret = `lumi_fk_${randHex(24)}`;
      await store.updateKey(existing.id, { key_hash: await sha256(secret), rotated_at: now() });
      return json(200, { key_id: existing.id, api_key: secret, rotated: true, plan: feedTier(existing, now()), note: "The previous secret no longer works. Shown once; Lumi stores only a hash." }, NO_STORE);
    }
    const { key, secret } = await newKey(p.address, p.network);
    await store.addKey(key);
    return json(201, { key_id: key.id, api_key: secret, plan: "free", lookups_per_month: FEED_LIMITS.freePerMonth, ...(key.is_test ? { test: true } : {}), license: `${base}/v1/feed/license`, note: "Shown once; Lumi stores only a hash. By using the key you accept the licence terms." }, NO_STORE);
  }

  /** Meter n lookups for this key (rate limit + quota). Returns a refusal or null. */
  async function meter(k: FeedKey, n: number, base: string): Promise<Response | null> {
    const t = now();
    const q0 = quotaFor(k, 0, n, t);
    const u = await store.usage(k.id, q0.period);
    const minute = Math.floor(t / 60_000);
    const tier = feedTier(k, t);
    if (u && u.minute === minute && u.minute_requests >= FEED_LIMITS.perMinute[tier]) return json(429, { error: "rate_limited", limit_per_minute: FEED_LIMITS.perMinute[tier], note: "Not charged." }, { ...NO_STORE, "Retry-After": "60" });
    const q = quotaFor(k, u?.lookups ?? 0, n, t);
    if (!q.ok) {
      return json(429, { error: "quota_exhausted", period: q.period, included: q.allowance, used: u?.lookups ?? 0, credits: k.credits, buy_credits: `${base}/v1/feed/credits?key_id=${k.id}`, upgrade: `${base}/v1/feed/subscribe/feed?key_id=${k.id}`, note: "Not charged." }, NO_STORE);
    }
    await store.bumpUsage(k.id, q.period, n, minute);
    if (q.creditsUsed) await store.addCredits(k.id, -q.creditsUsed);
    return null;
  }

  type Item = { url?: string; payTo?: string };
  async function lookupItems(items: Item[], full: boolean, base: string) {
    const t = now();
    const urls = items.filter((i) => i.url).flatMap((i) => urlVariants(i.url!));
    const pays = items.filter((i) => i.payTo).map((i) => i.payTo!.trim().toLowerCase());
    const [byUrl, byPay] = await Promise.all([deps.catalogStore.byResources(urls), deps.catalogStore.byPayTos(pays, 200)]);
    const rows = [...new Map([...byUrl, ...byPay].map((r) => [r.resource, r])).values()];
    const res = rows.map((r) => r.resource);
    const [buys, vet] = await Promise.all([
      res.length ? deps.catalogStore.buysFor(res.slice(0, 90)) : Promise.resolve([]),
      deps.evidence && res.length ? deps.evidence.vet402For(res.slice(0, 90)).catch(() => []) : Promise.resolve([]),
    ]);
    const vmap = new Map(vet.map((v) => [v.resource_key, v]));
    const vetFor = (r: CatalogRow) => vmap.get(r.resource) ?? vmap.get(r.resource.replace(/^https?:\/\//, ""));
    const views = rows.map((r) => {
      const b = buys.filter((x) => x.resource === r.resource);
      const v: Record<string, any> = full ? catalogView(r, b, undefined, t) : catalogFreeView(r, b, t);
      const vt = vetFor(r);
      if (vt) v.third_party = { vet402: { ...vet402View(vt, !full), attribution: VET402.cite(iso(vt.retrieved_at)!.slice(0, 10)) } };
      return v;
    });
    if (full && deps.receipts) {
      try {
        const ps = views.flatMap((v) => (Array.isArray(v.purchases) ? v.purchases : []));
        const rc = await deps.receipts.byTx(ps.map((p: any) => p.tx_hash));
        for (const p of ps) { const r = rc.get(p.tx_hash); if (r) p.receipt = r; }
      } catch { /* optional */ }
    }
    const allPayTos = [...new Set([...items.map((i) => i.payTo).filter((x): x is string => !!x), ...views.flatMap((v) => (v.pay_to ?? []).map((p: any) => String(p.pay_to)))])];
    const rel = await relationships(allPayTos, base).catch(() => new Map());
    const out = items.map((i) => {
      let matches: Record<string, any>[] = [];
      if (i.url) { const vs = new Set(urlVariants(i.url)); matches = views.filter((v) => vs.has(v.resource)); }
      else if (i.payTo) { const p = i.payTo.trim().toLowerCase(); matches = views.filter((v) => (v.pay_to ?? []).some((x: any) => String(x.pay_to).toLowerCase() === p)).slice(0, 25); }
      const curated = VENDORS.filter((v) => (i.url && v.endpoints.some((e) => urlVariants(i.url!).includes(e.url))) || (i.payTo && [...v.pay_to.xrpl, ...(v.pay_to.evm ?? [])].some((a) => a.toLowerCase() === i.payTo!.trim().toLowerCase())))
        .slice(0, 3).map((v) => ({ vendor_id: v.id, name: v.name, page: `${base}/v1/trust/vendors/${v.id}` }));
      const payTos = new Set([...(i.payTo ? [i.payTo.trim().toLowerCase()] : []), ...matches.flatMap((m) => (m.pay_to ?? []).map((p: any) => String(p.pay_to).toLowerCase()))]);
      const cr = [...payTos].map((p) => rel.get(p)).filter(Boolean);
      return { query: i, observed: matches.length > 0 || curated.length > 0, entries: matches, ...(curated.length ? { curated } : {}), ...(cr.length ? { commercial_relationship: cr } : {}) };
    });
    return out;
  }

  function parseItems(raw: unknown): Item[] | string {
    if (!Array.isArray(raw) || !raw.length) return "items: non-empty array of {url} or {payTo}";
    if (raw.length > FEED_LIMITS.maxBatch) return `items: at most ${FEED_LIMITS.maxBatch} per request`;
    const out: Item[] = [];
    for (const x of raw) {
      const url = typeof x === "string" ? x : x?.url;
      const payTo = x?.payTo ?? x?.pay_to;
      if (typeof url === "string" && /^https?:\/\//i.test(url) && url.length <= 500) out.push({ url });
      else if (typeof payTo === "string" && (XRPL_ADDR_RE.test(payTo.trim()) || EVM_ADDR_RE.test(payTo.trim()))) out.push({ payTo: payTo.trim() });
      else return "each item: {url: 'https://…'} or {payTo: XRPL r-address | 0x address}";
    }
    return out;
  }

  async function lookup(request: Request, url: URL, base: string) {
    const k = await keyFor(request);
    if (!k) return needKey(base, request);
    let items: Item[] | string;
    if (request.method === "POST") {
      const b = await readJson(request, 64_000);
      items = parseItems(b?.items);
    } else {
      const u = url.searchParams.get("url"), p = url.searchParams.get("payTo") ?? url.searchParams.get("pay_to");
      items = parseItems(u ? [{ url: u }] : p ? [{ payTo: p }] : []);
    }
    if (typeof items === "string") return bad("invalid_items", items);
    const deny = await meter(k, items.length, base);
    if (deny) return deny;
    const tier = feedTier(k, now());
    const full = tier === "feed" || tier === "feed_pro";
    const results = await lookupItems(items, full, base);
    return json(200, { kind: "lumi_feed_lookup", generated_at: iso(now()), tier, evidence: full ? "full" : "answer-only", results, attribution: ATTRIBUTION, license: `${base}/v1/feed/license` }, NO_STORE);
  }

  async function delta(request: Request, url: URL, base: string) {
    const k = await keyFor(request);
    if (!k) return needKey(base, request);
    const tier = feedTier(k, now());
    if (tier !== "feed" && tier !== "feed_pro") return json(403, { error: "plan_required", detail: "The delta feed is part of Feed and Feed Pro.", pay: `${base}/v1/feed/subscribe/feed?key_id=${k.id}`, note: "Not charged." }, NO_STORE);
    const since = Date.parse(url.searchParams.get("since") ?? "") || now() - DAY_MS;
    const after = Math.max(0, Number(url.searchParams.get("after_id") ?? 0) || 0);
    const deny = await meter(k, 1, base);
    if (deny) return deny;
    const rows = await store.changesSince(since, after, 500);
    return json(200, { kind: "lumi_feed_delta", since: iso(since), changes: rows.map((c) => ({ id: c.id, at: iso(c.ts), resource: c.resource, field: c.field, old: c.old, new: c.new })), next_after_id: rows.length ? rows[rows.length - 1].id : after, attribution: ATTRIBUTION }, NO_STORE);
  }

  async function snapshot(request: Request, url: URL, base: string) {
    const k = await keyFor(request);
    if (!k) return needKey(base, request);
    if (feedTier(k, now()) !== "feed_pro") return json(403, { error: "feed_pro_required", detail: "Full snapshots are licensed to Feed Pro.", pay: `${base}/v1/feed/subscribe/feed_pro?key_id=${k.id}`, note: "Not charged." }, NO_STORE);
    const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
    const deny = await meter(k, 1, base);
    if (deny) return deny;
    const rows = await deps.catalogStore.range(cursor, 200);
    const t = now();
    const buys = rows.length ? await deps.catalogStore.buysFor(rows.map((r) => r.resource).slice(0, 90)) : [];
    const max = await deps.catalogStore.maxId();
    const next = cursor + 200 <= max ? cursor + 200 : null;
    return json(200, {
      kind: "lumi_feed_snapshot", cursor, next_cursor: next, generated_at: iso(t),
      entries: rows.map((r) => catalogView(r, buys.filter((b) => b.resource === r.resource), undefined, t)),
      license: { terms: `${base}/v1/feed/license`, summary: "Licensed to this key for internal use during the term. No resale or redistribution of the raw data. Attribution required where shown.", attribution: ATTRIBUTION },
    }, NO_STORE);
  }

  async function webhook(request: Request, base: string) {
    const k = await keyFor(request);
    if (!k) return needKey(base, request);
    if (feedTier(k, now()) !== "feed_pro") return json(403, { error: "feed_pro_required", note: "Not charged." }, NO_STORE);
    const b = await readJson(request);
    const u = b?.url === null ? null : safeHttpsUrl(b?.url);
    if (b?.url !== null && !u) return bad("invalid_url", "https URL with a public DNS name (or null to remove).");
    const secret = u ? `lumi_whs_${randHex(24)}` : null;
    const last = (await store.changesSince(0, 0, 1)).length ? (await store.changesSince(now() - 60_000, 0, 500)).slice(-1)[0]?.id ?? k.webhook_cursor : k.webhook_cursor;
    await store.updateKey(k.id, { webhook_url: u, webhook_secret: secret, webhook_cursor: Math.max(k.webhook_cursor, last ?? 0) });
    return json(200, { webhook_url: u, ...(secret ? { webhook_secret: secret, signature: "X-Lumi-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>" } : {}), note: "Status changes are pushed by the 30-minute cron (batched)." }, NO_STORE);
  }

  async function usage(request: Request, base: string) {
    const k = await keyFor(request);
    if (!k) return needKey(base, request);
    const t = now();
    const q = quotaFor(k, 0, 0, t);
    const u = await store.usage(k.id, q.period);
    return json(200, { key_id: k.id, tier: feedTier(k, t), plan: k.plan, plan_ends_at: iso(k.plan_ends_at), period: q.period, included: q.allowance, used: u?.lookups ?? 0, requests: u?.requests ?? 0, credits: k.credits, rate_limit_per_minute: FEED_LIMITS.perMinute[feedTier(k, t)], ...(k.is_test ? { test: true } : {}) }, NO_STORE);
  }

  async function subscribe(request: Request, url: URL, plan: PlanId, base: string, ctx?: WaitUntil) {
    const kid = url.searchParams.get("key_id") ?? "";
    const paid = !!(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT));
    const k = KEY_ID_RE.test(kid) ? await store.keyById(kid) : null;
    const resourceUrl = `${base}${PLANS[plan].path}`;
    if (kid && !k) {
      if (paid) return bad("unknown_key_id", "Unknown key_id; the payment was not settled.");
      const q = planQuote(deps.cfg, plan, "none", PLANS[plan].usd, resourceUrl, false);
      q.note = "List price. key_id is unknown: pass a key id from POST /v1/feed/keys, or omit key_id (Feed/Feed Pro only) to receive a new key with the paid response.";
      return paymentRequiredResponse(deps.cfg, q, "PAYMENT-SIGNATURE header is required");
    }
    if (!k && plan === "feed_credits") {
      if (paid) return bad("key_id_required", "Credits attach to an existing key: ?key_id=<key id>. The payment was not settled.");
      const q = planQuote(deps.cfg, plan, "none", PLANS[plan].usd, resourceUrl, false);
      q.note = `List price. Add ?key_id=<key id> (free key: ${base}/v1/feed). A payment without a key id is refused before settlement.`;
      return paymentRequiredResponse(deps.cfg, q, "PAYMENT-SIGNATURE header is required");
    }
    const test = !!k?.is_test;
    const usd = planPriceUsd(plan, test, deps.testPriceUsd);
    const quote = planQuote(deps.cfg, plan, k?.id ?? "new", usd, k ? `${resourceUrl}?key_id=${k.id}` : resourceUrl, test);
    return requirePayment(request, deps.cfg, deps.paywall(ctx), quote, async (s: Settlement, req: PaymentRequirements) => {
      const t = now();
      let key = k ? await store.keyById(k.id) : null;
      let secret: string | undefined;
      if (!key) {
        const n = await newKey(s.payer ?? null, s.network);
        await store.addKey(n.key);
        key = n.key;
        secret = n.secret;
      }
      const ins = await store.addPayment({ tx: s.transaction || `unknown_${randHex(8)}`, key_id: key.id, product: plan, usd: Number(usd), is_test: test || key.is_test, network: s.network, asset: assetLabel(req), amount: String(req.amount), payer: s.payer ?? null, ts: t });
      if (ins === "inserted") {
        if (plan === "feed_credits") await store.addCredits(key.id, FEED_LIMITS.creditsPerPurchase);
        else {
          const sameActive = key.plan === plan && (key.plan_ends_at ?? 0) > t;
          const ends = (sameActive ? key.plan_ends_at! : t) + 30 * DAY_MS;
          await store.updateKey(key.id, { plan: plan as FeedKey["plan"], plan_ends_at: ends });
        }
      }
      const after = (await store.keyById(key.id))!;
      return json(201, {
        paid: true, product: PLANS[plan].name, key_id: after.id, ...(secret ? { api_key: secret, note: "New key: shown once; Lumi stores only a hash." } : {}),
        price_usd: usd, ...(after.is_test || test ? { test: true } : {}), tier: feedTier(after, t), plan_ends_at: iso(after.plan_ends_at), credits: after.credits, auto_renew: false,
        renew: `${resourceUrl}?key_id=${after.id}`, license: `${base}/v1/feed/license`,
      }, NO_STORE);
    });
  }

  async function owner() {
    const [keys, pays, use] = await Promise.all([store.keys(100), store.payments(50), store.usageFor("*")]);
    const t = now();
    return json(200, {
      kind: "owner_feed",
      keys: keys.map((k) => ({ key_id: k.id, wallet: k.wallet, tier: feedTier(k, t), plan: k.plan, plan_ends_at: iso(k.plan_ends_at), credits: k.credits, test: k.is_test, webhook: !!k.webhook_url, created_at: iso(k.created_at),
        usage: use.filter((u) => u.key_id === k.id).map((u) => ({ period: u.month, lookups: u.lookups, requests: u.requests })) })),
      payments: pays.map((p) => ({ ...p, ts: iso(p.ts) })),
    }, NO_STORE);
  }

  /** Cron: push recent status changes to Feed Pro webhooks (max 5 keys x 200 changes per run). */
  async function cron() {
    const t = now();
    const keys = (await store.webhookKeys(t)).slice(0, 5);
    let pushed = 0;
    for (const k of keys) {
      const rows = await store.changesSince(0, k.webhook_cursor, 200);
      if (!rows.length || !k.webhook_url || !k.webhook_secret) continue;
      const body = JSON.stringify({ type: "lumi.feed.status_changes", key_id: k.id, changes: rows.map((c) => ({ id: c.id, at: iso(c.ts), resource: c.resource, field: c.field, old: c.old, new: c.new })), attribution: ATTRIBUTION });
      const ts = Math.floor(t / 1000);
      try {
        const r = await deps.fetch(k.webhook_url, { method: "POST", headers: { "Content-Type": "application/json", "X-Lumi-Signature": `t=${ts},v1=${await hmacHex(k.webhook_secret, `${ts}.${body}`)}` }, body, signal: AbortSignal.timeout(8000), redirect: "manual" });
        if (r.ok) { await store.updateKey(k.id, { webhook_cursor: rows[rows.length - 1].id! }); pushed += rows.length; }
      } catch { /* retried next run */ }
    }
    return { webhook_changes_pushed: pushed };
  }

  async function handle(request: Request, path: string, url: URL, base: string, ctx?: WaitUntil): Promise<Response | null> {
    const m = request.method;
    const get = m === "GET" || m === "HEAD";
    if (path === "/v1/feed" && get) return json(200, doc(base), { "Cache-Control": "public, max-age=600" });
    if (path === "/v1/feed/license" && get) {
      if ((request.headers.get("Accept") ?? "").includes("application/json") && !(request.headers.get("Accept") ?? "").includes("text/html")) return json(200, { ...FEED_LICENSE, html: `${base}/v1/feed/license` }, { "Cache-Control": "public, max-age=3600" });
      return new Response(licenseHtml(base), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" } });
    }
    if (path === "/v1/feed/challenge" && get) {
      const w = (url.searchParams.get("wallet") ?? "").trim();
      const c = await makeChallenge(deps.cfg.invoiceSecret, "feed-key", w, now());
      if (!c) return bad(w ? "invalid_wallet" : "wallet_required", "?wallet=<XRPL r-address or Base 0x address>");
      return json(200, { ...c, sign: c.network === "xrpl:0" ? "ripple-keypairs sign(utf8 hex of message); send public_key too" : "EIP-191 personal_sign(message)", next: `POST ${base}/v1/feed/keys {message, signature, public_key?}` }, NO_STORE);
    }
    if (path === "/v1/feed/keys") return m === "POST" ? signup(request, base) : json(405, { error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    if (path === "/v1/feed/lookup" && (get || m === "POST")) return lookup(request, url, base);
    if (path === "/v1/feed/delta" && get) return delta(request, url, base);
    if (path === "/v1/feed/snapshot" && get) return snapshot(request, url, base);
    if (path === "/v1/feed/webhook") return m === "POST" ? webhook(request, base) : json(405, { error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    if (path === "/v1/feed/usage" && get) return usage(request, base);
    if (path === "/v1/feed/credits" && get) return subscribe(request, url, "feed_credits", base, ctx);
    const sub = path.match(/^\/v1\/feed\/subscribe\/([^/]+)$/);
    if (sub && get) {
      if ((FEED_PLANS as string[]).includes(sub[1])) return subscribe(request, url, sub[1] as PlanId, base, ctx);
      if (/[{}<>:[\]$]/.test(decodeURIComponent(sub[1]))) return bad("path_template_not_filled", "Use feed or feed_pro.", { example: `${base}/v1/feed/subscribe/feed` });
      return json(404, { error: "unknown_plan", plans: FEED_PLANS }, NO_STORE);
    }
    if (path === "/v1/owner/feed" && get) {
      if (!(await deps.isOwner(request))) return json(401, { error: "owner_key_required" }, { ...NO_STORE, "WWW-Authenticate": "Bearer" });
      return owner();
    }
    return null;
  }

  return { handle, cron, doc };
}
