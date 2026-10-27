/**
 * "Tested by Lumi" badge for x402 sellers (owner-approved Oct 23 2026).
 *
 *   GET /trust/v/{key}     public result page (latest dated test-buys) the badge links to
 *   GET /badge, /badge/{key}.svg|.json   RETIRED (approved Oct 23 2026): 301 to the signed, earned-only badge
 *                          GET /v1/badge (docs) and /v1/badge/{key}.svg|.json (app.ts), query string kept.
 *
 * key = a curated vendor id (e.g. printmoneylab) or the exact host of the service (e.g. api.example.com).
 *
 * Rules:
 * - Only real stored results (curated `observations` + catalog `catalog_buys`); no result = "not yet tested".
 * - Factual and dated, never an endorsement or guarantee. Paying Lumi (seller monitoring) never changes a result; a
 *   commercial relationship is disclosed on the page/JSON, never on the badge itself.
 * - One key = one vendor's summary (at most BADGE_TESTS tests). No listing, paging, search or wildcard.
 * - D1 budget: ZERO writes on this path (no rate-limit counters, no traffic rows, no pricer memo; app.fetch routes
 *   these paths before anything else) and at most 2 indexed reads per key (3 on the page/JSON with the disclosure
 *   lookup). Responses are edge-cached for an hour (index.ts, Cache API keyed on the lowercased path only, so query
 *   strings cannot bust the cache) plus a small in-isolate memo.
 */
import { vendorById, VENDORS, type Vendor } from "../vendors";
import { CONTACT_EMAIL } from "./index";
import { deliveryState, inconclusiveReason, INCONCLUSIVE_REASONS, type DeliveryState } from "./delivery";
import type { ObservationRow } from "./store";
import type { BuyRow } from "./catalog";
import { BADGE_WINDOW_DAYS, testedBadgeRules, testedBadgeSummary } from "./check";
import { COUNTING_TEXT } from "../commerce/counting";

export const BADGE_TESTS = 10;
export const BADGE_MAX_AGE = 3600;
export const BADGE_CACHE_CONTROL = `public, max-age=${BADGE_MAX_AGE}, s-maxage=${BADGE_MAX_AGE}`;
export const HOW_IT_WORKS = "https://lumitrades.io/how-it-works/";
const MEMO_MS = 10 * 60_000;
const MEMO_MAX = 256;

/** Paths served by the badge handler (index.ts edge-caches exactly these). */
export const BADGE_PATH_RE = /^\/trust\/v\/[^/]{1,300}\/?$/i;

/** Legacy badge paths, retired with a 301 to the signed /v1/badge route. */
export const LEGACY_BADGE_RE = /^\/badge(?:\/([^/]{1,300})\.(svg|json))?\/?$/i;
/** Longest query string carried over by the legacy redirect; a longer one is dropped rather than echoed. */
export const LEGACY_BADGE_MAX_QUERY = 1024;

/** 301 from /badge[/{key}.svg|.json] to /v1/badge[/{key}.svg|.json] on the same origin, keeping the query; else null. */
export function legacyBadgeRedirect(url: URL): Response | null {
  const m = LEGACY_BADGE_RE.exec(url.pathname);
  if (!m) return null;
  const path = m[1] ? `/v1/badge/${m[1]}.${m[2].toLowerCase()}` : "/v1/badge";
  const q = url.search.length > 1 && url.search.length <= LEGACY_BADGE_MAX_QUERY + 1 ? url.search : "";
  return new Response(null, {
    status: 301,
    headers: { Location: `${url.origin}${path}${q}`, "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*", "X-Lumi-Deprecated": "legacy /badge retired; use /v1/badge" },
  });
}

const VENDOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export type Verdict = DeliveryState | "not_tested";
export type Chain = "XRPL" | "Base" | "Stellar";

export interface BadgeTest {
  at: string;
  date: string; // MM-DD-YYYY (UTC)
  endpoint: string;
  network: string;
  chain: Chain | null;
  verdict: DeliveryState;
  verdict_text: string;
  http_status: number | null;
  inconclusive_reason?: string;
  corrected_at?: string;
}

export interface BadgeSummary {
  key: string;
  kind: "vendor" | "host" | "self" | "unknown" | "invalid";
  name: string;
  vendor_id: string | null;
  homepage: string | null;
  verdict: Verdict;
  verdict_text: string;
  latest: BadgeTest | null;
  chain: Chain | null;
  tests: BadgeTest[];
  pay_tos: string[];
}

export interface BadgeDeps {
  now: () => number;
  latestObservations(vendorIds: string[], limit: number): Promise<ObservationRow[]>;
  buysByDomain(domain: string, limit: number): Promise<BuyRow[]>;
  /** Read-only disclosure lookup (seller monitoring plans), page/JSON only. */
  relationships?(payTos: string[]): Promise<Record<string, unknown>[]>;
  selfDomains: string[];
  log?: (e: Record<string, unknown>) => void;
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  delivered: "delivered",
  not_delivered: "not delivered",
  inconclusive: "inconclusive",
  not_tested: "not yet tested",
};
/** green / red / gray / neutral */
export const VERDICT_COLOR: Record<Verdict | "self" | "invalid", string> = {
  delivered: "#2e8540",
  not_delivered: "#c62828",
  inconclusive: "#7a7a7a",
  not_tested: "#5b6b7c",
  self: "#5b6b7c",
  invalid: "#5b6b7c",
};

export function chainOf(network: string | null | undefined): Chain | null {
  if (!network) return null;
  if (network.startsWith("xrpl:")) return "XRPL";
  if (network === "eip155:8453" || network === "base") return "Base";
  if (network.startsWith("stellar:")) return "Stellar";
  return null;
}

/** MM-DD-YYYY in UTC. */
export function usDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${d.getUTCFullYear()}`;
}

/** Normalised key, or null if it is neither a vendor id nor a host name. */
export function normalizeKey(raw: string): string | null {
  let k = raw;
  try { k = decodeURIComponent(raw); } catch { return null; }
  k = k.trim().toLowerCase().replace(/\.$/, "");
  if (VENDOR_ID_RE.test(k) || HOST_RE.test(k)) return k;
  return null;
}

function hostOf(u: string): string | null {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

/** Curated vendors by the hosts of their endpoints and homepage (in memory, no D1). */
let hostIndex: Map<string, Vendor[]> | undefined;
export function curatedByHost(host: string): Vendor[] {
  if (!hostIndex) {
    hostIndex = new Map();
    for (const v of VENDORS) {
      const hs = new Set([hostOf(v.homepage), ...v.endpoints.map((e) => hostOf(e.url))].filter((h): h is string => !!h));
      for (const h of hs) hostIndex.set(h, [...(hostIndex.get(h) ?? []), v]);
    }
  }
  return hostIndex.get(host) ?? [];
}

type Row = { ts: number; endpoint: string; network: string; tx_hash: string; http_status: number | null; data_returned: boolean; inconclusive?: string | null; corrected_at?: number | null; pay_to?: string };

function testView(r: Row): BadgeTest {
  const verdict = deliveryState(r);
  const reason = inconclusiveReason(r);
  return {
    at: new Date(r.ts).toISOString(),
    date: usDate(r.ts),
    endpoint: r.endpoint,
    network: r.network,
    chain: chainOf(r.network),
    verdict,
    verdict_text: VERDICT_TEXT[verdict],
    http_status: r.http_status ?? null,
    ...(reason ? { inconclusive_reason: reason } : {}),
    ...(r.corrected_at ? { corrected_at: new Date(r.corrected_at).toISOString() } : {}),
  };
}

export function createBadges(deps: BadgeDeps) {
  const memo = new Map<string, { at: number; s: BadgeSummary }>();

  async function load(key: string): Promise<BadgeSummary> {
    const empty = (kind: BadgeSummary["kind"], name: string, extra: Partial<BadgeSummary> = {}): BadgeSummary => ({
      key, kind, name, vendor_id: null, homepage: null, verdict: "not_tested", verdict_text: VERDICT_TEXT.not_tested, latest: null, chain: null, tests: [], pay_tos: [], ...extra,
    });
    if (deps.selfDomains.includes(key) || key === "lumi" || key === "lumitrades") return empty("self", "Lumi Trades API");
    let vendors: Vendor[] = [];
    let rows: Row[] = [];
    let kind: BadgeSummary["kind"] = "unknown";
    const v = vendorById(key);
    if (v) {
      vendors = [v];
      kind = "vendor";
      rows = (await deps.latestObservations([v.id], BADGE_TESTS)).map((o) => ({ ...o }));
    } else if (key.includes(".")) {
      kind = "host";
      vendors = curatedByHost(key);
      const [obs, buys] = await Promise.all([
        vendors.length ? deps.latestObservations(vendors.map((x) => x.id), BADGE_TESTS) : Promise.resolve([] as ObservationRow[]),
        deps.buysByDomain(key, BADGE_TESTS),
      ]);
      rows = [...obs.map((o) => ({ ...o })), ...buys.map((b) => ({ ...b, endpoint: b.resource }))];
    } else {
      return empty("unknown", key);
    }
    // Newest first; one entry per payment (a buy can be stored in both tables).
    const seen = new Set<string>();
    rows = rows.sort((a, b) => b.ts - a.ts).filter((r) => (seen.has(r.tx_hash) ? false : (seen.add(r.tx_hash), true))).slice(0, BADGE_TESTS);
    const tests = rows.map(testView);
    const latest = tests[0] ?? null;
    const name = vendors.length === 1 ? vendors[0].name : key;
    const payTos = [...new Set([...vendors.flatMap((x) => [...x.pay_to.xrpl, ...(x.pay_to.evm ?? [])]), ...rows.map((r) => r.pay_to).filter((p): p is string => !!p)])].slice(0, 20);
    if (!latest && kind === "host" && !vendors.length) kind = "unknown";
    return {
      key, kind, name,
      vendor_id: vendors.length === 1 ? vendors[0].id : null,
      homepage: vendors.length === 1 ? vendors[0].homepage : null,
      verdict: latest ? latest.verdict : "not_tested",
      verdict_text: latest ? latest.verdict_text : VERDICT_TEXT.not_tested,
      latest,
      chain: latest?.chain ?? null,
      tests,
      pay_tos: payTos,
    };
  }

  async function summary(key: string): Promise<BadgeSummary> {
    const t = deps.now();
    const m = memo.get(key);
    if (m && t - m.at < MEMO_MS) return m.s;
    const s = await load(key);
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
    memo.set(key, { at: t, s });
    return s;
  }

  /** Handles /trust/v/{key} (and the legacy /badge redirects); null for any other path. GET/HEAD only. */
  async function handle(request: Request, base: string): Promise<Response | null> {
    const url = new URL(request.url);
    const legacy = LEGACY_BADGE_RE.test(url.pathname);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (!legacy && !BADGE_PATH_RE.test(path)) return null;
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) return text(405, "GET only.", "text/plain; charset=utf-8", { Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store" }, head);
    if (legacy) return legacyBadgeRedirect(url);
    const raw = path.match(/^\/trust\/v\/([^/]+)$/i)![1];
    const key = normalizeKey(raw);
    if (!key) {
      return jsonRes(400, { error: "invalid_key", detail: "key must be a Lumi vendor id (e.g. printmoneylab) or the exact host of your x402 service (e.g. api.example.com).", docs: `${base}/v1/badge` }, head);
    }
    let s: BadgeSummary;
    try {
      s = await summary(key);
    } catch (e) {
      deps.log?.({ event: "badge_error", error: String(e).slice(0, 200) });
      return text(503, "Lumi badge data is temporarily unavailable.", "text/plain; charset=utf-8", { "Cache-Control": "no-store", "Retry-After": "300" }, head);
    }
    const rel = deps.relationships && s.pay_tos.length ? await deps.relationships(s.pay_tos).catch(() => []) : [];
    return text(200, badgePage(s, base, rel), "text/html; charset=utf-8", { "Cache-Control": BADGE_CACHE_CONTROL, "Content-Security-Policy": "default-src 'none'; img-src 'self' https://api.lumitrades.io; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "Referrer-Policy": "no-referrer-when-downgrade" }, head);
  }

  return { handle, summary };
}

// ---------------------------------------------------------------- rendering

function text(status: number, body: string, type: string, headers: Record<string, string>, head: boolean): Response {
  return new Response(head ? null : body, { status, headers: { "Content-Type": type, ...headers } });
}
function jsonRes(status: number, body: unknown, head: boolean): Response {
  return text(status, JSON.stringify(body, null, 2), "application/json; charset=utf-8", { "Cache-Control": BADGE_CACHE_CONTROL, "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" }, head);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Right-hand text of the badge. */
export function badgeMessage(s: BadgeSummary): string {
  if (s.kind === "invalid") return "invalid key";
  if (s.kind === "self") return "Lumi (self, not tested)";
  if (!s.latest) return VERDICT_TEXT.not_tested;
  return [s.latest.verdict_text, s.latest.date, s.latest.chain].filter(Boolean).join(" · ");
}

/** Approximate Verdana 11px advance widths (px), as shields.io does; textLength pins the final width. */
function textWidth(t: string): number {
  let w = 0;
  for (const ch of t) {
    if (/[ilj.,:;'|!·]/.test(ch)) w += 3.6;
    else if (/[ -]/.test(ch)) w += ch === " " ? 3.9 : 4.6;
    else if (/[mwMW]/.test(ch)) w += 10.2;
    else if (/[A-Z]/.test(ch)) w += 7.6;
    else if (/[0-9]/.test(ch)) w += 7;
    else if (/[ftr]/.test(ch)) w += 4.4;
    else w += 6.6;
  }
  return Math.round(w);
}

export const BADGE_LABEL = "Tested by Lumi";

/** Legacy latest-verdict badge renderer. No longer routed (legacy /badge now 301s to the signed /v1/badge). */
export function badgeSvg(s: BadgeSummary): string {
  const label = BADGE_LABEL;
  const msg = badgeMessage(s);
  const color = s.kind === "self" ? VERDICT_COLOR.self : s.kind === "invalid" ? VERDICT_COLOR.invalid : VERDICT_COLOR[s.verdict];
  const lw = textWidth(label) + 10;
  const mw = textWidth(msg) + 10;
  const w = lw + mw;
  const title = s.kind === "invalid"
    ? "Tested by Lumi: invalid badge key. Use a Lumi vendor id or your service's host name."
    : s.latest
    ? `Tested by Lumi: latest paid test-buy ${s.latest.verdict_text} on ${s.latest.date}${s.latest.chain ? ` (${s.latest.chain})` : ""}. Factual, dated test result; not an endorsement or guarantee.`
    : s.kind === "self"
    ? "Lumi does not test or score its own API."
    : "Tested by Lumi: not yet tested. Lumi has no stored test result for this service.";
  // Unique ids so several badges inlined in one HTML document do not share a clip path / gradient.
  const id = `lb${w}${color.slice(1)}`;
  const t = (x: number, y: number, str: string, len: number, shadow: boolean) =>
    `<text${shadow ? ' aria-hidden="true" fill="#010101" fill-opacity=".3"' : ""} x="${x * 10}" y="${y}" transform="scale(.1)" textLength="${len * 10}">${esc(str)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(`${label}: ${msg}`)}"><title>${esc(title)}</title>` +
    `<linearGradient id="${id}s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="${id}r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#${id}r)"><rect width="${lw}" height="20" fill="#3a3f47"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#${id}s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
    t(lw / 2, 150, label, lw - 10, true) + t(lw / 2, 140, label, lw - 10, false) +
    t(lw + mw / 2, 150, msg, mw - 10, true) + t(lw + mw / 2, 140, msg, mw - 10, false) +
    `</g></svg>`;
}

export function embedSnippets(key: string, base: string) {
  const k = encodeURIComponent(key);
  const img = `${base}/v1/badge/${k}.svg`;
  const page = `${base}/trust/v/${k}`;
  const alt = "Lumi test-buy badge: live status";
  return {
    badge: img,
    page,
    json: `${base}/v1/badge/${k}.json`,
    markdown: `[![${alt}](${img})](${page})`,
    html: `<a href="${page}"><img src="${img}" alt="${alt}" height="20"></a>`,
    rst: `.. image:: ${img}\n   :target: ${page}\n   :alt: ${alt}`,
  };
}

export const BADGE_DISCLAIMER =
  "Factual test evidence, not an endorsement, rating or guarantee. The badge is earned only (live score and Lumi test-buy thresholds, never sold), is dated by Lumi's latest conclusive test-buy, and is removed automatically when the seller drops below the thresholds, when that latest test-buy failed, or 30 days after it. The result page lists Lumi's latest stored paid test-buys of this service (delivered = the paid response contained data; not delivered = the seller answered without usable data; inconclusive = Lumi never saw a response, a Lumi-side outcome, or the seller answered with an empty result for Lumi's test query; neither is counted against the seller). Past results do not predict future ones. Paying Lumi never changes a result.";

function rightToReply(key: string) {
  return { email: CONTACT_EMAIL, note: `Sellers can reply to or dispute any result: email ${CONTACT_EMAIL} (mention badge key ${key}), or sign a reply with a listed pay-to key via POST /v1/trust/replies. Verified replies are shown with your entry; corrections are logged publicly.` };
}

/** GET /v1/badge: how the signed, earned-only "Tested by Lumi" badge works. Thresholds come from badgeThresholds(env). */
export function badgeDocs(base: string, th: { minScore: number; minPaidTests: number }) {
  return {
    kind: "lumi_badge_docs",
    summary: `Free, signed, earned-only 'Tested by Lumi' badge for x402 sellers: ${testedBadgeSummary(th)}. Otherwise the SVG says 'no badge' (or 'not scored').`,
    endpoints: {
      svg: `${base}/v1/badge/{key}.svg`,
      json: `${base}/v1/badge/{key}.json`,
      page: `${base}/trust/v/{key}`,
      keys: `${base}/v1/check/keys`,
    },
    key: "A Lumi vendor id (e.g. printmoneylab, from GET /v1/trust/vendors) or the exact host of a curated vendor's x402 service. One key = one seller; there is no listing or search here.",
    threshold: { min_score: th.minScore, min_paid_test_buys: th.minPaidTests, window_days: BADGE_WINDOW_DAYS, latest_test_buy: "delivered" },
    rules: testedBadgeRules(th),
    date_shown: "The SVG and the .json (last_test_buy.date) show the UTC date of Lumi's latest conclusive test-buy, never the date the badge was rendered; .json also gives lapses_at.",
    monitored_badge: {
      note: "A separate badge for sellers who enroll in Lumi monitoring or buy a test-buy pack. It pools Lumi's own buys with seller-paid buys under the counting rules below. It does not affect this badge or any score.",
      svg: `${base}/v1/monitor/badge/{enrollment_id}.svg`,
      json: `${base}/v1/monitor/badge/{enrollment_id}.json`,
      rules: COUNTING_TEXT,
    },
    signature: "The .json verdict carries a Lumi-signed object (Ed25519, kind tested_badge, short expires_at). Verify it against Lumi's pinned public keys (lumi-scanner-kit verifyLumiSigned); a copied image proves nothing.",
    legacy: "The old paths GET /badge and /badge/{key}.svg|.json still work: they answer 301 to the /v1/badge routes above (query string kept). Use the /v1/badge paths in new embeds.",
    example: embedSnippets("printmoneylab", base),
    how_lumi_tests: HOW_IT_WORKS,
    right_to_reply: rightToReply("{key}"),
    disclaimer: BADGE_DISCLAIMER,
  };
}

const PAGE_CSS = `body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}main{max-width:860px;margin:0 auto;padding:28px 20px 60px}a{color:#7cc4ff}h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.15rem;margin-top:1.8em}.muted{color:#9aa7b4}.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 16px;margin:14px 0}table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #30363d;vertical-align:top}td.ep{word-break:break-all}.v{font-weight:600}.delivered{color:#56d364}.not_delivered{color:#ff7b72}.inconclusive{color:#b1bac4}pre{background:#0b0f14;border:1px solid #30363d;border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:.85rem}.disc{border-left:3px solid #d29922}`;

export function badgePage(s: BadgeSummary, base: string, rel: Record<string, unknown>[] = []): string {
  const e = embedSnippets(s.key, base);
  const rows = s.tests.map((t) => `<tr><td>${esc(t.date)}<br><span class="muted">${esc(t.at.slice(11, 16))} UTC</span></td><td class="ep">${esc(t.endpoint)}</td><td>${esc(t.chain ?? t.network)}</td><td class="v ${t.verdict}">${esc(t.verdict_text)}${t.inconclusive_reason ? `<br><span class="muted">${esc(INCONCLUSIVE_REASONS[t.inconclusive_reason as keyof typeof INCONCLUSIVE_REASONS] ?? "")}</span>` : ""}${t.corrected_at ? `<br><span class="muted">corrected ${esc(usDate(Date.parse(t.corrected_at)))}</span>` : ""}</td><td>${t.http_status ?? "none"}</td></tr>`).join("");
  const title = s.kind === "self" ? "Lumi Trades API" : s.name;
  const status = s.latest
    ? `Latest paid test-buy: <strong class="v ${s.latest.verdict}">${esc(s.latest.verdict_text)}</strong> on ${esc(s.latest.date)}${s.latest.chain ? ` (${esc(s.latest.chain)})` : ""}.`
    : s.kind === "self"
    ? "Lumi does not test or score its own API."
    : `<strong>Not yet tested.</strong> Lumi has no stored test result for <code>${esc(s.key)}</code>. That is not a negative finding; Lumi has simply not bought from it (or the key is not the host Lumi bought).`;
  const relHtml = rel.length ? `<div class="card disc"><strong>Commercial relationship:</strong> this seller pays Lumi for monitoring. That never changes a result.</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}: Lumi test-buy results</title><meta name="description" content="${esc(`Lumi's dated paid test-buy results for ${title}. Factual test evidence, not an endorsement.`)}">
<meta name="robots" content="${s.latest ? "index" : "noindex"},follow"><style>${PAGE_CSS}</style></head>
<body><main>
<p class="muted"><a href="https://lumitrades.io/">Lumi Trades</a> &middot; x402 test results</p>
<h1>${esc(title)}</h1>
<p class="muted">Key <code>${esc(s.key)}</code>${s.homepage ? ` &middot; <a href="${esc(s.homepage)}" rel="nofollow noopener">${esc(s.homepage)}</a>` : ""}</p>
<p><img src="${esc(e.badge)}" alt="${esc("Lumi test-buy badge: live status")}" height="20"></p>
<div class="card"><p style="margin:0">${status}</p></div>
${relHtml}
${s.tests.length ? `<h2>Latest dated tests</h2><table><thead><tr><th>Date (UTC)</th><th>Endpoint</th><th>Chain</th><th>Verdict</th><th>HTTP</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Newest first, up to ${BADGE_TESTS}. Each row is a real paid x402 call from Lumi's own wallet, stored with a signed receipt. Tx hashes and receipts are in the paid <a href="${esc(base)}/v1/trust/check">trust check</a>${s.vendor_id ? ` and <a href="${esc(base)}/v1/trust/vendors/${esc(s.vendor_id)}/report">vendor report</a>` : ""}; receipts verify for free at <a href="${esc(base)}/v1/trust/receipts/verify">/v1/trust/receipts/verify</a>.</p>` : ""}
<h2>How Lumi tests</h2>
<p>Lumi makes small, capped, real paid x402 calls to sellers on the XRP Ledger, Base and Stellar, records whether the paid response contained data, and stores each result with its date. Delivered = the paid response contained data. Not delivered = the seller answered without usable data. Inconclusive = Lumi never saw a response (Lumi-side), or the seller answered with an empty result for Lumi's test query; not counted against the seller. <a href="${HOW_IT_WORKS}">How it works</a> &middot; <a href="${esc(base)}/v1/trust/methodology">methodology (JSON)</a></p>
<h2>Right to reply</h2>
<p>Run this service? You can reply to or dispute any result: email <a href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Badge ${s.key}`)}">${CONTACT_EMAIL}</a>, or sign a reply with a listed pay-to key (<code>POST ${esc(base)}/v1/trust/replies</code>). Verified replies are shown with your entry and corrections are logged publicly.</p>
<h2>Embed this badge</h2>
<p class="muted">The image is live: it shows the 'Tested by Lumi' badge only while the rules hold, and 'no badge' otherwise. Embedding it does not earn it.</p>
<p class="muted">Markdown / README.md</p><pre>${esc(e.markdown)}</pre>
<p class="muted">HTML</p><pre>${esc(e.html)}</pre>
<p class="muted">reStructuredText / README.rst</p><pre>${esc(e.rst)}</pre>
<p class="muted">Signed badge verdict (JSON): <a href="${esc(e.json)}">${esc(e.json)}</a> &middot; Badge docs: <a href="${esc(base)}/v1/badge">${esc(base)}/v1/badge</a></p>
<div class="card disc"><strong>Disclaimer.</strong> ${esc(BADGE_DISCLAIMER)}</div>
<p class="muted">Updated within the hour of each new test. Dates are UTC.</p>
</main></body></html>`;
}
