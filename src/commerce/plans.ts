/**
 * Paid plans outside the per-call data routes: seller monitoring (per-endpoint Watch / Watch Plus / Watch Pro, Audit, and
 * the grandfathered Monitor / Monitor Plus ids) and the data licence
 * feed (Feed, Feed Pro, metered credits). Each payment is one x402 payment (XRPL XRP/RLUSD/USDC or Base USDC) for a
 * fixed term. Nothing auto-renews: renewing means paying again.
 *
 * Test-only price override: when the proven wallet of the enrolment (monitoring) or of the feed key is one of Lumi's
 * own owner-flagged test wallets, the quote is TEST_PRICE_USD instead of the list price and the plan is stored and
 * shown publicly as a test. No one else can get that price: the wallet must be proven by signature first.
 */
import { OWN_WALLETS } from "../sales";
import type { Config } from "../config";
import { usdToDrops } from "../pricing";
import type { Quote } from "../x402";
import { SERVICE_ICON, TRUST_SERVICE_NAME } from "../bazaar";

export type PlanId = "monitor" | "monitor_plus" | "audit" | "watch" | "watch_plus" | "watch_pro" | "feed" | "feed_pro" | "feed_credits";
/** Monitoring tiers that are never paid: stored as plan rows with usd 0 and a synthetic paid_tx (free_… / trial_…). */
export type FreeTierId = "watch_free" | "watch_plus_trial";

export interface PlanDef {
  id: PlanId;
  name: string;
  usd: string;
  /** Term in days; null = one-off (Audit, credits). */
  days: number | null;
  family: "monitor" | "feed";
  summary: string;
  path: string;
  /** Watch tiers: usd is the price per endpoint per 30-day term; the quote is usd × endpoints × terms less one discount (the larger of volume/prepay). */
  perEndpoint?: boolean;
  /** Grandfathered 2026-10-22 plan ids (Monitor $9 / Monitor Plus $29): still valid and purchasable, superseded by Watch. */
  legacy?: boolean;
  /** Set to true to stop selling a legacy id (subscribe answers 410 plan_retired); existing rows keep working to term end. */
  retired?: boolean;
}

export const DAY_MS = 86_400_000;
export const TERM_DAYS = 30;

export const PLANS: Record<PlanId, PlanDef> = {
  monitor: { id: "monitor", name: "Monitor", usd: "9", days: TERM_DAYS, family: "monitor", legacy: true, path: "/v1/monitor/subscribe/monitor", summary: "30 days: one seller-funded test-buy of 1 endpoint per term (one recheck after a failure) + alerts." },
  monitor_plus: { id: "monitor_plus", name: "Monitor Plus", usd: "29", days: TERM_DAYS, family: "monitor", legacy: true, path: "/v1/monitor/subscribe/monitor_plus", summary: "30 days: weekly seller-funded test-buys of up to 20 endpoints + alerts." },
  watch: { id: "watch", name: "Watch", usd: "5", days: TERM_DAYS, family: "monitor", perEndpoint: true, path: "/v1/monitor/subscribe/watch", summary: "Per endpoint per 30 days: hourly quote checks, a weekly seller-funded test-buy (small per-buy cap), alerts, 30-day history, status page and badge." },
  watch_plus: { id: "watch_plus", name: "Watch Plus", usd: "12", days: TERM_DAYS, family: "monitor", perEndpoint: true, path: "/v1/monitor/subscribe/watch_plus", summary: "Per endpoint per 30 days: quote checks every 15-30 min, a daily seller-funded test-buy (capped per buy) rotating across the chains the endpoint accepts, schema and p95-latency alerts, 90-day history." },
  watch_pro: { id: "watch_pro", name: "Watch Pro", usd: "20", days: TERM_DAYS, family: "monitor", perEndpoint: true, path: "/v1/monitor/subscribe/watch_pro", summary: "Per endpoint per 30 days: quote checks every 15 min, daily seller-funded test-buys on up to 3 chains (capped per buy), all Watch Plus alerts, 90-day history and a monthly report signed by Lumi's wallet." },
  audit: { id: "audit", name: "Audit", usd: "99", days: null, family: "monitor", path: "/v1/monitor/subscribe/audit", summary: "One-off: one seller-funded test-buy of every listed endpoint of the seller, with a full report signed by Lumi's wallet." },
  feed: { id: "feed", name: "Feed", usd: "99", days: TERM_DAYS, family: "feed", path: "/v1/feed/subscribe/feed", summary: "30 days: 100,000 bulk lookups, delta feed, full evidence and receipts." },
  feed_pro: { id: "feed_pro", name: "Feed Pro", usd: "199", days: TERM_DAYS, family: "feed", path: "/v1/feed/subscribe/feed_pro", summary: "30 days: 500,000 lookups, delta feed, licensed full snapshot export, status-change webhooks, receipts." },
  feed_credits: { id: "feed_credits", name: "Feed credits", usd: "1.5", days: null, family: "feed", path: "/v1/feed/credits", summary: "1,000 metered lookups (prepaid, credits never expire) on top of the free 1,000/month." },
};
/** Paid monitoring ids, sold side by side: the new per-endpoint Watch tiers, Audit, and the grandfathered Monitor ids. */
export const MONITOR_PLANS: PlanId[] = ["watch", "watch_plus", "watch_pro", "audit", "monitor", "monitor_plus"];
export const WATCH_PLANS: PlanId[] = ["watch", "watch_plus", "watch_pro"];
export const LEGACY_MONITOR_PLANS: PlanId[] = ["monitor", "monitor_plus"];
export const FEED_PLANS: PlanId[] = ["feed", "feed_pro"];

/** Test-buy economics. Every seller-funded test-buy is capped, and a plan's planned test-buy spend must stay within
 *  BUDGET_SHARE of its fee (the rest covers operations); endpoints that break either rule are rejected at enrolment. */
export const MONITOR_LIMITS = {
  maxBuyUsd: 0.1,
  budgetShare: 0.5,
  endpoints: { monitor: 1, monitor_plus: 20, audit: 100 } as Record<string, number>,
  /** Buys per endpoint per term (Monitor: 1 + 1 recheck after a failure; Plus: weekly = up to 5 in 30 days). */
  buysPerEndpoint: { monitor: 2, monitor_plus: 5, audit: 1 } as Record<string, number>,
  /** Cadence of scheduled buys (ms). */
  everyMs: { monitor: TERM_DAYS * DAY_MS, monitor_plus: 7 * DAY_MS, audit: 0 } as Record<string, number>,
  /** A badge needs a passing test this recent. */
  badgeFreshMs: { monitor: 35 * DAY_MS, monitor_plus: 9 * DAY_MS } as Record<string, number>,
  reminderBeforeMs: 3 * DAY_MS,
};

/** Watch tiers (per-endpoint plans, the free tier and the Watch Plus trial). Cadences are targets for the operator-box
 *  runner: quote probes (unpaid 402 checks, rolled up daily into D1) and seller-funded test-buys (one D1 run row each). */
export interface WatchTier {
  name: string;
  /** Unpaid quote-check cadence (ms). */
  probeEveryMs: number;
  /** Test-buy cadence (ms); 0 = no test-buys. */
  buyEveryMs: number;
  /** Test-buys per endpoint per chain per 30-day term. */
  buysPerTerm: number;
  /** Per-test-buy cap (USD). */
  maxBuyUsd: number;
  /** "one": the enrolled chain only; "rotate": one chain per buy, rotating; number: buy on up to N chains each time. */
  chains: "none" | "one" | "rotate" | number;
  historyDays: number;
  badge: boolean;
  schemaAlerts: boolean;
  latencyAlerts: boolean;
  signedReport: boolean;
  /** A badge needs a passing test this recent. */
  badgeFreshMs: number;
  /** Endpoints covered when not set per plan row (free tier / trial). */
  maxEndpoints: number;
}
const MIN = 60_000, HOUR = 3_600_000;
export const WATCH_TIERS: Record<"watch_free" | "watch" | "watch_plus" | "watch_pro" | "watch_plus_trial", WatchTier> = {
  watch_free: { name: "Watch Free", probeEveryMs: 24 * HOUR, buyEveryMs: 0, buysPerTerm: 0, maxBuyUsd: 0, chains: "none", historyDays: 30, badge: false, schemaAlerts: false, latencyAlerts: false, signedReport: false, badgeFreshMs: 0, maxEndpoints: 1 },
  watch: { name: "Watch", probeEveryMs: HOUR, buyEveryMs: 7 * DAY_MS, buysPerTerm: 5, maxBuyUsd: 0.05, chains: "one", historyDays: 30, badge: true, schemaAlerts: false, latencyAlerts: false, signedReport: false, badgeFreshMs: 9 * DAY_MS, maxEndpoints: 20 },
  watch_plus: { name: "Watch Plus", probeEveryMs: 30 * MIN, buyEveryMs: DAY_MS, buysPerTerm: 30, maxBuyUsd: 0.1, chains: "rotate", historyDays: 90, badge: true, schemaAlerts: true, latencyAlerts: true, signedReport: false, badgeFreshMs: 2 * DAY_MS, maxEndpoints: 20 },
  watch_pro: { name: "Watch Pro", probeEveryMs: 15 * MIN, buyEveryMs: DAY_MS, buysPerTerm: 30, maxBuyUsd: 0.1, chains: 3, historyDays: 90, badge: true, schemaAlerts: true, latencyAlerts: true, signedReport: true, badgeFreshMs: 2 * DAY_MS, maxEndpoints: 20 },
  watch_plus_trial: { name: "Watch Plus free trial", probeEveryMs: 30 * MIN, buyEveryMs: DAY_MS, buysPerTerm: 14, maxBuyUsd: 0.1, chains: "rotate", historyDays: 90, badge: true, schemaAlerts: true, latencyAlerts: true, signedReport: false, badgeFreshMs: 2 * DAY_MS, maxEndpoints: 3 },
};
export function watchTier(plan: string): WatchTier | null { return (WATCH_TIERS as Record<string, WatchTier>)[plan] ?? null; }

export const WATCH_FREE = { endpoints: 1, termDays: TERM_DAYS, label: "free tier, no test-buys" };
export const WATCH_TRIAL = { days: 14, capUsd: 0.25, endpoints: WATCH_TIERS.watch_plus_trial.maxEndpoints, label: "Watch Plus free trial" };
/** Volume and prepay discounts. They do NOT stack: when both apply (10+ endpoints prepaid for 3 terms) only the larger
 *  one is used (20% volume), never 0.8 × 0.9. */
export const WATCH_DISCOUNTS = { volumeMinEndpoints: 10, volume: 0.2, prepayTerms: 3, prepay: 0.1, maxEndpoints: 20 };

export interface WatchPrice {
  plan: PlanId; endpoints: number; terms: number; unit_usd: number; list_usd: number;
  /** The discount actually applied (only one: the larger of the eligible ones) and which one it is. */
  discount: number; discount_applied: "volume" | "prepay" | null;
  /** Applied rate per kind (the one not applied is 0, even if eligible). */
  volume_discount: number; prepay_discount: number;
  /** Eligible but not applied because discounts do not stack. */
  discount_not_stacked?: "volume" | "prepay";
  total_usd: string; per_term_usd: number; per_endpoint_term_usd: number;
}
const cents = (x: number) => Math.round(x * 100) / 100;
/** The single discount for N endpoints × T terms: the larger of the eligible volume / prepay discounts (no stacking). */
export function watchDiscount(endpoints: number, terms: number): { rate: number; kind: "volume" | "prepay" | null; not_stacked?: "volume" | "prepay" } {
  const vol = endpoints >= WATCH_DISCOUNTS.volumeMinEndpoints ? WATCH_DISCOUNTS.volume : 0;
  const pre = terms === WATCH_DISCOUNTS.prepayTerms ? WATCH_DISCOUNTS.prepay : 0;
  if (!vol && !pre) return { rate: 0, kind: null };
  const kind = vol >= pre ? "volume" : "prepay";
  const other = kind === "volume" ? (pre ? "prepay" : undefined) : (vol ? "volume" : undefined);
  return { rate: Math.max(vol, pre), kind, ...(other ? { not_stacked: other } : {}) };
}
/** Price of N endpoints × T terms of a Watch tier. Terms is 1 or 3 (prepay); anything else is invalid. */
export function watchPrice(plan: PlanId, endpoints: number, terms = 1): WatchPrice | null {
  const p = PLANS[plan];
  if (!p?.perEndpoint) return null;
  if (!Number.isInteger(endpoints) || endpoints < 1 || endpoints > WATCH_DISCOUNTS.maxEndpoints) return null;
  if (terms !== 1 && terms !== WATCH_DISCOUNTS.prepayTerms) return null;
  const unit = Number(p.usd);
  const d = watchDiscount(endpoints, terms);
  const list = unit * endpoints * terms;
  const total = cents(list * (1 - d.rate));
  return { plan, endpoints, terms, unit_usd: unit, list_usd: list, discount: d.rate, discount_applied: d.kind,
    volume_discount: d.kind === "volume" ? d.rate : 0, prepay_discount: d.kind === "prepay" ? d.rate : 0,
    ...(d.not_stacked ? { discount_not_stacked: d.not_stacked } : {}), total_usd: String(total), per_term_usd: Math.round((total / terms) * 1e6) / 1e6, per_endpoint_term_usd: Math.round((total / terms / endpoints) * 1e6) / 1e6 };
}

export const FEED_LIMITS = {
  freePerMonth: 1000,
  creditsPerPurchase: 1000,
  included: { feed: 100_000, feed_pro: 500_000 } as Record<string, number>,
  perMinute: { free: 30, credits: 60, feed: 120, feed_pro: 600 } as Record<string, number>,
  maxBatch: 50,
};

export function testWallets(extra: string[] = []): string[] {
  return [...OWN_WALLETS, ...extra];
}
export function isTestWallet(addr: string | null | undefined, extra: string[] = []): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  return testWallets(extra).some((w) => w.toLowerCase() === a);
}

export const TEST_PRICE_USD = "0.01";

/** Price of a plan payment. Watch tiers: per-endpoint price × endpoints × terms, less the larger of the volume/prepay discounts. */
export function planPriceUsd(plan: PlanId, test: boolean, testPrice = TEST_PRICE_USD, qty: { endpoints?: number; terms?: number } = {}): string {
  if (test) return testPrice;
  if (PLANS[plan].perEndpoint) return watchPrice(plan, qty.endpoints ?? 1, qty.terms ?? 1)?.total_usd ?? PLANS[plan].usd;
  return PLANS[plan].usd;
}

/** x402 quote for a plan payment. routeKey binds the payment to this plan + subject (enrolment id / key id) and, for
 *  per-endpoint Watch tiers, to the endpoint count and number of prepaid terms (so a 1-endpoint quote cannot be replayed
 *  for 20 endpoints). */
export function planQuote(cfg: Config, plan: PlanId, subject: string, usd: string, resourceUrl: string, test: boolean, qty: { endpoints?: number; terms?: number } = {}): Quote {
  const p = PLANS[plan];
  const n = qty.endpoints ?? 1, terms = qty.terms ?? 1;
  const qtyText = p.perEndpoint ? ` ${n} endpoint${n === 1 ? "" : "s"} × ${terms} term${terms === 1 ? "" : "s"} of 30 days, priced per endpoint per term${(() => { const d = watchDiscount(n, terms); return d.kind ? `, -${d.rate * 100}% ${d.kind}${d.not_stacked ? " (discounts do not stack)" : ""}` : ""; })()}.` : "";
  const rate = cfg.xrpRate?.usd ?? cfg.xrpUsdFallback;
  const amountsIou: Record<string, string> = {};
  for (const o of cfg.ious) amountsIou[o.symbol] = usd;
  return {
    routeKey: p.perEndpoint ? `${plan}:${subject}:n${n}:t${terms}` : `${plan}:${subject}`,
    amountDrops: usdToDrops(usd, rate),
    amountsIou,
    amountEvm: cfg.evm ? String(Math.round(Number(usd) * 1e6)) : undefined,
    amountStellar: cfg.stellar ? String(Math.round(Number(usd) * 1e7)) : undefined,
    description: `${TRUST_SERVICE_NAME} ${p.name}${p.family === "monitor" ? " (x402 seller monitoring)" : " (x402 trust data feed)"}${test ? " (TEST price for an owner-flagged Lumi test wallet)" : ""}.${qtyText} ${p.summary} No auto-renew.`.slice(0, 500),
    resourceUrl,
    service: { serviceName: TRUST_SERVICE_NAME, tags: p.family === "monitor" ? ["monitoring", "x402", "trust"] : ["data", "trust", "x402"], iconUrl: SERVICE_ICON },
    liveDrops: true,
    xrpUsd: rate,
  };
}

/** Public, apolitical price table for discovery docs. */
export function planTable() {
  return Object.values(PLANS).map((p) => ({ plan: p.id, name: p.name, price_usd: p.usd, ...(p.perEndpoint ? { per: "endpoint" } : {}), ...(p.legacy ? { legacy: true } : {}), term_days: p.days, auto_renew: false, path: p.path, summary: p.summary }));
}

/** Shared random id/token helpers. */
export function randHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
}
export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s), (x) => x.toString(16).padStart(2, "0")).join("");
}

export const iso = (t: number | null | undefined) => (t == null ? null : new Date(t).toISOString());

/** One-line monitoring price text shared by MCP, A2A and docs (keep in sync with the site: lumitrades.io/agents/ and /trust/). */
export const MONITOR_PRICE_TEXT =
  `For x402 sellers, priced per endpoint per 30 days: Watch $${PLANS.watch.usd} (hourly quote checks, weekly test-buy), Watch Plus $${PLANS.watch_plus.usd} (15-30 min checks, daily test-buy rotating chains, schema/p95 alerts), ` +
  `Watch Pro $${PLANS.watch_pro.usd} (15 min checks, daily test-buys on up to 3 chains, signed monthly report); ${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints -${WATCH_DISCOUNTS.volume * 100}%, ${WATCH_DISCOUNTS.prepayTerms} terms prepaid -${WATCH_DISCOUNTS.prepay * 100}% (discounts do not stack: the larger applies). ` +
  `Audit $${PLANS.audit.usd} one-off (every listed endpoint, signed report). Free Watch tier (${WATCH_FREE.endpoints} endpoint, daily quote check, no test-buys) and a one-per-seller ${WATCH_TRIAL.days}-day Watch Plus trial (no card, never converts). ` +
  `Legacy Monitor/Monitor Plus are grandfathered.`;
