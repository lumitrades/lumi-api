/**
 * Seller monitoring: sellers prove control of their payTo, enrol endpoints, pay a plan via x402, and Lumi test-buys
 * their endpoints (seller-funded, capped per buy) from the operator box, posting results back here. Findings are
 * append-only and alert the seller (HMAC-signed webhook and/or email). Nothing here is read by any trust score.
 */
import { canonicalJson, json, requirePayment, assetLabel, paymentRequiredResponse, HEADER_PAYMENT_SIGNATURE, HEADER_X_PAYMENT, type Settlement, type PaymentRequirements } from "../x402";
import { verifyXrplSignature, xrplAddressOf } from "../trust/verify";
import { explorerFor, registrableDomain } from "../trust/catalog";
import { sendPlainEmail } from "../sales";
import { DAY_MS, MONITOR_LIMITS, MONITOR_PLANS, SOLD_MONITOR_PLANS, PLANS, TEST_PRICE_USD, WATCH_DISCOUNTS, WATCH_FREE, WATCH_PLANS, WATCH_TIERS, WATCH_TRIAL, WATCH_TRIAL_END, PAID_BADGE_LABEL, PACK_BADGE_LABEL, TRIAL_BADGE_LABEL, hmacHex, iso, isTestWallet, planPriceUsd, planQuote, randHex, sha256, watchPrice, watchTier, isPack, PACK_LIMITS, PACK_PLANS, usd2, type PlanId, type WatchTier } from "./plans";
import { FOUNDER_RACE_TEXT, MONITOR_METHODOLOGY, MONITOR_SAFEGUARDS, MONITOR_TERMS, PACK_TERMS } from "./policy";
const CONTACT_EMAIL = "hello@lumitrades.io";
import { makeChallenge, verifyProof } from "./proof";
import { BADGE_LAPSE_MS, COUNTING, COUNTING_TEXT, countBuys, countedSummary, type CountedBuy } from "./counting";
export { COUNTING_TEXT } from "./counting";
import type { BuyRow } from "../trust/catalog";
import { NO_STORE, acceptAsset, acceptUsd, bad, bearer, parse402, readJson, safeEmail, safeHttpsUrl, type CommerceDeps, type WaitUntil } from "./common";
import type { EndpointChain, Enrollment, FindingRow, MonitorEndpoint, PackJobRow, PlanRow, RunRow, UptimeRow } from "./store";

/** Company keys for the Founder offer: the payTo plus every registrable domain the enrolment uses. Enrolments sharing any key are one company. */
export function founderCompanyKeys(x: Enrollment): Set<string> {
  return new Set([`pay:${x.pay_to_lc}`, ...[x.domain, ...x.endpoints.map((ep) => { try { return new URL(ep.url).hostname; } catch { return null; } })].filter((d): d is string => !!d).map((d) => registrableDomain(d) ?? d.toLowerCase()).map((d) => `dom:${d}`)]);
}
const ENROLL_ID_RE = /^men_[a-f0-9]{24}$/;
const OK_OUTCOMES = new Set(["delivered"]);
/** Plans whose rows earn a badge and run test-buys over a term (Audit is one-off; the free tier has neither). */
const MONITORING = new Set(["monitor", "monitor_plus", "watch", "watch_plus", "watch_plus_founder", "watch_pro", "watch_plus_trial"]);
/** Unpaid tiers: rows with usd 0 and a synthetic paid_tx. Shown publicly but never listed as paying sellers. */
const UNPAID = new Set(["watch_free", "watch_plus_trial"]);
/** Plans whose rows are quote-probed by the box runner, with the cadence of the strongest active tier. */
const LEGACY_PROBE_MS = DAY_MS;
const HOUR_MS = 3_600_000;
export const STATUS_LABELS = { free: WATCH_FREE.label, trial: WATCH_TRIAL.label };
const ENDPOINT_TIMEOUT_MS = 10_000;
const MAX_SELLER_ENDPOINTS = 20;
const ENROLL_PER_PAYTO_PER_DAY = 5;

/** Badge label for Lumi's own owner-flagged test enrolment (never shown as a real "Monitored by Lumi" seller). */
export const TEST_BADGE_LABEL = "Lumi test enrolment";
export const SELLERS_DISCLOSURE = "Sellers listed here have paid Lumi for a monitoring plan (active or past). Lumi's own test enrolments and free-tier/trial-only sellers (no payment) are excluded from this list. Paying never changes a score.";
export const MONITOR_POST_PATHS = ["/v1/monitor/enroll", "/v1/monitor/replies", "/v1/monitor/free", "/v1/monitor/trial", "/v1/monitor/packs/use", "/v1/owner/monitor/results", "/v1/owner/monitor/packs/cancel", "/v1/owner/monitor/report", "/v1/owner/monitor/uptime", "/v1/owner/corrections"];

function failed(r: RunRow | undefined) { return !!r && r.outcome !== "skipped" && r.outcome !== "quote_only" && !OK_OUTCOMES.has(r.outcome); }

const sellerEps = (e: Enrollment) => e.endpoints.filter((x) => x.source === "seller");
/** Default endpoint count for a Watch quote: every seller endpoint in the enrolment (1-20). */
export const defaultWatchEndpoints = (e: Enrollment) => Math.max(1, Math.min(WATCH_DISCOUNTS.maxEndpoints, sellerEps(e).length));

/** Endpoints a plan covers. Legacy Monitor: the first seller endpoint; legacy Plus: up to 20; Watch tiers: the first N
 *  seller endpoints (N = endpoints paid for, stored on the plan row); free tier: 1; trial: up to 3; Audit: all incl.
 *  catalog listings. */
export function planEndpoints(e: Enrollment, plan: string, n?: number | null): MonitorEndpoint[] {
  const seller = sellerEps(e);
  if (isPack(plan)) return seller; // packs: any enrolled seller endpoint (each job names one; the per-buy cap is checked when queued)
  if (plan === "monitor") return seller.slice(0, 1);
  if (plan === "monitor_plus") return seller.slice(0, MONITOR_LIMITS.endpoints.monitor_plus);
  const tier = watchTier(plan);
  if (tier) {
    const paid = PLANS[plan as PlanId]?.perEndpoint ? (n ?? defaultWatchEndpoints(e)) : tier.maxEndpoints;
    return seller.slice(0, Math.max(0, Math.min(paid, tier.maxEndpoints, WATCH_DISCOUNTS.maxEndpoints)));
  }
  return e.endpoints.slice(0, MONITOR_LIMITS.endpoints.audit);
}

/** Chains an endpoint can be test-bought on, primary (signature-proven) first, priced within the tier's per-buy cap. */
export function buyChains(ep: MonitorEndpoint, e: Enrollment, cap: number): EndpointChain[] {
  const primary: EndpointChain = { network: e.network, pay_to: e.pay_to, usd: ep.price_usd == null ? null : Number(ep.price_usd), asset: ep.asset, proven: true };
  const list = ep.chains?.length ? ep.chains : [primary];
  const sorted = [...list.filter((c) => c.proven), ...list.filter((c) => !c.proven)];
  return sorted.filter((c) => c.usd != null && c.usd <= cap);
}

/** Planned test-buy spend of one endpoint over one term for a Watch tier (worst case, per-chain prices). */
function watchEndpointSpend(ep: MonitorEndpoint, e: Enrollment, tier: WatchTier) {
  if (!tier.buysPerTerm) return { buyable: false, est: 0, buys: 0 };
  const chains = buyChains(ep, e, tier.maxBuyUsd);
  if (!chains.length) return { buyable: false, est: 0, buys: 0 };
  if (tier.chains === "one") return { buyable: true, est: chains[0].usd! * tier.buysPerTerm, buys: tier.buysPerTerm };
  if (tier.chains === "rotate") return { buyable: true, est: Math.max(...chains.map((c) => c.usd!)) * tier.buysPerTerm, buys: tier.buysPerTerm };
  const k = typeof tier.chains === "number" ? chains.slice(0, tier.chains) : [];
  return { buyable: true, est: k.reduce((s, c) => s + c.usd! * tier.buysPerTerm, 0), buys: k.length * tier.buysPerTerm };
}

/** Test-buy economics of a Watch tier for N endpoints × T terms: planned spend per term vs 50% of the (discounted) fee. */
export function watchEconomics(e: Enrollment, plan: PlanId, endpoints: number, terms = 1) {
  const tier = watchTier(plan)!;
  const price = watchPrice(plan, endpoints, terms);
  if (!price) return { eligible: false, reason: `endpoints must be 1-${WATCH_DISCOUNTS.maxEndpoints} and terms 1 or ${WATCH_DISCOUNTS.prepayTerms}.` };
  const eps = planEndpoints(e, plan, endpoints);
  const spend = eps.map((ep) => watchEndpointSpend(ep, e, tier));
  const buyable = spend.filter((x) => x.buyable).length;
  const est = spend.reduce((s, x) => s + x.est, 0);
  const budget = Math.round(price.per_term_usd * MONITOR_LIMITS.budgetShare * 1e6) / 1e6;
  const eligible = buyable > 0 && est <= budget + 1e-9;
  return {
    price_usd: price.total_usd, price_per_endpoint_usd: PLANS[plan].usd, endpoints, terms,
    ...(price.volume_discount ? { volume_discount: price.volume_discount } : {}), ...(price.prepay_discount ? { prepay_discount: price.prepay_discount } : {}),
    ...(price.discount_not_stacked ? { discount_not_stacked: price.discount_not_stacked } : {}),
    ...(e.is_test ? { test_price_usd: TEST_PRICE_USD } : {}),
    endpoints_covered: eps.length,
    test_buys_planned_per_term: spend.reduce((s, x) => s + x.buys, 0),
    ...(eps.length - buyable ? { quote_checked_only: eps.length - buyable } : {}),
    max_usd_per_test_buy: tier.maxBuyUsd,
    est_test_buy_cost_usd_per_term: Math.round(est * 10_000) / 10_000,
    test_buy_budget_usd_per_term: budget,
    eligible,
    ...(!eligible ? { reason: buyable ? `Planned test-buys ($${est.toFixed(4)} per term) exceed ${MONITOR_LIMITS.budgetShare * 100}% of the fee ($${budget} per term): the plan would be unprofitable.` : `No endpoint priced within the $${tier.maxBuyUsd} per-test-buy cap of ${tier.name}.` } : {}),
    ...(eps.length < endpoints ? { note: `Only ${eps.length} seller endpoint(s) are enrolled; enrol more before paying for ${endpoints}.` } : {}),
  };
}

/** Seller endpoints a pack can test-buy: priced within the pack cap on at least one chain. */
export const packEndpoints = (e: Enrollment) => sellerEps(e).filter((ep) => buyChains(ep, e, PACK_LIMITS.maxBuyUsd).length > 0);
/** Pack economics shown at enrolment: exact price, buys, and whether any enrolled endpoint is within the cap. */
export function packEconomics(e: Enrollment, id: PlanId) {
  const k = PLANS[id].pack!;
  const eps = packEndpoints(e);
  const worst = eps.length ? Math.max(...eps.map((ep) => Math.min(...buyChains(ep, e, PACK_LIMITS.maxBuyUsd).map((c) => c.usd!)))) : 0;
  return {
    price_usd: PLANS[id].usd, test_buys: k.buys, expiry_days: k.expiryDays, max_usd_per_test_buy: PACK_LIMITS.maxBuyUsd,
    endpoints_within_cap: eps.length, ...(sellerEps(e).length - eps.length ? { endpoints_above_cap: sellerEps(e).length - eps.length } : {}),
    est_max_test_buy_cost_usd: Math.round(worst * k.buys * 10_000) / 10_000,
    eligible: eps.length > 0, ...(eps.length ? {} : { reason: `No enrolled seller endpoint priced within the $${PACK_LIMITS.maxBuyUsd.toFixed(2)} per-test-buy cap.` }),
    ...(k.founder ? { founder: { seats: k.founder.seats, max_purchases_per_company: k.founder.maxPurchases } } : {}),
  };
}

/** Test-buy economics per plan: endpoints covered, planned spend, and whether it fits the fee (list price; Watch tiers
 *  for the default endpoint count and 1 term, or the given quantity). */
export function planEconomics(e: Enrollment, qty: { endpoints?: number; terms?: number } = {}) {
  const out: Record<string, unknown> = {};
  for (const id of MONITOR_PLANS.filter((p) => !PLANS[p].retired)) {
    if (PLANS[id].pack) { out[id] = packEconomics(e, id); continue; }
    if (PLANS[id].perEndpoint) { out[id] = watchEconomics(e, id, qty.endpoints ?? defaultWatchEndpoints(e), qty.terms ?? 1); continue; }
    const eps = planEndpoints(e, id);
    const buyable = eps.filter((x) => x.price_usd != null && Number(x.price_usd) <= MONITOR_LIMITS.maxBuyUsd);
    const quoteOnly = eps.length - buyable.length;
    const est = buyable.reduce((s, x) => s + Number(x.price_usd) * MONITOR_LIMITS.buysPerEndpoint[id], 0);
    const budget = Number(PLANS[id].usd) * MONITOR_LIMITS.budgetShare;
    const eligible = buyable.length > 0 && est <= budget;
    out[id] = {
      price_usd: PLANS[id].usd,
      ...(e.is_test ? { test_price_usd: TEST_PRICE_USD } : {}),
      endpoints_covered: eps.length,
      test_buys_planned: buyable.length * MONITOR_LIMITS.buysPerEndpoint[id],
      ...(quoteOnly ? { quote_checked_only: quoteOnly } : {}),
      est_test_buy_cost_usd: Math.round(est * 10_000) / 10_000,
      test_buy_budget_usd: budget,
      eligible,
      ...(!eligible ? { reason: buyable.length ? `Planned test-buys ($${est.toFixed(4)}) exceed ${MONITOR_LIMITS.budgetShare * 100}% of the fee: the plan would be unprofitable.` : "No endpoint priced within the $0.10 per-test-buy cap." } : {}),
    };
  }
  return out;
}

const badgeFreshMs = (plan: string) => watchTier(plan)?.badgeFreshMs ?? MONITOR_LIMITS.badgeFreshMs[plan as "monitor"] ?? 0;
/** Paid tiers outrank the trial for which row the badge reports. */
const tierRank = (plan: string) => ({ watch_pro: 6, watch_plus: 5, watch_plus_founder: 5, monitor_plus: 4, watch: 3, monitor: 2, watch_plus_trial: 1 } as Record<string, number>)[plan] ?? 0;

/**
 * The seller-monitoring badge (adopted rules 2026-10-25, see counting.ts): seller-paid runs (plans and packs) and Lumi's
 * baseline buys are pooled; at most one counted buy per endpoint per UTC day (the first failure that day if any buy
 * failed, otherwise the first success; see countBuys); failures count like successes (the latest counted result per
 * endpoint decides, and any endpoint whose latest counted day failed removes the badge); the badge is dated with the
 * last delivered counted buy and lapses when that is older than the tier window, never more than 30 days (packs: 30).
 * Public wording: COUNTING_TEXT in counting.ts.
 */
export function badgeStatus(e: Enrollment, plans: PlanRow[], runs: RunRow[], now: number, baseline: BuyRow[] = []) {
  const live = (p: PlanRow) => p.starts_at <= now && now < p.ends_at;
  const active = plans.filter((p) => MONITORING.has(p.plan) && live(p)).sort((a, b) => tierRank(b.plan) - tierRank(a.plan))[0]
    ?? plans.filter((p) => isPack(p.plan) && !p.is_test && live(p)).sort((a, b) => b.ends_at - a.ends_at)[0]
    ?? plans.filter((p) => isPack(p.plan) && live(p))[0];
  if (!active) {
    if (plans.some((p) => p.plan === "watch_free" && live(p))) return { ok: false as const, reason: "free_tier_no_badge" };
    const had = plans.filter((p) => MONITORING.has(p.plan) || isPack(p.plan));
    return { ok: false as const, reason: had.length ? (had.some((p) => p.plan !== "watch_plus_trial") ? "plan_lapsed" : "trial_ended") : "no_monitoring_plan" };
  }
  const eps = planEndpoints(e, active.plan, active.endpoints).map((x) => x.url);
  const buys = countBuys(runs, baseline, eps);
  const { latest, lastDelivered } = countedSummary(buys, eps);
  const seen = latest.filter((x): x is CountedBuy => !!x);
  if (!seen.length) return { ok: false as const, reason: "no_test_yet", plan: active };
  const lastAny = Math.max(...seen.map((b) => b.ts));
  if (seen.some((b) => !b.delivered)) return { ok: false as const, reason: "monitoring_failed", plan: active, last_test: lastDelivered ?? lastAny };
  const windowMs = isPack(active.plan) ? BADGE_LAPSE_MS : Math.min(badgeFreshMs(active.plan) || BADGE_LAPSE_MS, BADGE_LAPSE_MS);
  const last = lastDelivered!;
  if (now - last > windowMs) return { ok: false as const, reason: "no_recent_test", plan: active, last_test: last };
  return { ok: true as const, plan: active, last_test: last, result: seen.length < eps.length ? "pass (partial)" : "pass" };
}


const REASON_TEXT: Record<string, string> = {
  plan_lapsed: "plan lapsed", no_monitoring_plan: "not monitored", no_test_yet: "no test yet", monitoring_failed: "latest test failed", no_recent_test: "no recent test",
  free_tier_no_badge: "free tier, no test-buys", trial_ended: "trial ended",
};

/** The highest tier active now (any kind, incl. free) and whether the seller's data is frozen (only ended free/trial rows). */
export function tierState(plans: PlanRow[], now: number) {
  // Audit and test-buy packs are not monitoring tiers (no cadence, no badge): never the "top" tier.
  const active = plans.filter((p) => p.starts_at <= now && now < p.ends_at && p.plan !== "audit" && !isPack(p.plan));
  const top = [...active].sort((a, b) => tierRank(b.plan) - tierRank(a.plan) || (b.plan === "watch_free" ? -1 : 0))[0] ?? null;
  const paidEver = plans.some((p) => !UNPAID.has(p.plan));
  const paidActive = active.some((p) => !UNPAID.has(p.plan)) || plans.some((p) => p.plan === "audit" && p.starts_at <= now && now < p.starts_at + 30 * DAY_MS) || plans.some((p) => isPack(p.plan) && p.starts_at <= now && now < p.ends_at);
  const trial = plans.find((p) => p.plan === "watch_plus_trial") ?? null;
  // Frozen: the trial ended, nothing paid is active and no free tier is running -> history and status stop at the trial end.
  const frozen = !!trial && trial.ends_at <= now && !paidActive && !active.length;
  const freezeAt = frozen ? Math.max(...plans.filter((p) => UNPAID.has(p.plan)).map((p) => p.ends_at)) : null;
  return { top, paidEver, paidActive, trial, frozen, freezeAt };
}

export function tierLabel(plan: string | null | undefined) {
  if (!plan) return "not monitored";
  if (plan === "watch_free") return `Watch Free (${WATCH_FREE.label})`;
  if (plan === "watch_plus_trial") return `${WATCH_TRIAL.label} (Lumi-funded test-buys, capped at $${WATCH_TRIAL.capUsd} in total)`;
  const p = PLANS[plan as PlanId];
  return p ? `${p.name}${p.legacy ? " (legacy plan)" : ""}` : plan;
}

function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }

export function badgeSvg(left: string, right: string, ok: boolean): string {
  const w = (s: string) => Math.round(s.length * 6.4 + 14);
  const lw = w(left), rw = w(right), W = lw + rw;
  const rc = ok ? "url(#g)" : "#6b7280";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}"><title>${esc(left)}: ${esc(right)}</title>` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>` +
    `<rect width="${lw}" height="20" rx="3" fill="#0b0f1a"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="${rc}"/><rect x="${lw - 3}" width="6" height="20" fill="${rc}"/>` +
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="7" y="14">${esc(left)}</text><text x="${lw + 7}" y="14">${esc(right)}</text></g></svg>`;
}

export function createMonitor(deps: CommerceDeps) {
  const { store, now } = deps;

  async function ownerOnly(request: Request) {
    if (await deps.isOwner(request)) return null;
    return json(401, { error: "owner_key_required", hint: "Authorization: Bearer <OWNER_MCP_KEY>" }, { ...NO_STORE, "WWW-Authenticate": "Bearer" });
  }

  function doc(base: string) {
    return {
      kind: "lumi_seller_monitoring",
      summary: "Opt-in monitoring for x402 sellers (XRPL first, Base supported): Lumi test-buys your endpoints with real payments and alerts you when something breaks.",
      plans: SOLD_MONITOR_PLANS.map((id) => ({
        plan: id, name: PLANS[id].name, price_usd: PLANS[id].usd, ...(PLANS[id].perEndpoint ? { per: "endpoint per 30-day term" } : {}), term_days: PLANS[id].days, auto_renew: false,
        pay: `${base}${PLANS[id].path}?enrollment=<enrollment_id>${PLANS[id].perEndpoint ? "&endpoints=<N>&terms=<1|3>" : ""}`, summary: PLANS[id].summary,
        ...(PLANS[id].legacy ? { legacy: "Grandfathered: existing terms run to their end and the id stays valid; new sellers should pick a Watch tier." } : {}),
        ...(PLANS[id].retired ? { retired: true } : {}),
      })),
      pricing: {
        per_endpoint: `Watch $${PLANS.watch.usd}, Watch Pro $${PLANS.watch_pro.usd} per endpoint per 30 days; price = per-endpoint price × endpoints.`,
        volume_discount: `${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints: -${WATCH_DISCOUNTS.volume * 100}%.`,
        prepay_discount: `Prepay ${WATCH_DISCOUNTS.prepayTerms} terms (&terms=${WATCH_DISCOUNTS.prepayTerms}): -${WATCH_DISCOUNTS.prepay * 100}%.`,
        discounts_combine: `Discounts do not stack: with ${WATCH_DISCOUNTS.volumeMinEndpoints}+ endpoints and ${WATCH_DISCOUNTS.prepayTerms} prepaid terms only the larger one applies (-${Math.max(WATCH_DISCOUNTS.volume, WATCH_DISCOUNTS.prepay) * 100}%).`,
        test_buy_budget: `Seller-funded test-buys never exceed ${MONITOR_LIMITS.budgetShare * 100}% of the fee.`,
        example: (() => { const x = watchPrice("watch", 10, 1)!; return `Watch for 10 endpoints, 1 term: $${x.total_usd}.`; })(),
        test_buy_packs: `Re-test pack $${usd2(PLANS.retest_pack.usd)} for ${PLANS.retest_pack.pack!.buys} test-buys; Founder pack $${usd2(PLANS.founder_pack.usd)} for ${PLANS.founder_pack.pack!.buys} test-buys (first ${PLANS.founder_pack.pack!.founder!.seats} sellers). Exact prices, no discounts. Details: ${base}/v1/monitor/packs`,
        retired: "Watch Plus (and its founder offer) is no longer sold since 2026-10-25; the test-buy packs replace it. Existing terms run to their end.",
      },
      packs: packsDoc(base),
      tiers: Object.fromEntries(Object.entries(WATCH_TIERS).filter(([k]) => k !== "watch_plus").map(([k, v]) => [k, {
        name: v.name, quote_check_every_min: v.probeEveryMs / 60_000, test_buys: v.buysPerTerm ? (v.buyEveryMs >= 7 * DAY_MS ? "weekly" : "daily") : "none",
        max_usd_per_test_buy: v.maxBuyUsd || null, chains: v.chains, history_days: v.historyDays, badge: v.badge, schema_alerts: v.schemaAlerts, latency_p95_alerts: v.latencyAlerts, signed_monthly_report: v.signedReport,
      }])),
      free_tier: { price_usd: "0", endpoints: WATCH_FREE.endpoints, checks: "a daily quote check", test_buys: "none", badge: false, label: WATCH_FREE.label, start: `POST ${base}/v1/monitor/free {enrollment_id} with Authorization: Bearer <management token>. One active free tier per payTo; renew each 30 days.` },
      trial: {
        plan: "Watch trial", days: WATCH_TRIAL.days, endpoints: WATCH_TRIAL.endpoints, test_buy_cap_usd: WATCH_TRIAL.capUsd, card_required: false, auto_converts: false,
        eligibility: "One per seller: a domain and a payTo can each start one trial, ever. Prove control of both in one challenge.",
        after: "History and the status page freeze (read-only) at the trial end unless a paid plan is active.",
        start: `GET ${base}/v1/monitor/trial/challenge?pay_to=<payTo>&domain=<your API domain> -> publish the domain token -> sign the message with the payTo -> POST ${base}/v1/monitor/trial {enrollment_id, message, signature, public_key?} with the management token.`,
      },
      status_page: `${base}/v1/monitor/status/<enrollment_id> (HTML) or .json`,
      payment: "x402 on XRPL (XRP, RLUSD, USDC) or Base (USDC). One payment = one term (or 3 prepaid terms); renew by paying again (stacks after the current term). Reminders 3 days before the end.",
      steps: [
        `1. GET ${base}/v1/monitor/challenge?pay_to=<your payTo> (free): a message to sign. XRPL: sign the UTF-8 hex of the message with the payTo's master or regular key (ripple-keypairs) and send public_key. Base: EIP-191 personal_sign from the payTo (smart-contract wallets/EIP-1271 are not supported yet).`,
        `2. POST ${base}/v1/monitor/enroll {message, signature, public_key?, endpoints:[{url, method?, body?}], webhook_url?, email?} (free). Each endpoint is quote-checked: it must pay the proven payTo and cost ≤ $${MONITOR_LIMITS.maxBuyUsd} per buy, or it is rejected with the reason. Returns enrollment_id, a management token and the webhook signing secret (shown once).`,
        `3. Pay a plan: GET ${base}/v1/monitor/subscribe/{watch|watch_pro|audit}?enrollment=<id>&endpoints=<N>&terms=<1|3> (x402), or buy a test-buy pack: GET ${base}/v1/monitor/subscribe/{retest_pack|founder_pack}?enrollment=<id> (x402, exact price). Or start the free tier / the one-time Watch trial (no payment).`,
        `4. Public entry: ${base}/v1/monitor/sellers/<id>; status page: ${base}/v1/monitor/status/<id>; badge: ${base}/v1/monitor/badge/<id>.svg (or .json).`,
      ],
      alerts: {
        kinds: ["paid_no_data", "paid_invalid_data", "http_5xx", "http_error", "timeout", "pay_to_changed", "price_changed", "schema_changed", "recovered", "quote_down", "quote_recovered", "latency_p95_high", "renewal_due", "plan_lapsed", "trial_ended"],
        webhook: "POST JSON {type:'lumi.monitor.finding', enrollment_id, finding, seller_page}; header X-Lumi-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>.",
        email: "Plain-text email to the address given at enrolment (kept private, never shown publicly).",
      },
      replies: `POST ${base}/v1/monitor/replies {enrollment_id, finding_id, text} with Authorization: Bearer <management token>. Replies are shown next to the finding; findings cannot be removed.`,
      methodology: { ...MONITOR_METHODOLOGY, full: `${base}/v1/trust/methodology` },
      safeguards: MONITOR_SAFEGUARDS,
      corrections: `${base}/v1/monitor/corrections`,
      sellers: `${base}/v1/monitor/sellers`,
      refunds: `${MONITOR_TERMS.terms[0]} Contact via lumitrades.io.`,
      audit_reports: MONITOR_TERMS.terms[1],
      terms: MONITOR_TERMS,
      disclaimer: "Monitoring results are dated observations, not an endorsement, audit opinion or guarantee. Not financial advice.",
    };
  }

  // ---------------- enrolment

  /** OFAC SDN screen: a listed payTo is refused (and logged); Lumi never enrols, bills or test-buys it. */
  async function sanctioned(where: string, payTo: string | null | undefined, extra: Record<string, unknown> = {}) {
    if (!deps.sanctions || !payTo) return null;
    await deps.sanctions.ready();
    const hit = deps.sanctions.check(payTo);
    if (hit) deps.sanctions.refuse(where, hit, extra);
    return hit;
  }
  const sanctionedRes = (hit: { normalized: string; publication_date: string | null }) =>
    json(403, { error: "sanctioned_address", reason: "sanctioned_address", pay_to: hit.normalized, list: "OFAC SDN", publication_date: hit.publication_date, detail: "This payTo is listed on the U.S. Treasury OFAC SDN list. Lumi does not enrol, bill or test-buy it.", note: "Not charged." }, NO_STORE);

  async function checkEndpoint(raw: any, e: { address: string; network: string }, rate: number): Promise<{ ok: true; ep: MonitorEndpoint } | { ok: false; url: string; reason: string }> {
    const url = safeHttpsUrl(raw?.url);
    if (!url) return { ok: false, url: String(raw?.url ?? "").slice(0, 200), reason: "https URL with a public DNS name required" };
    const method = String(raw?.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const body = method === "POST" && raw?.body && typeof raw.body === "object" ? (raw.body as Record<string, unknown>) : undefined;
    let r: Response;
    try {
      r = await deps.endpointFetch(url, {
        method,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), "User-Agent": "LumiMonitor/1.0 (+https://api.lumitrades.io/v1/monitor)" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch {
      return { ok: false, url, reason: "no answer within 10 s" };
    }
    if (r.status !== 402) return { ok: false, url, reason: `expected an unpaid 402 quote, got HTTP ${r.status}` };
    const terms = await parse402(r);
    if (!terms) return { ok: false, url, reason: "402 without x402 accepts[]" };
    // The proven network, or Lumi's own configured network of the same family (identical to it in production).
    const fam = (n: string) => n.split(":")[0];
    const nets = new Set<string>([e.network, ...([deps.cfg.network, deps.cfg.evm?.network] as (string | undefined)[]).filter((n): n is string => !!n && fam(n) === fam(e.network))]);
    for (const a of terms.accepts as any[]) if (await sanctioned("monitor_enroll_quote", String(a?.payTo ?? ""), { url })) return { ok: false, url, reason: "sanctioned_address: the quote pays an OFAC SDN-listed address" };
    const mine = terms.accepts.filter((a: any) => nets.has(String(a?.network ?? "")) && String(a?.payTo ?? "").toLowerCase() === e.address.toLowerCase());
    if (!mine.length) return { ok: false, url, reason: `the quote does not pay the proven payTo on ${e.network}` };
    const priced = mine.map((a: any) => ({ a, usd: acceptUsd(a, rate) })).filter((x: any) => x.usd != null).sort((x: any, y: any) => x.usd - y.usd);
    if (!priced.length) return { ok: false, url, reason: "the quoted asset cannot be priced in USD (XRP, RLUSD, USDC supported)" };
    const best = priced[0] as { a: any; usd: number };
    if (best.usd > MONITOR_LIMITS.maxBuyUsd) {
      return { ok: false, url, reason: `price $${best.usd.toFixed(4)} per call exceeds the $${MONITOR_LIMITS.maxBuyUsd} per-test-buy cap funded from the plan fee: monitoring it would make the plan unprofitable` };
    }
    // Every chain the quote offers (cheapest option per network): used for chain rotation (Watch Plus) and multi-chain
    // test-buys (Watch Pro). Only the enrolled network's payTo is signature-proven; the others are as the seller's own 402 states.
    const byNet = new Map<string, EndpointChain>();
    for (const a of terms.accepts as any[]) {
      const net = String(a?.network ?? ""), to = String(a?.payTo ?? "");
      if (!net || !to) continue;
      const usd = acceptUsd(a, rate);
      const proven = nets.has(net) && to.toLowerCase() === e.address.toLowerCase();
      const cur = byNet.get(net);
      const better = !cur || (proven && !cur.proven) || (proven === cur.proven && usd != null && (cur.usd == null || usd < cur.usd));
      if (better) byNet.set(net, { network: net, pay_to: to, usd: usd == null ? null : Math.round(usd * 1e6) / 1e6, asset: acceptAsset(a), proven });
    }
    const chains = [...byNet.values()].sort((x, y) => Number(y.proven) - Number(x.proven)).slice(0, 6);
    return { ok: true, ep: { url, method, ...(body ? { body } : {}), price_usd: String(Math.round(best.usd * 1e6) / 1e6), asset: acceptAsset(best.a), amount: String(best.a.amount ?? ""), checked_at: now(), source: "seller", chains } };
  }

  async function enroll(request: Request, base: string) {
    const b = await readJson(request);
    if (!b) return bad("invalid_json", "POST a JSON object (max 32 KB).");
    const proof = await verifyProof(deps.cfg.invoiceSecret, "monitor-enroll", b, now(), deps.fetch, deps.xrplRpc);
    if (!proof.ok) return json(proof.reason === "ledger_unavailable_retry" ? 503 : 403, { error: "payto_proof_failed", reason: proof.reason, challenge: `${base}/v1/monitor/challenge?pay_to=<payTo>` }, NO_STORE);
    const lc = proof.address.toLowerCase();
    const sx = await sanctioned("monitor_enroll", proof.address);
    if (sx) return sanctionedRes(sx);
    const recent = (await store.enrollmentsByPayTo([lc])).filter((x) => x.created_at > now() - DAY_MS);
    if (recent.length >= ENROLL_PER_PAYTO_PER_DAY) return json(429, { error: "too_many_enrollments", detail: `At most ${ENROLL_PER_PAYTO_PER_DAY} enrolments per payTo per day.` }, NO_STORE);
    const webhook = b.webhook_url == null || b.webhook_url === "" ? null : safeHttpsUrl(b.webhook_url);
    if (b.webhook_url && !webhook) return bad("invalid_webhook_url", "https URL with a public DNS name required.");
    const email = b.email == null || b.email === "" ? null : safeEmail(b.email);
    if (b.email && !email) return bad("invalid_email");
    const raw: any[] = Array.isArray(b.endpoints) ? b.endpoints : [];
    if (raw.length > MAX_SELLER_ENDPOINTS) return bad("too_many_endpoints", `At most ${MAX_SELLER_ENDPOINTS} endpoints per enrolment.`);
    const uniq = [...new Map(raw.map((x) => [`${String(x?.method ?? "GET").toUpperCase()} ${x?.url}`, x])).values()];
    const rate = deps.cfg.xrpRate?.usd ?? deps.cfg.xrpUsdFallback;
    const checks = await Promise.all(uniq.map((x) => checkEndpoint(x, proof, rate)));
    const accepted = checks.filter((c): c is { ok: true; ep: MonitorEndpoint } => c.ok).map((c) => c.ep);
    const rejected = checks.filter((c): c is { ok: false; url: string; reason: string } => !c.ok).map(({ url, reason }) => ({ url, reason }));
    // Audit scope also covers every catalog listing that pays this payTo (quote-checked at audit time).
    const listed = await deps.catalogStore.byPayTos([lc], MONITOR_LIMITS.endpoints.audit).catch(() => []);
    const have = new Set(accepted.map((x) => x.url));
    const catalogEps: MonitorEndpoint[] = listed.filter((r) => !have.has(r.resource) && r.method !== "MCP").map((r) => ({
      url: r.resource, method: r.method === "POST" ? "POST" : "GET", price_usd: r.price_usd == null ? null : String(r.price_usd), asset: null, amount: null, checked_at: null, source: "catalog" as const,
    }));
    if (!accepted.length && !catalogEps.length) {
      return json(422, { error: "no_monitorable_endpoint", rejected, detail: "Nothing was enrolled. Fix the endpoints above and enrol again with a fresh challenge.", note: "Not charged." }, NO_STORE);
    }
    const token = `lumi_mt_${randHex(24)}`;
    const secret = webhook ? `lumi_whs_${randHex(24)}` : null;
    let domain: string | null = null;
    try { domain = accepted[0] ? new URL(accepted[0].url).hostname : catalogEps[0] ? new URL(catalogEps[0].url).hostname : null; } catch { /* none */ }
    const e: Enrollment = {
      id: `men_${randHex(12)}`, network: proof.network, pay_to: proof.address, pay_to_lc: lc, domain,
      proof: JSON.stringify({ challenge: b.message, signature: b.signature, public_key: b.public_key ?? null, signer: proof.signer }), nonce: proof.nonce,
      endpoints: [...accepted, ...catalogEps], webhook_url: webhook, webhook_secret: secret, email, token_hash: await sha256(token),
      is_test: isTestWallet(proof.address, deps.extraTestWallets), created_at: now(),
    };
    if ((await store.addEnrollment(e)) === "nonce_used") return json(409, { error: "challenge_already_used", detail: "Request a fresh challenge." }, NO_STORE);
    return json(201, {
      enrollment_id: e.id,
      pay_to: e.pay_to,
      network: e.network,
      ...(e.is_test ? { test: "Owner-flagged Lumi test wallet: plans quote the test price and are shown publicly as tests." } : {}),
      endpoints: e.endpoints.map(epView),
      rejected,
      plans: planEconomics(e),
      pay: Object.fromEntries(SOLD_MONITOR_PLANS.map((id) => [id, `${base}${PLANS[id].path}?enrollment=${e.id}${PLANS[id].perEndpoint ? `&endpoints=${defaultWatchEndpoints(e)}` : ""}`])),
      free_tier: `POST ${base}/v1/monitor/free {enrollment_id} (management token)`,
      trial: `GET ${base}/v1/monitor/trial/challenge?pay_to=${e.pay_to}&domain=${e.domain ?? "<domain>"}`,
      status_page: `${base}/v1/monitor/status/${e.id}`,
      management_token: token,
      ...(secret ? { webhook_secret: secret } : {}),
      alerts: { webhook: !!webhook, email: !!email },
      seller_page: `${base}/v1/monitor/sellers/${e.id}`,
      note: "Store the management token (replies, full audit report) and webhook secret now: Lumi keeps only hashes / cannot show them again. The seller page goes public once a plan is paid.",
    }, NO_STORE);
  }

  const epView = (x: MonitorEndpoint) => ({ url: x.url, method: x.method, source: x.source, listed_price_usd: x.price_usd, ...(x.asset ? { asset: x.asset } : {}), ...(x.chains && x.chains.length > 1 ? { chains: x.chains.map((c) => c.network) } : {}) });

  // ---------------- subscribe (x402)

  /** ?endpoints=N&terms=T for Watch tiers. Invalid values answer 400 before any quote (never charged). */
  function watchQty(url: URL, e: Enrollment | null): { ok: true; endpoints: number; terms: number } | { ok: false; res: Response } {
    const ep = url.searchParams.get("endpoints"), tm = url.searchParams.get("terms");
    const endpoints = ep == null || ep === "" ? (e ? defaultWatchEndpoints(e) : 1) : Number(ep);
    const terms = tm == null || tm === "" ? 1 : Number(tm);
    if (!Number.isInteger(endpoints) || endpoints < 1 || endpoints > WATCH_DISCOUNTS.maxEndpoints) return { ok: false, res: bad("invalid_endpoints", `endpoints must be an integer 1-${WATCH_DISCOUNTS.maxEndpoints}. Not charged.`) };
    if (terms !== 1 && terms !== WATCH_DISCOUNTS.prepayTerms) return { ok: false, res: bad("invalid_terms", `terms must be 1 or ${WATCH_DISCOUNTS.prepayTerms} (prepay ${WATCH_DISCOUNTS.prepayTerms} terms for -${WATCH_DISCOUNTS.prepay * 100}%). Not charged.`) };
    if (e && endpoints > sellerEps(e).length) return { ok: false, res: bad("endpoints_exceed_enrolled", `This enrolment has ${sellerEps(e).length} seller endpoint(s); enrol more before paying for ${endpoints}. Not charged.`) };
    return { ok: true, endpoints, terms };
  }

  async function subscribe(request: Request, url: URL, plan: PlanId, base: string, ctx?: WaitUntil) {
    const def = PLANS[plan];
    if (def.retired) return json(410, { error: "plan_retired", plan, detail: `${def.name} is no longer sold; existing terms run to their end. ${plan === "watch_plus" || plan === "watch_plus_founder" ? `Watch Plus was replaced by the test-buy packs (Re-test pack, Founder pack) next to Watch $${PLANS.watch.usd}: ${base}/v1/monitor/packs` : `Pick a Watch tier: ${base}/v1/monitor`}`, note: "Not charged." }, NO_STORE);
    const id = url.searchParams.get("enrollment") ?? "";
    const paid = !!(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT));
    const e = ENROLL_ID_RE.test(id) ? await store.enrollment(id) : null;
    const resourceUrl = `${base}${def.path}`;
    const per = !!def.perEndpoint;
    const qty = per ? watchQty(url, e) : ({ ok: true, endpoints: 1, terms: 1 } as const);
    if (!qty.ok) return qty.res;
    const qs = per ? `&endpoints=${qty.endpoints}&terms=${qty.terms}` : "";
    if (!e) {
      if (paid) return id
        ? bad("enrollment_unknown", `enrollment ${id.slice(0, 40)} is unknown. Enrol first (POST ${base}/v1/monitor/enroll); the payment was not settled.`, { docs: `${base}/v1/monitor` })
        : bad("enrollment_required", `Missing ?enrollment=. Enrol first (POST ${base}/v1/monitor/enroll); the payment was not settled.`, { docs: `${base}/v1/monitor` });
      const q = planQuote(deps.cfg, plan, "none", planPriceUsd(plan, false, undefined, qty), resourceUrl, false, qty);
      const what = per ? `List price for ${qty.endpoints} endpoint(s) × ${qty.terms} term(s) ($${def.usd} per endpoint per 30 days)` : "List price";
      q.note = id
        ? `${what}. enrollment_unknown: enrollment ${id.slice(0, 40)} is unknown. Pass an enrollment_id from POST ${base}/v1/monitor/enroll (free, requires a payTo signature). A payment without a valid enrollment is refused before settlement.`
        : `${what}. Add ?enrollment=<enrollment_id> from POST ${base}/v1/monitor/enroll (free, requires a payTo signature). A payment without a valid enrollment is refused before settlement.`;
      return paymentRequiredResponse(deps.cfg, q, id ? "enrollment_unknown" : "PAYMENT-SIGNATURE header is required");
    }
    const sx = await sanctioned("monitor_subscribe", e.pay_to, { enrollment_id: e.id });
    if (sx) return sanctionedRes(sx); // before any 402 or settlement
    if (def.pack) return buyPack(request, url, plan, e, base, ctx);
    const econ = (per ? watchEconomics(e, plan, qty.endpoints, qty.terms) : planEconomics(e)[plan]) as { eligible: boolean; reason?: string };
    if (!econ.eligible) return json(409, { error: "plan_not_eligible", plan, reason: econ.reason, enrollment_id: e.id, ...(per ? { endpoints: qty.endpoints, terms: qty.terms } : {}), note: "Not charged." }, NO_STORE);
    const usd = planPriceUsd(plan, e.is_test, deps.testPriceUsd, qty);
    const wp = per ? watchPrice(plan, qty.endpoints, qty.terms)! : null;
    const quote = planQuote(deps.cfg, plan, e.id, usd, `${resourceUrl}?enrollment=${e.id}${qs}`, e.is_test, qty);
    return requirePayment(request, deps.cfg, deps.paywall(ctx), quote, async (s: Settlement, req: PaymentRequirements) => {
      const t = now();
      const prev = (await store.plansFor(e.id)).filter((p) => p.plan === plan && p.ends_at > t);
      let start = plan === "audit" ? t : Math.max(t, ...prev.map((p) => p.ends_at));
      const tx = s.transaction || `unknown_${randHex(8)}`;
      const rows: PlanRow[] = [];
      for (let k = 1; k <= qty.terms; k++) {
        // Watch: the fee is split evenly over the prepaid terms; each term's test-buy budget is 50% of its share.
        const termUsd = wp ? Number(usd) / qty.terms : Number(usd);
        const budget = wp ? Math.round(wp.per_term_usd * MONITOR_LIMITS.budgetShare * 1e6) / 1e6 : Number(def.usd) * MONITOR_LIMITS.budgetShare;
        rows.push({
          id: `mpl_${randHex(10)}`, enrollment_id: e.id, plan, starts_at: start, ends_at: start + 30 * DAY_MS, paid_tx: k === 1 ? tx : `${tx}#${k}`,
          paid_network: s.network, paid_asset: assetLabel(req), paid_amount: k === 1 ? String(req.amount) : "0", payer: s.payer ?? null, usd: Math.round(termUsd * 1e6) / 1e6,
          budget_usd: budget, spent_usd: 0, is_test: e.is_test, reminded: 0, created_at: t, ...(per ? { endpoints: qty.endpoints, unit_usd: Number(def.usd) } : {}),
        });
        start += 30 * DAY_MS;
      }
      const ins: string[] = [];
      for (const row of rows) ins.push(await store.addPlan(row).catch((err) => { deps.log({ event: "monitor_plan_error", error: String(err) }); return "error" as const; }));
      deps.log({ event: "monitor_plan_paid", plan, enrollment: e.id, test: e.is_test, inserted: ins.join(","), ...(per ? { endpoints: qty.endpoints, terms: qty.terms } : {}) });
      const row = rows[0], last = rows[rows.length - 1];
      return json(201, {
        paid: true, plan: def.name, plan_id: row.id, ...(rows.length > 1 ? { plan_ids: rows.map((r) => r.id) } : {}), enrollment_id: e.id, ...(e.is_test ? { test: true, price_usd: usd } : { price_usd: usd }),
        ...(wp ? { endpoint_count: qty.endpoints, terms: qty.terms, price_per_endpoint_usd: def.usd, list_usd: String(wp.list_usd), discounts: { volume: wp.volume_discount, prepay: wp.prepay_discount, applied: wp.discount_applied, ...(wp.discount_not_stacked ? { not_stacked: wp.discount_not_stacked } : {}) } } : {}),
        starts_at: iso(row.starts_at), ...(plan === "audit" ? { one_off: true, report_due_by: iso(row.starts_at + 2 * DAY_MS) } : { ends_at: iso(last.ends_at) }), auto_renew: false,
        ...(plan === "audit" ? {} : { renew: `${resourceUrl}?enrollment=${e.id}${qs}` }), endpoints: planEndpoints(e, plan, per ? qty.endpoints : null).map(epView),
        seller_page: `${base}/v1/monitor/sellers/${e.id}`, status_page: `${base}/v1/monitor/status/${e.id}`, badge: `${base}/v1/monitor/badge/${e.id}.svg`,
        ...(def.legacy ? { legacy: "Grandfathered plan id; consider a Watch tier at renewal." } : {}),
        note: plan === "audit" ? "The audit runs within 48 h; the signed report appears on your seller page (full report with your management token)." : "First test-buy within 24 h. Alerts go to the webhook/email given at enrolment.",
      }, NO_STORE);
    });
  }

  // ---------------- public entries

  /** Public plan row. One-off Audit plans have no term, so they show no `until`. */
  function planView(p: PlanRow) {
    const oneOff = PLANS[p.plan as PlanId]?.days == null;
    return {
      plan: p.plan, from: iso(p.starts_at), ...(oneOff ? { one_off: true } : { until: iso(p.ends_at) }), ...(p.endpoints ? { endpoints: p.endpoints } : {}),
      ...(UNPAID.has(p.plan) ? { unpaid: true, label: p.plan === "watch_free" ? WATCH_FREE.label : WATCH_TRIAL.label } : {}), ...(PLANS[p.plan as PlanId]?.legacy ? { legacy: true } : {}), ...(p.is_test ? { test: true } : {}),
    };
  }

  async function sellerBundle(id: string) {
    if (!ENROLL_ID_RE.test(id)) return null;
    const e = await store.enrollment(id);
    if (!e) return null;
    const plans = await store.plansFor(id);
    if (!plans.length) return null; // not public until a plan is paid
    const urls = e.endpoints.map((x) => x.url);
    const [runs, findings, replies, baseline] = await Promise.all([
      store.runsFor(id, 200), store.findingsFor(id, 100), store.repliesFor(id),
      // Lumi's own baseline buys of these endpoints: pooled with paid runs for the one-counted-buy-per-day rule (read-only).
      urls.length ? deps.catalogStore.buysFor(urls).catch((err) => { deps.log({ event: "monitor_baseline_read_error", error: String(err) }); return [] as BuyRow[]; }) : Promise.resolve([] as BuyRow[]),
    ]);
    return { e, plans, runs, findings, replies, baseline };
  }

  function relationshipView(e: Enrollment, plans: PlanRow[], base: string) {
    const t = now();
    const cur = plans.filter((p) => p.starts_at <= t && t < p.ends_at);
    const paidEver = plans.some((p) => !UNPAID.has(p.plan));
    return {
      type: "seller_monitoring",
      status: cur.length ? "active" : "past",
      plans: plans.slice(0, 10).map(planView),
      disclosure: paidEver
        ? "This seller pays Lumi for monitoring (seller-funded test-buys). Paying never changes Lumi's score, tier or labels."
        : "This seller uses Lumi's free monitoring (free tier or a Lumi-funded trial; no payment). Monitoring never changes Lumi's score, tier or labels.",
      ...(paidEver ? {} : { unpaid: true }),
      seller_page: `${base}/v1/monitor/sellers/${e.id}`,
      ...(e.is_test ? { test: "Lumi's own wallet, enrolled as a test" } : {}),
    };
  }

  async function sellerPage(id: string, base: string) {
    const x = await sellerBundle(id);
    if (!x) return json(404, { error: "not_found", detail: "Unknown enrollment, or no plan paid yet (entries are public once a plan is paid)." }, { "Cache-Control": "public, max-age=60" });
    const { e, plans, findings, replies } = x;
    const st = tierState(plans, now());
    // Frozen after an unpaid trial: history stops at the trial end (read-only) until the seller pays.
    const runs = st.frozen ? x.runs.filter((r) => r.ts <= st.freezeAt!) : x.runs;
    const baseline = st.frozen ? x.baseline.filter((b) => b.ts <= st.freezeAt!) : x.baseline;
    const badge = badgeStatus(e, plans, runs, now(), baseline);
    const pooled = countBuys(runs, baseline);
    const flag = new Map(pooled.filter((b) => b.run).map((b) => [b.run!, b]));
    const reports = await Promise.all(plans.filter((p) => p.plan === "audit" || p.plan === "watch_pro").map((p) => store.report(p.id)));
    return json(200, {
      kind: "lumi_monitored_seller",
      enrollment_id: e.id,
      pay_to: e.pay_to,
      network: e.network,
      domain: e.domain,
      ...(e.is_test ? { test: true } : {}),
      tier: st.top?.plan ?? null, tier_label: tierLabel(st.top?.plan),
      ...(st.frozen ? { frozen: true, frozen_at: iso(st.freezeAt!), frozen_note: `${WATCH_TRIAL_END} Pay a plan to resume.` } : {}),
      status_page: `${base}/v1/monitor/status/${e.id}`,
      commercial_relationship: relationshipView(e, plans, base),
      badge: { ...badgeJson(e, badge), svg: `${base}/v1/monitor/badge/${e.id}.svg`, json: `${base}/v1/monitor/badge/${e.id}.json` },
      endpoints: e.endpoints.map(epView),
      test_buys: runs.slice(0, 30).map((r) => { const c = flag.get(r); return { endpoint: r.endpoint, tested_at: iso(r.ts), outcome: r.outcome, http_status: r.http_status, data_returned: r.data_returned, funding: r.funding, ...(r.network ? { network: r.network } : {}), counted: !!c?.counted, ...(c?.not_counted_reason ? { not_counted_reason: c.not_counted_reason } : !c ? { not_counted_reason: "not_a_test_buy" } : {}) }; }),
      lumi_baseline_buys: pooled.filter((b) => b.source === "lumi_baseline").slice(0, 30).map((b) => ({ endpoint: b.endpoint, tested_at: iso(b.ts), delivered: b.delivered, funding: "lumi", counted: b.counted, ...(b.not_counted_reason ? { not_counted_reason: b.not_counted_reason } : {}) })),
      counting: COUNTING_TEXT,
      findings: (st.frozen ? findings.filter((f) => f.ts <= st.freezeAt!) : findings).map((f) => ({ id: f.id, at: iso(f.ts), kind: f.kind, endpoint: f.endpoint, detail: f.detail, replies: replies.filter((r) => r.finding_id === f.id).map((r) => ({ at: iso(r.ts), by: "seller", text: r.text })) })),
      audit_reports: reports.filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ plan_id: r.plan_id, kind: plans.find((p) => p.id === r.plan_id)?.plan === "watch_pro" ? "watch_pro_monthly" : "audit", signed_at: iso(r.created_at), report_hash: r.report_hash, signer: r.signer, signature: r.signature, public_key: r.public_key, signed_message: `lumi-audit-report:${r.plan_id}:${r.report_hash}`, full_report: `${base}/v1/monitor/sellers/${e.id}/report?plan_id=${r.plan_id} (management token or the seller's own copy)` })),
      evidence: "Answer-only: test-buy outcomes and dates. Tx hashes are in the seller's signed audit report and Lumi's paid trust products.",
      safeguards: MONITOR_SAFEGUARDS,
      corrections: `${base}/v1/monitor/corrections`,
      disclaimer: "Dated observations, not an endorsement or guarantee. Not financial advice.",
    }, { "Cache-Control": "public, max-age=60" });
  }

  const badgeLabel = (e: Enrollment, plan: string) => (e.is_test ? TEST_BADGE_LABEL : plan === "watch_plus_trial" ? TRIAL_BADGE_LABEL : isPack(plan) ? PACK_BADGE_LABEL : PAID_BADGE_LABEL);

  function badgeJson(e: Enrollment, b: ReturnType<typeof badgeStatus>) {
    if (b.ok) return { status: "monitored", label: badgeLabel(e, b.plan.plan), paid: !e.is_test && !UNPAID.has(b.plan.plan), last_test: iso(b.last_test), result: b.result, plan: b.plan.plan, ...(b.plan.plan === "watch_plus_trial" ? { trial: true } : {}), ...(e.is_test ? { test: true } : {}) };
    return { status: "removed", label: "Lumi monitoring", reason: b.reason, reason_text: REASON_TEXT[b.reason], ...("last_test" in b && b.last_test ? { last_test: iso(b.last_test) } : {}) };
  }

  async function badge(id: string, fmt: string, base: string) {
    const x = await sellerBundle(id);
    const hdr = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" };
    if (!x) {
      if (fmt === "json") return json(404, { status: "unknown", detail: "No monitored seller with this id." }, hdr);
      return new Response(badgeSvg("Lumi monitoring", "unknown seller", false), { status: 404, headers: { ...hdr, "Content-Type": "image/svg+xml" } });
    }
    const b = badgeStatus(x.e, x.plans, x.runs, now(), x.baseline);
    const j = { ...badgeJson(x.e, b), enrollment_id: id, seller_page: `${base}/v1/monitor/sellers/${id}`, live: true, last_test_is: "the date of the last delivered counted test-buy (never the render date)", rules: COUNTING_TEXT, note: "Computed on every request: removed automatically when the latest counted test-buy of an endpoint failed, no counted test-buy delivered in the window, or the plan lapses." };
    if (fmt === "json") return json(200, j, hdr);
    const right = b.ok ? `last test ${iso(b.last_test)!.slice(0, 10)} · ${b.result}${x.e.is_test ? " · test" : ""}` : `badge removed: ${REASON_TEXT[b.reason]}`;
    return new Response(badgeSvg(b.ok ? badgeLabel(x.e, b.plan.plan) : "Lumi monitoring", right, b.ok), { headers: { ...hdr, "Content-Type": "image/svg+xml" } });
  }

  async function sellers(base: string) {
    const all = await store.enrollments(200);
    const t = now();
    const out = [];
    let tests = 0, unpaid = 0;
    for (const e of all.slice(0, 40)) {
      const plans = await store.plansFor(e.id);
      if (!plans.length) continue;
      if (e.is_test) { tests++; continue; } // Lumi's own test enrolments are not paying sellers
      if (!plans.some((p) => !UNPAID.has(p.plan))) { unpaid++; continue; } // free tier / trial only: not a paying seller
      out.push({ enrollment_id: e.id, pay_to: e.pay_to, network: e.network, domain: e.domain, status: plans.some((p) => p.starts_at <= t && t < p.ends_at) ? "active" : "past", ...(e.is_test ? { test: true } : {}), page: `${base}/v1/monitor/sellers/${e.id}` });
    }
    return json(200, { kind: "lumi_monitored_sellers", sellers: out, count: out.length, excluded_test_enrollments: tests, excluded_free_or_trial_only: unpaid,
      disclosure: SELLERS_DISCLOSURE, ...(out.length ? {} : { note: "No paying seller yet." }), docs: `${base}/v1/monitor` }, { "Cache-Control": "public, max-age=120" });
  }

  async function tokenOk(request: Request, e: Enrollment) {
    const t = bearer(request);
    return !!t && (await sha256(t)) === e.token_hash;
  }

  async function reply(request: Request) {
    // No credentials at all -> 401 up front, so an unauthenticated caller never sees 404 unknown_enrollment
    if (!bearer(request)) return json(401, { error: "management_token_required", hint: "Authorization: Bearer <management token from enrolment>" }, { ...NO_STORE, "WWW-Authenticate": "Bearer" });
    const b = await readJson(request, 8000);
    if (!b) return bad("invalid_json");
    const e = ENROLL_ID_RE.test(String(b.enrollment_id ?? "")) ? await store.enrollment(String(b.enrollment_id)) : null;
    if (!e) return json(404, { error: "unknown_enrollment" }, NO_STORE);
    if (!(await tokenOk(request, e))) return json(401, { error: "management_token_required", hint: "Authorization: Bearer <management token from enrolment>" }, NO_STORE);
    const text = typeof b.text === "string" ? b.text.trim().replace(/[\u0000-\u0008\u000b-\u001f]/g, "") : "";
    if (!text || text.length > 1000) return bad("text_required", "1-1000 characters.");
    const fid = Number(b.finding_id);
    const f = (await store.findingsFor(e.id, 500)).find((x) => x.id === fid);
    if (!f) return json(404, { error: "unknown_finding" }, NO_STORE);
    const id = await store.addReply({ enrollment_id: e.id, finding_id: fid, ts: now(), text });
    return json(201, { replied: true, reply_id: id, note: "Shown next to the finding. Findings themselves cannot be edited or removed." }, NO_STORE);
  }

  async function sellerReport(request: Request, id: string, url: URL) {
    const e = ENROLL_ID_RE.test(id) ? await store.enrollment(id) : null;
    if (!e) return json(404, { error: "not_found" }, NO_STORE);
    if (!(await tokenOk(request, e)) && !(await deps.isOwner(request))) return json(401, { error: "management_token_required" }, NO_STORE);
    const r = await store.report(url.searchParams.get("plan_id") ?? "");
    if (!r || r.enrollment_id !== e.id) return json(404, { error: "no_report" }, NO_STORE);
    return json(200, { report: JSON.parse(r.report), report_hash: r.report_hash, signed_message: `lumi-audit-report:${r.plan_id}:${r.report_hash}`, signature: r.signature, public_key: r.public_key, signer: r.signer, verify: "sha256(canonical JSON of report) = report_hash; ripple-keypairs verify(utf8hex(signed_message), signature, public_key) and deriveAddress(public_key) = signer (Lumi's XRPL payTo)." }, NO_STORE);
  }

  async function corrections() {
    const c = await store.corrections(200);
    return json(200, { kind: "lumi_correction_log", corrections: c.map((x) => ({ id: x.id, at: iso(x.ts), subject: x.subject, summary: x.summary, ref: x.ref })), note: "Append-only. Every correction Lumi makes to published observations is listed here." }, { "Cache-Control": "public, max-age=120" });
  }

  // ---------------- alerts

  async function deliver(e: Enrollment, f: FindingRow, base: string): Promise<string[]> {
    const via: string[] = [];
    const page = `${base}/v1/monitor/sellers/${e.id}`;
    if (e.webhook_url && e.webhook_secret) {
      const body = JSON.stringify({ type: "lumi.monitor.finding", enrollment_id: e.id, finding: { id: f.id, kind: f.kind, endpoint: f.endpoint, detail: f.detail, at: iso(f.ts) }, seller_page: page, ...(e.is_test ? { test: true } : {}) });
      const ts = Math.floor(now() / 1000);
      const sig = await hmacHex(e.webhook_secret, `${ts}.${body}`);
      try {
        const r = await deps.fetch(e.webhook_url, { method: "POST", headers: { "Content-Type": "application/json", "X-Lumi-Signature": `t=${ts},v1=${sig}`, "User-Agent": "LumiMonitor/1.0" }, body, signal: AbortSignal.timeout(8000), redirect: "manual" });
        if (r.ok) via.push("webhook");
      } catch { /* best effort */ }
    }
    if (e.email) {
      const text = `Lumi monitoring alert (${f.kind})${e.is_test ? " [test]" : ""}\n\n${f.endpoint ? `Endpoint: ${f.endpoint}\n` : ""}${f.detail}\n\nSeller page: ${page}\nReply to a finding: POST ${base}/v1/monitor/replies with your management token.\n`;
      if (await sendPlainEmail({ emailFrom: deps.email.from, emailBinding: deps.email.binding, makeMessage: deps.email.makeMessage }, e.email, `Lumi monitor: ${f.kind}${f.endpoint ? ` ${f.endpoint}` : ""}`, text, `mon.${e.id}.${f.id}.${f.ts}`)) via.push("email");
    }
    if (f.id) await store.setDelivered(f.id, via.join(",") || "none").catch(() => {});
    return via;
  }

  // ---------------- owner: due tasks, results, reports

  const fundingOf = (plan: string) => (plan === "watch_plus_trial" ? "lumi-funded (free trial)" : "seller-funded");

  async function due(base: string) {
    const t = now();
    // The free tier has no test-buys (quote probes only: GET /v1/owner/monitor/probes).
    // Test-buy packs are not scheduled: their buys come from the seller-queued jobs listed under pack_jobs.
    const plans = (await store.plansEndingAfter(t)).filter((p) => p.starts_at <= t && p.plan !== "watch_free" && !isPack(p.plan)).slice(0, 10);
    const tasks: Record<string, unknown>[] = [];
    const reportsDue: Record<string, unknown>[] = [];
    for (const p of plans) {
      const e = await store.enrollment(p.enrollment_id);
      if (!e) continue;
      if (p.plan === "audit" && (await store.report(p.id))) continue;
      if (await sanctioned("monitor_due", e.pay_to, { enrollment_id: e.id, plan_id: p.id })) continue; // never hand a listed payTo to the test-buy runner
      const runs = (await store.runsFor(e.id, 400)).filter((r) => r.plan_id === p.id);
      let budgetLeft = p.budget_usd - p.spent_usd;
      const tier = watchTier(p.plan);
      if (tier?.signedReport && t >= p.ends_at - 2 * DAY_MS && !(await store.report(p.id))) {
        reportsDue.push({ plan_id: p.id, enrollment_id: e.id, plan: p.plan, draft: `${base}/v1/owner/monitor/report-draft?enrollment_id=${e.id}&plan_id=${p.id}`, post: `${base}/v1/owner/monitor/report` });
      }
      for (const ep of planEndpoints(e, p.plan, p.endpoints)) {
        const mine = runs.filter((r) => r.endpoint === ep.url);
        const last = mine[0];
        if (tier) {
          // Watch tiers / trial: cadence per tier; Plus rotates chains, Pro: daily buys on up to 3 chains, limited by the test-buy budget.
          const chains = buyChains(ep, e, tier.maxBuyUsd);
          const primary: EndpointChain = { network: e.network, pay_to: e.pay_to, usd: ep.price_usd == null ? null : Number(ep.price_usd), asset: ep.asset, proven: true };
          let pick: { chain: EndpointChain; done: RunRow[] }[] = [];
          if (typeof tier.chains === "number") {
            pick = chains.slice(0, tier.chains as number).map((c) => ({ chain: c, done: mine.filter((r) => (r.network ?? e.network) === c.network) }));
          } else if (tier.chains === "rotate" && chains.length) {
            pick = [{ chain: chains[mine.length % chains.length], done: mine }];
          } else {
            pick = [{ chain: chains[0] ?? primary, done: mine }];
          }
          if (!chains.length) pick = [{ chain: primary, done: mine }];
          for (const { chain, done } of pick) {
            const lastOn = done[0];
            const isDue = done.length < tier.buysPerTerm && (!lastOn || t - lastOn.ts >= tier.buyEveryMs - HOUR_MS);
            if (!isDue) continue;
            const price = chain.usd;
            const buy = price != null && price <= tier.maxBuyUsd && price <= budgetLeft + 1e-9;
            const left = budgetLeft; // max_usd never exceeds the remaining budget (the trial's total cap holds even with price slippage)
            if (buy) budgetLeft -= price!;
            tasks.push({
              plan_id: p.id, plan: p.plan, enrollment_id: e.id, network: chain.network, pay_to: chain.pay_to, ...(chain.proven ? {} : { pay_to_proven: false }),
              endpoint: { url: ep.url, method: ep.method, ...(ep.body ? { body: ep.body } : {}) },
              mode: buy ? "buy" : "quote_only", max_usd: buy ? Math.round(Math.min(tier.maxBuyUsd, price! * 1.15, left) * 1e6) / 1e6 : 0, enrolled_price_usd: price == null ? ep.price_usd : String(price),
              funding: fundingOf(p.plan), ...(p.is_test ? { test: true } : {}),
              ...(!buy ? { why: price == null ? "unpriced listing" : price > tier.maxBuyUsd ? `above the $${tier.maxBuyUsd} cap of ${tier.name}` : p.plan === "watch_plus_trial" ? `trial test-buy cap ($${WATCH_TRIAL.capUsd}) used` : "plan test-buy budget used" } : {}),
            });
            if (tasks.length >= 25) break;
          }
          if (tasks.length >= 25) break;
          continue;
        }
        let isDue = false;
        if (p.plan === "monitor") isDue = mine.length === 0 || (mine.length === 1 && failed(last) && t - last.ts > HOUR_MS);
        else if (p.plan === "monitor_plus") isDue = mine.length < MONITOR_LIMITS.buysPerEndpoint.monitor_plus && (!last || t - last.ts >= MONITOR_LIMITS.everyMs.monitor_plus - HOUR_MS);
        else isDue = mine.length === 0;
        if (!isDue) continue;
        const price = ep.price_usd == null ? null : Number(ep.price_usd);
        const buy = price != null && price <= MONITOR_LIMITS.maxBuyUsd && price <= budgetLeft;
        if (buy) budgetLeft -= price!;
        tasks.push({
          plan_id: p.id, plan: p.plan, enrollment_id: e.id, network: e.network, pay_to: e.pay_to, endpoint: { url: ep.url, method: ep.method, ...(ep.body ? { body: ep.body } : {}) },
          mode: buy ? "buy" : "quote_only", max_usd: buy ? Math.min(MONITOR_LIMITS.maxBuyUsd, price! * 1.15) : 0, enrolled_price_usd: ep.price_usd, ...(p.is_test ? { test: true } : {}),
          ...(!buy ? { why: price == null ? "unpriced listing" : price > MONITOR_LIMITS.maxBuyUsd ? "above the $0.10 cap" : "plan test-buy budget used" } : {}),
        });
        if (tasks.length >= 25) break;
      }
      if (tasks.length >= 25) break;
    }
    const packJobs = await packJobTasks(t);
    return json(200, { kind: "monitor_due", generated_at: iso(t), tasks, ...(reportsDue.length ? { reports_due: reportsDue } : {}), pack_jobs: packJobs,
      ...(packJobs.length ? { pack_jobs_how: `Run each pack job as one test-buy (preflight the 402 first; never above max_usd), then POST ${base}/v1/owner/monitor/results with plan_id, endpoint and pack_job_id. Cancel a job you cannot run (fault on Lumi's side; the buy returns to the pack): POST ${base}/v1/owner/monitor/packs/cancel {job_id, note}.` } : {}),
      post_results: `${base}/v1/owner/monitor/results` }, NO_STORE);
  }

  /** XRP amounts are stored in drops; show them in XRP. */
  const amt = (a: string | null, asset: string | null) => (a == null ? "?" : asset === "XRP" && /^\d+$/.test(a) ? `${Number(a) / 1e6} XRP` : `${a} ${asset ?? ""}`.trim());

  function priceChanged(prev: { amount: string | null; asset: string | null; usd: number | null }, cur: { amount: string | null; asset: string | null; usd: number | null }) {
    if (!cur.asset || !prev.asset) return false;
    if (prev.asset !== cur.asset) {
      // A different payment option of the same quote (e.g. enrolled RLUSD, bought XRP): compare in USD, never by asset alone.
      if (prev.usd == null || cur.usd == null || prev.usd === 0) return false;
      return Math.abs(cur.usd - prev.usd) / prev.usd > 0.1;
    }
    if (prev.amount === cur.amount) return false;
    if (prev.usd == null || cur.usd == null || prev.usd === 0) return prev.amount !== cur.amount;
    return Math.abs(cur.usd - prev.usd) / prev.usd > 0.1;
  }

  async function results(request: Request, base: string, ctx?: WaitUntil) {
    const b = await readJson(request, 64_000);
    const list: any[] = Array.isArray(b?.results) ? b!.results.slice(0, 25) : [];
    if (!list.length) return bad("results_required");
    const t = now();
    const out: unknown[] = [];
    const cache = new Map<string, { e: Enrollment; plans: PlanRow[]; runs: RunRow[] }>();
    const alerts: Promise<unknown>[] = [];
    for (const x of list) {
      const eid = String(x?.enrollment_id ?? "");
      let c = cache.get(eid);
      if (!c) {
        const e = ENROLL_ID_RE.test(eid) ? await store.enrollment(eid) : null;
        if (!e) { out.push({ error: "unknown_enrollment", enrollment_id: eid }); continue; }
        c = { e, plans: await store.plansFor(eid), runs: await store.runsFor(eid, 200) };
        cache.set(eid, c);
      }
      const plan = c.plans.find((p) => p.id === x.plan_id);
      const ep = c.e.endpoints.find((y) => y.url === x.endpoint);
      if (!plan || !ep) { out.push({ error: "unknown_plan_or_endpoint", plan_id: x.plan_id, endpoint: x.endpoint }); continue; }
      const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
      const str = (v: unknown, n = 200) => (v == null || v === "" ? null : String(v).slice(0, n));
      const tier = watchTier(plan.plan);
      if (plan.plan === "watch_free" && x.tx_hash) { out.push({ error: "free_tier_no_test_buys", plan_id: plan.id, endpoint: ep.url }); continue; }
      // A trial (or free tier) that has ended is frozen: nothing new is recorded on it.
      if (UNPAID.has(plan.plan) && (num(x.ts) ?? t) >= plan.ends_at) { out.push({ error: "plan_frozen", plan_id: plan.id, endpoint: ep.url }); continue; }
      // Pack rows record a run only against a queued job of that pack and endpoint (one job = one counted test-buy).
      let packJob: PackJobRow | null = null;
      if (isPack(plan.plan)) {
        packJob = x.pack_job_id ? await store.packJob(String(x.pack_job_id).slice(0, 40)) : null;
        if (!packJob || packJob.plan_id !== plan.id || packJob.endpoint !== ep.url) { out.push({ error: "pack_job_required", plan_id: plan.id, endpoint: ep.url, detail: "Pack runs need the pack_job_id of a queued job for this pack and endpoint (GET /v1/owner/monitor/due -> pack_jobs)." }); continue; }
        if (packJob.status !== "queued") { out.push({ error: "pack_job_not_queued", pack_job_id: packJob.id, status: packJob.status }); continue; }
      }
      const cost = Math.max(0, Math.min(tier ? tier.maxBuyUsd : isPack(plan.plan) ? PACK_LIMITS.maxBuyUsd : MONITOR_LIMITS.maxBuyUsd, num(x.cost_usd) ?? 0));
      const run: RunRow = {
        enrollment_id: c.e.id, plan_id: plan.id, endpoint: ep.url, ts: num(x.ts) ?? t, network: str(x.network, 40), tx_hash: str(x.tx_hash, 100), amount: str(x.amount, 40), asset: str(x.asset, 60),
        cost_usd: x.tx_hash ? cost : 0, http_status: num(x.http_status), data_returned: x.data_returned === true, latency_ms: num(x.latency_ms),
        outcome: ["delivered", "no_data", "invalid_data", "error_status", "timeout", "quote_failed", "quote_only", "skipped"].includes(x.outcome) ? x.outcome : "skipped",
        quote_pay_to: str(x.quote_pay_to, 80), quote_price_usd: str(x.quote_price_usd, 20), schema_hash: str(x.schema_hash, 80), note: str(x.note, 300), funding: fundingOf(plan.plan),
      };
      // The payTo to compare against: the enrolled one, or (Watch Plus / Pro rotation) the payTo that chain's 402 showed at enrolment.
      const chainPayTo = (run.network && run.network !== c.e.network ? ep.chains?.find((ch) => ch.network === run.network)?.pay_to : null) ?? c.e.pay_to;
      const netOf = (r: RunRow) => r.network ?? c!.e.network;
      // Chain rotation: compare with the previous test on the same chain, so a different chain's price is not "a change".
      const prev = c.runs.find((r) => r.endpoint === ep.url && r.outcome !== "skipped" && (!tier || netOf(r) === netOf(run)));
      const otherChain = netOf(run) !== c.e.network;
      const runId = await store.addRun(run);
      run.id = runId;
      if (run.cost_usd) await store.addSpent(plan.id, run.cost_usd);
      if (packJob) await store.setPackJob(packJob.id, { status: "done", run_id: runId, updated_at: t });
      const kinds: { kind: string; detail: string }[] = [];
      const paidNote = run.tx_hash ? "Payment settled" : "Paid retry";
      if (run.outcome === "no_data") kinds.push({ kind: "paid_no_data", detail: `${paidNote} but no data came back (HTTP ${run.http_status ?? "?"}).` });
      if (run.outcome === "invalid_data") kinds.push({ kind: "paid_invalid_data", detail: `${paidNote} but the body was not valid data (${run.note ?? "unparseable"}).` });
      if (run.outcome === "error_status") kinds.push({ kind: (run.http_status ?? 0) >= 500 ? "http_5xx" : "http_error", detail: `${paidNote}; the endpoint answered HTTP ${run.http_status ?? "?"}.` });
      if (run.outcome === "timeout") kinds.push({ kind: "timeout", detail: "No answer within 20 s." });
      if (run.outcome === "quote_failed") kinds.push({ kind: "http_error", detail: `The unpaid request did not return a valid x402 quote (${run.note ?? "no 402"}).` });
      if (run.quote_pay_to && run.quote_pay_to.toLowerCase() !== chainPayTo.toLowerCase() && (!prev || (prev.quote_pay_to ?? "").toLowerCase() !== run.quote_pay_to.toLowerCase())) {
        kinds.push({ kind: "pay_to_changed", detail: `The quote now pays ${run.quote_pay_to}, not the enrolled payTo ${chainPayTo}.` });
      }
      const base0 = prev ? { amount: prev.amount, asset: prev.asset, usd: num(prev.quote_price_usd) } : { amount: ep.amount, asset: ep.asset, usd: num(ep.price_usd) };
      if (!(otherChain && !prev) && priceChanged(base0, { amount: run.amount, asset: run.asset, usd: num(run.quote_price_usd) })) {
        kinds.push({ kind: "price_changed", detail: `Quoted price changed from ${amt(base0.amount, base0.asset)} (~$${base0.usd ?? "?"}) to ${amt(run.amount, run.asset)} (~$${run.quote_price_usd ?? "?"}).` });
      }
      if ((!tier || tier.schemaAlerts) && prev?.schema_hash && run.schema_hash && prev.schema_hash !== run.schema_hash && run.outcome === "delivered") kinds.push({ kind: "schema_changed", detail: "The structure (keys/types) of the paid response changed since the previous test." });
      if (failed(prev) && run.outcome === "delivered") kinds.push({ kind: "recovered", detail: "The endpoint delivers again after a failed test." });
      const fids: number[] = [];
      for (const k of kinds) {
        const f: FindingRow = { enrollment_id: c.e.id, endpoint: ep.url, ts: run.ts, kind: k.kind, detail: k.detail, run_id: runId, delivered: null };
        f.id = await store.addFinding(f);
        fids.push(f.id);
        alerts.push(deliver(c.e, f, base));
      }
      c.runs.unshift(run);
      out.push({ run_id: runId, endpoint: ep.url, outcome: run.outcome, findings: kinds.map((k) => k.kind), finding_ids: fids, ...(packJob ? { pack_job_id: packJob.id, pack_job: "done" } : {}) });
    }
    const all = Promise.allSettled(alerts);
    if (ctx) ctx.waitUntil(all); else await all;
    return json(200, { recorded: out }, NO_STORE);
  }

  const REPORT_PLANS = new Set(["audit", "watch_pro"]);

  async function reportDraft(url: URL) {
    const pid = url.searchParams.get("plan_id") ?? "";
    const eid = url.searchParams.get("enrollment_id") ?? "";
    const e = ENROLL_ID_RE.test(eid) ? await store.enrollment(eid) : null;
    const plan = e ? (await store.plansFor(e.id)).find((p) => p.id === pid && REPORT_PLANS.has(p.plan)) : undefined;
    if (!e || !plan) return json(404, { error: "unknown_audit_plan", detail: "Signed reports exist for audit and Watch Pro plans." }, NO_STORE);
    const pro = plan.plan === "watch_pro";
    const runs = (await store.runsFor(e.id, 400)).filter((r) => r.plan_id === plan.id);
    const findings = (await store.findingsFor(e.id, 200)).filter((f) => runs.some((r) => r.id === f.run_id));
    const eps = planEndpoints(e, plan.plan, plan.endpoints).map((ep) => {
      const r = runs.find((x) => x.endpoint === ep.url);
      return {
        url: ep.url, method: ep.method, source: ep.source, enrolled_price_usd: ep.price_usd,
        result: r ? { tested_at: iso(r.ts), outcome: r.outcome, http_status: r.http_status, data_returned: r.data_returned, latency_ms: r.latency_ms, quote_pay_to: r.quote_pay_to, pays_enrolled_pay_to: r.quote_pay_to ? r.quote_pay_to.toLowerCase() === e.pay_to_lc : null, quoted: r.amount ? `${r.amount} ${r.asset}` : null, quote_price_usd: r.quote_price_usd, tx_hash: r.tx_hash, explorer: r.tx_hash && r.network ? explorerFor(r.network, r.tx_hash) : null, cost_usd: r.cost_usd, funding: r.funding, note: r.note } : { outcome: "not_tested" },
      };
    });
    const count = (o: string) => eps.filter((x) => (x.result as any).outcome === o).length;
    const report = {
      kind: pro ? "lumi_watch_pro_monthly_report" : "lumi_audit_report", version: 1, plan_id: plan.id, enrollment_id: e.id,
      ...(pro ? { period: { from: iso(plan.starts_at), to: iso(plan.ends_at) }, test_buys: runs.length, delivered_runs: runs.filter((r) => r.outcome === "delivered").length, chains: [...new Set(runs.map((r) => r.network).filter(Boolean))] } : {}),
      seller: { pay_to: e.pay_to, network: e.network, domain: e.domain }, ...(plan.is_test ? { test: true } : {}),
      paid: { tx: plan.paid_tx, network: plan.paid_network, asset: plan.paid_asset, amount: plan.paid_amount, at: iso(plan.created_at) },
      summary: { endpoints: eps.length, bought: eps.filter((x) => (x.result as any).tx_hash).length, delivered: count("delivered"), failed: eps.filter((x) => failed({ outcome: (x.result as any).outcome } as RunRow) && (x.result as any).outcome !== "not_tested").length, quote_only: count("quote_only"), not_tested: count("not_tested"), test_buy_spend_usd: Math.round(runs.reduce((s, r) => s + r.cost_usd, 0) * 1e6) / 1e6 },
      endpoints: eps,
      findings: findings.map((f) => ({ kind: f.kind, endpoint: f.endpoint, at: iso(f.ts), detail: f.detail })),
      funding: "seller-funded",
      methodology: MONITOR_METHODOLOGY.checks,
      disclaimer: "Dated observations of single test-buys, not an endorsement, audit opinion or guarantee. Not financial advice.",
      generated_at: iso(now()),
    };
    const report_hash = await sha256(canonicalJson(report));
    return json(200, { report, report_hash, message: `lumi-audit-report:${plan.id}:${report_hash}`, sign_with: deps.reportSigners[0] }, NO_STORE);
  }

  async function putReport(request: Request) {
    const b = await readJson(request, 200_000);
    if (!b?.report || typeof b.report !== "object") return bad("report_required");
    const hash = await sha256(canonicalJson(b.report));
    if (hash !== b.report_hash) return bad("report_hash_mismatch");
    const pid = String(b.report.plan_id ?? ""), eid = String(b.report.enrollment_id ?? "");
    const plan = ENROLL_ID_RE.test(eid) ? (await store.plansFor(eid)).find((p) => p.id === pid && REPORT_PLANS.has(p.plan)) : undefined;
    if (!plan) return json(404, { error: "unknown_audit_plan" }, NO_STORE);
    const msg = `lumi-audit-report:${pid}:${hash}`;
    const pk = String(b.public_key ?? ""), sig = String(b.signature ?? "");
    const signer = pk ? xrplAddressOf(pk) : null;
    if (!signer || !deps.reportSigners.includes(signer) || !verifyXrplSignature(msg, sig, pk)) return json(403, { error: "bad_report_signature", detail: "Must be signed by Lumi's XRPL payTo key." }, NO_STORE);
    await store.putReport({ plan_id: pid, enrollment_id: eid, report: canonicalJson(b.report), report_hash: hash, signature: sig, public_key: pk, signer, created_at: now() });
    return json(201, { stored: true, plan_id: pid, report_hash: hash, signer }, NO_STORE);
  }

  async function owner(base: string) {
    const es = await store.enrollments(50);
    const t = now();
    const rows = [];
    for (const e of es.slice(0, 20)) {
      const plans = await store.plansFor(e.id);
      rows.push({ enrollment_id: e.id, tier: tierState(plans, t).top?.plan ?? null, pay_to: e.pay_to, network: e.network, test: e.is_test, alerts: { webhook: !!e.webhook_url, email: !!e.email }, endpoints: e.endpoints.length, created_at: iso(e.created_at),
        plans: plans.map((p) => ({ id: p.id, plan: p.plan, ...(p.endpoints ? { endpoints: p.endpoints } : {}), active: p.starts_at <= t && t < p.ends_at, starts_at: iso(p.starts_at), ends_at: iso(p.ends_at), usd: p.usd, test: p.is_test, budget_usd: p.budget_usd, spent_usd: p.spent_usd, paid_tx: p.paid_tx, payer: p.payer })) });
    }
    return json(200, { kind: "owner_monitor", enrollments: rows, due: `${base}/v1/owner/monitor/due` }, NO_STORE);
  }

  // ---------------- cron: renewal reminders + lapse notices (capped per run)

  async function cron(base: string) {
    const t = now();
    const plans = (await store.plansEndingAfter(t - 7 * DAY_MS)).filter((p) => MONITORING.has(p.plan));
    let sent = 0;
    for (const p of plans) {
      if (sent >= 5) break;
      const later = plans.some((q) => q.enrollment_id === p.enrollment_id && q.plan === p.plan && q.ends_at > p.ends_at);
      if (later) continue;
      const remind = p.reminded < 1 && p.ends_at > t && p.ends_at - t <= MONITOR_LIMITS.reminderBeforeMs;
      const lapse = p.reminded < 2 && p.ends_at <= t && !plans.some((q) => q.enrollment_id === p.enrollment_id && MONITORING.has(q.plan) && q.starts_at <= t && t < q.ends_at);
      if (!remind && !lapse) continue;
      const e = await store.enrollment(p.enrollment_id);
      if (!e) continue;
      const qs = p.endpoints ? `&endpoints=${p.endpoints}` : "";
      const name = PLANS[p.plan as PlanId]?.name ?? (p.plan === "watch_free" ? "Free Watch" : WATCH_TRIAL.label);
      const renewUrl = p.plan === "watch_free" ? `POST ${base}/v1/monitor/free` : p.plan === "watch_plus_trial" || PLANS[p.plan as PlanId]?.retired ? `${base}${PLANS.watch.path}?enrollment=${e.id}${qs}` : `${base}${PLANS[p.plan as PlanId].path}?enrollment=${e.id}${qs}`;
      const f: FindingRow = p.plan === "watch_plus_trial"
        ? remind
          ? { enrollment_id: e.id, endpoint: null, ts: t, kind: "renewal_due", detail: `Your ${name} ends ${iso(p.ends_at)}. It never converts and nothing will be charged. To keep monitoring, pay a plan: ${renewUrl}. Otherwise history and the status page become read-only.`, run_id: null, delivered: null }
          : { enrollment_id: e.id, endpoint: null, ts: t, kind: "trial_ended", detail: `Your ${name} ended ${iso(p.ends_at)}: nothing was charged, checks and test-buys stopped, the Monitored badge was removed, and history and the status page are now read-only (frozen). Resume any time with a paid plan: ${renewUrl}.`, run_id: null, delivered: null }
        : remind
          ? { enrollment_id: e.id, endpoint: null, ts: t, kind: "renewal_due", detail: `${name} ends ${iso(p.ends_at)}. No auto-renew: renew ${p.plan === "watch_free" ? "free at" : "by paying again at"} ${renewUrl}${p.plan === "watch_free" ? "" : "."}`, run_id: null, delivered: null }
          : { enrollment_id: e.id, endpoint: null, ts: t, kind: "plan_lapsed", detail: `${name} ended ${iso(p.ends_at)}; monitoring stopped${p.plan === "watch_free" ? "" : " and the badge was removed"}. Renew: ${renewUrl}.`, run_id: null, delivered: null };
      f.id = await store.addFinding(f);
      await deliver(e, f, base);
      await store.setReminded(p.id, remind ? 1 : 2);
      sent++;
    }
    return { reminders_or_lapses: sent };
  }

  /** Disclosure for lookups: payTo (lowercase) -> commercial relationship. */
  async function relationships(payTos: string[], base: string): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const lc = [...new Set(payTos.map((p) => p.toLowerCase()))];
    if (!lc.length) return out;
    const es = await store.enrollmentsByPayTo(lc);
    for (const e of es.slice(0, 5)) {
      const plans = await store.plansFor(e.id);
      if (!plans.length) continue;
      const v = relationshipView(e, plans, base);
      const cur = out.get(e.pay_to_lc);
      if (!cur || (cur.status !== "active" && v.status === "active")) out.set(e.pay_to_lc, { pay_to: e.pay_to, ...v });
    }
    return out;
  }

  // ---------------- free tier, trial, probes, uptime, status page

  async function authEnrollment(request: Request): Promise<{ ok: true; e: Enrollment; b: any } | { ok: false; res: Response }> {
    if (!bearer(request)) return { ok: false, res: json(401, { error: "management_token_required", hint: "Authorization: Bearer <management token from enrolment>" }, { ...NO_STORE, "WWW-Authenticate": "Bearer" }) };
    const b = await readJson(request, 16_000);
    if (!b) return { ok: false, res: bad("invalid_json") };
    const e = ENROLL_ID_RE.test(String(b.enrollment_id ?? "")) ? await store.enrollment(String(b.enrollment_id)) : null;
    if (!e) return { ok: false, res: json(404, { error: "unknown_enrollment" }, NO_STORE) };
    if (!(await tokenOk(request, e))) return { ok: false, res: json(401, { error: "management_token_required" }, NO_STORE) };
    return { ok: true, e, b };
  }

  /** Free Watch: $0, 1 endpoint, daily quote check, no test-buys, no badge. One active free tier per payTo; renew in the last 3 days. */
  async function freeTier(request: Request, base: string) {
    const a = await authEnrollment(request);
    if (!a.ok) return a.res;
    const { e } = a;
    const t = now();
    const plans = await store.plansFor(e.id);
    const cur = plans.filter((p) => p.plan === "watch_free" && p.ends_at > t);
    // One active free tier per payTo, also across enrolments of the same payTo.
    const others = (await store.enrollments(200)).filter((x) => x.pay_to_lc === e.pay_to_lc && x.id !== e.id);
    for (const o of others) {
      if ((await store.plansFor(o.id)).some((p) => p.plan === "watch_free" && p.ends_at > t)) return json(409, { error: "free_tier_active_for_pay_to", enrollment_id: o.id, note: "One free tier per payTo." }, NO_STORE);
    }
    const end = Math.max(0, ...cur.map((p) => p.ends_at));
    if (end && end - t > MONITOR_LIMITS.reminderBeforeMs) return json(409, { error: "free_tier_active", ends_at: iso(end), detail: "Renew in the last 3 days of the term." }, NO_STORE);
    const start = Math.max(t, end);
    const row: PlanRow = {
      id: `mpl_${randHex(10)}`, enrollment_id: e.id, plan: "watch_free", starts_at: start, ends_at: start + WATCH_FREE.termDays * DAY_MS, paid_tx: `free_${randHex(12)}`,
      paid_network: "none", paid_asset: "none", paid_amount: "0", payer: null, usd: 0, budget_usd: 0, spent_usd: 0, is_test: e.is_test, reminded: 0, created_at: t, endpoints: WATCH_FREE.endpoints, unit_usd: 0,
    };
    await store.addPlan(row);
    return json(201, {
      plan: "Free Watch", plan_id: row.id, enrollment_id: e.id, price_usd: "0", label: WATCH_FREE.label, starts_at: iso(row.starts_at), ends_at: iso(row.ends_at), auto_renew: false,
      endpoints: planEndpoints(e, "watch_free").map(epView), checks: "a daily quote check", test_buys: "none", badge: false,
      status_page: `${base}/v1/monitor/status/${e.id}`, upgrade: `${base}${PLANS.watch.path}?enrollment=${e.id}&endpoints=${defaultWatchEndpoints(e)}`,
      note: "Nothing is charged and no card is needed.",
    }, NO_STORE);
  }

  // Shared hosting suffixes: a trial domain must be the seller's own name under these (foo.workers.dev), never the suffix itself.
  const SHARED_SUFFIXES = ["workers.dev", "pages.dev", "vercel.app", "netlify.app", "herokuapp.com", "github.io", "onrender.com", "fly.dev", "railway.app", "deno.dev", "replit.app", "co.uk", "com.au", "co.jp", "com.br"];
  /** Heuristic registrable domain (no public-suffix list in the Worker): last 2 labels, or 3 under a known shared suffix. */
  function registrable(host: string) {
    const h = host.toLowerCase().replace(/\.$/, "");
    const sfx = SHARED_SUFFIXES.find((s) => h === s || h.endsWith(`.${s}`));
    const n = sfx ? sfx.split(".").length + 1 : 2;
    const parts = h.split(".");
    return parts.length < n ? null : parts.slice(-n).join(".");
  }
  const domainToken = async (domain: string, payToLc: string) => (await hmacHex(deps.cfg.invoiceSecret, `lumi-monitor-domain|${domain}|${payToLc}`)).slice(0, 32);

  async function trialChallenge(url: URL, base: string) {
    const a = (url.searchParams.get("pay_to") ?? "").trim();
    const domain = (url.searchParams.get("domain") ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!a) return bad("pay_to_required", "?pay_to=<payTo>&domain=<your API domain>");
    if (!domain || !registrable(domain)) return bad("invalid_domain", "?domain= must be your API's hostname, e.g. api.example.com.");
    const c = await makeChallenge(deps.cfg.invoiceSecret, "monitor-trial", a, now(), domain);
    if (!c) return bad("invalid_pay_to_or_domain", "pay_to must be an XRPL r-address or Base 0x address; domain a hostname.");
    const token = await domainToken(registrable(domain)!, c.address.toLowerCase());
    return json(200, {
      ...c, trial: { plan: "Watch trial", days: WATCH_TRIAL.days, endpoints: WATCH_TRIAL.endpoints, test_buy_cap_usd: WATCH_TRIAL.capUsd, card_required: false, auto_converts: false },
      prove_domain: {
        token, either: [`https://${domain}/.well-known/lumi-monitor.txt containing the line: lumi-monitor-verify=${token}`, `DNS TXT record _lumi-monitor.${registrable(domain)} = "lumi-monitor-verify=${token}"`],
      },
      sign: c.network === "xrpl:0" ? "ripple-keypairs sign(utf8 hex of message, privateKey) with the payTo's master or regular key; send public_key too" : "EIP-191 personal_sign(message) from the payTo",
      next: `POST ${base}/v1/monitor/trial {enrollment_id, message, signature, public_key?} with Authorization: Bearer <management token>`,
      note: "One trial per seller (per domain and per payTo). It never converts into a paid plan; nothing is charged.",
    }, NO_STORE);
  }

  async function domainProven(domain: string, token: string) {
    const want = `lumi-monitor-verify=${token}`;
    try {
      const r = await deps.fetch(`https://${domain}/.well-known/lumi-monitor.txt`, { redirect: "manual", signal: AbortSignal.timeout(8000) } as RequestInit);
      if (r.ok && (await r.text()).slice(0, 4000).split(/\r?\n/).some((l) => l.trim() === want)) return "well-known";
    } catch { /* fall through to DNS */ }
    try {
      const reg = registrable(domain)!;
      const r = await deps.fetch(`https://cloudflare-dns.com/dns-query?name=_lumi-monitor.${reg}&type=TXT`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) } as RequestInit);
      if (r.ok) {
        const j: any = await r.json();
        if ((j?.Answer ?? []).some((x: any) => String(x?.data ?? "").replace(/"/g, "").trim() === want)) return "dns";
      }
    } catch { /* not proven */ }
    return null;
  }

  async function trial(request: Request, base: string) {
    const a = await authEnrollment(request);
    if (!a.ok) return a.res;
    const { e, b } = a;
    const proof = await verifyProof(deps.cfg.invoiceSecret, "monitor-trial", b, now(), deps.fetch, deps.xrplRpc);
    if (!proof.ok) return json(proof.reason === "ledger_unavailable_retry" ? 503 : 403, { error: "trial_proof_failed", reason: proof.reason, challenge: `${base}/v1/monitor/trial/challenge?pay_to=${e.pay_to}&domain=<domain>` }, NO_STORE);
    if (proof.address.toLowerCase() !== e.pay_to_lc) return json(403, { error: "trial_proof_failed", reason: "signer_is_not_the_enrolled_pay_to" }, NO_STORE);
    const domain = proof.domain!, reg = registrable(domain);
    if (!reg) return bad("invalid_domain");
    const hosts = sellerEps(e).map((x) => { try { return new URL(x.url).hostname.toLowerCase(); } catch { return ""; } });
    if (!hosts.some((h) => h === domain || h.endsWith(`.${domain}`) || registrable(h) === reg)) return json(403, { error: "domain_not_enrolled", detail: `None of this enrolment's endpoints is on ${domain}.` }, NO_STORE);
    const t = now();
    const plans = await store.plansFor(e.id);
    if (await store.trialFor(reg, e.pay_to_lc)) return json(409, { error: "trial_already_used", detail: "One free trial per seller (per domain and per payTo). Pick a plan instead.", plans: `${base}/v1/monitor` }, NO_STORE);
    if (plans.some((p) => !UNPAID.has(p.plan) && p.plan !== "audit" && p.ends_at > t)) return json(409, { error: "paid_plan_active", detail: "The trial is for sellers without an active paid plan." }, NO_STORE);
    const how = await domainProven(domain, await domainToken(reg, e.pay_to_lc));
    if (!how) return json(403, { error: "domain_not_proven", detail: `Publish lumi-monitor-verify=<token> at https://${domain}/.well-known/lumi-monitor.txt or as DNS TXT _lumi-monitor.${reg}, then retry with a fresh challenge.` }, NO_STORE);
    const row: PlanRow = {
      id: `mpl_${randHex(10)}`, enrollment_id: e.id, plan: "watch_plus_trial", starts_at: t, ends_at: t + WATCH_TRIAL.days * DAY_MS, paid_tx: "", paid_network: "none", paid_asset: "none",
      paid_amount: "0", payer: null, usd: 0, budget_usd: WATCH_TRIAL.capUsd, spent_usd: 0, is_test: e.is_test, reminded: 0, created_at: t,
      endpoints: Math.min(WATCH_TRIAL.endpoints, sellerEps(e).length), unit_usd: 0,
    };
    row.paid_tx = `trial_${row.id}`;
    // UNIQUE (domain, payTo, nonce) in D1 makes "one per seller" hold under races too.
    const ins = await store.addTrial({ id: `mtr_${randHex(10)}`, enrollment_id: e.id, plan_id: row.id, domain_lc: reg, pay_to_lc: e.pay_to_lc, nonce: proof.nonce, created_at: t,
      proof: JSON.stringify({ challenge: b.message, signature: b.signature, public_key: b.public_key ?? null, signer: proof.signer, domain_proof: how }) });
    if (ins === "taken") return json(409, { error: "trial_already_used" }, NO_STORE);
    await store.addPlan(row);
    deps.log({ event: "monitor_trial_started", enrollment: e.id, domain: reg, test: e.is_test });
    return json(201, {
      trial: true, plan: WATCH_TRIAL.label, plan_id: row.id, enrollment_id: e.id, starts_at: iso(row.starts_at), ends_at: iso(row.ends_at), price_usd: "0",
      endpoints: planEndpoints(e, "watch_plus_trial", row.endpoints).map(epView), test_buy_cap_usd: WATCH_TRIAL.capUsd, funding: "lumi-funded (free trial)",
      card_required: false, auto_converts: false, after: "At the end, history and the status page freeze (read-only) unless you pay a plan. Nothing is charged.",
      status_page: `${base}/v1/monitor/status/${e.id}`, keep_it: `${base}${PLANS.watch.path}?enrollment=${e.id}&endpoints=${row.endpoints}`,
    }, NO_STORE);
  }

  /** Box-side probe targets: every active plan's endpoints with the tier's cadence. Read-only (zero writes). */
  async function probes(base: string) {
    const t = now();
    const plans = (await store.plansEndingAfter(t)).filter((p) => p.starts_at <= t && p.plan !== "audit" && !isPack(p.plan)).slice(0, 200);
    const targets = new Map<string, { enrollment_id: string; endpoint: string; method: string; body?: Record<string, unknown>; every_ms: number; plan: string; network: string; pay_to: string }>();
    for (const p of plans) {
      const e = await store.enrollment(p.enrollment_id);
      if (!e) continue;
      const every = watchTier(p.plan)?.probeEveryMs ?? LEGACY_PROBE_MS;
      for (const ep of planEndpoints(e, p.plan, p.endpoints)) {
        const k = `${e.id}|${ep.url}`;
        const cur = targets.get(k);
        if (!cur || every < cur.every_ms) targets.set(k, { enrollment_id: e.id, endpoint: ep.url, method: ep.method, ...(ep.body ? { body: ep.body } : {}), every_ms: every, plan: p.plan, network: e.network, pay_to: e.pay_to });
      }
    }
    return json(200, { kind: "monitor_probe_targets", generated_at: iso(t), targets: [...targets.values()], post_rollups: `${base}/v1/owner/monitor/uptime`,
      note: "Unpaid quote checks only (no payment). Roll up per endpoint per UTC day; POST at most once per hour." }, NO_STORE);
  }

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TRANSITIONS: Record<string, string> = {
    quote_down: "The endpoint stopped returning a valid x402 quote.", quote_recovered: "The endpoint returns a valid x402 quote again.",
    pay_to_changed: "The quoted payTo changed.", price_changed: "The quoted price changed.", latency_p95_high: "p95 quote latency is above the alert threshold.",
  };

  async function uptime(request: Request, base: string, ctx?: WaitUntil) {
    const b = await readJson(request, 200_000);
    const days: any[] = Array.isArray(b?.days) ? b!.days.slice(0, 200) : [];
    const trs: any[] = Array.isArray(b?.transitions) ? b!.transitions.slice(0, 25) : [];
    if (!days.length && !trs.length) return bad("days_or_transitions_required");
    const cache = new Map<string, { e: Enrollment; plans: PlanRow[] } | null>();
    const load = async (id: string) => {
      if (!cache.has(id)) {
        const e = ENROLL_ID_RE.test(id) ? await store.enrollment(id) : null;
        cache.set(id, e ? { e, plans: (await store.plansFor(id)).filter((p) => p.plan !== "audit") } : null);
      }
      return cache.get(id)!;
    };
    const covered = (plans: PlanRow[], from: number, to: number) => plans.some((p) => p.starts_at < to && from < p.ends_at);
    const n = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
    const s = (v: unknown, k = 80) => (v == null || v === "" ? null : String(v).slice(0, k));
    const rows: UptimeRow[] = [], rejected: unknown[] = [];
    for (const d of days) {
      const c = await load(String(d?.enrollment_id ?? ""));
      const day = String(d?.day ?? "");
      if (!c || !DAY_RE.test(day) || !c.e.endpoints.some((x) => x.url === d.endpoint)) { rejected.push({ enrollment_id: d?.enrollment_id, endpoint: d?.endpoint, day, error: "unknown_enrollment_endpoint_or_day" }); continue; }
      const from = Date.parse(`${day}T00:00:00Z`);
      if (!covered(c.plans, from, from + DAY_MS)) { rejected.push({ enrollment_id: c.e.id, endpoint: d.endpoint, day, error: "outside_plan_period" }); continue; }
      const checks = n(d.checks) ?? 0, ok = Math.min(checks, n(d.ok) ?? 0);
      if (!checks || checks > 200) { rejected.push({ enrollment_id: c.e.id, endpoint: d.endpoint, day, error: "checks_out_of_range" }); continue; }
      rows.push({ enrollment_id: c.e.id, endpoint: d.endpoint, day, checks, ok, p50_ms: n(d.p50_ms), p95_ms: n(d.p95_ms), quote_amount: s(d.quote_amount, 40), quote_asset: s(d.quote_asset, 60), quote_pay_to: s(d.quote_pay_to) });
    }
    const written = rows.length ? await store.putUptime(rows) : 0;
    const t = now();
    const alerts: Promise<unknown>[] = [];
    const findings: unknown[] = [];
    for (const x of trs) {
      const c = await load(String(x?.enrollment_id ?? ""));
      const kind = String(x?.kind ?? "");
      if (!c || !(kind in TRANSITIONS) || !c.e.endpoints.some((y) => y.url === x.endpoint)) { rejected.push({ enrollment_id: x?.enrollment_id, kind, error: "unknown_enrollment_endpoint_or_kind" }); continue; }
      const ts = n(x.ts) ?? t;
      const active = c.plans.filter((p) => p.starts_at <= ts && ts < p.ends_at);
      if (!active.length) { rejected.push({ enrollment_id: c.e.id, kind, error: "outside_plan_period" }); continue; }
      if (kind === "latency_p95_high" && !active.some((p) => watchTier(p.plan)?.latencyAlerts)) { rejected.push({ enrollment_id: c.e.id, kind, error: "tier_has_no_latency_alerts" }); continue; }
      const f: FindingRow = { enrollment_id: c.e.id, endpoint: x.endpoint, ts, kind, detail: `${TRANSITIONS[kind]}${x.detail ? ` ${String(x.detail).slice(0, 300)}` : ""}`, run_id: null, delivered: null };
      f.id = await store.addFinding(f);
      findings.push({ id: f.id, kind });
      alerts.push(deliver(c.e, f, base));
    }
    const all = Promise.allSettled(alerts);
    if (ctx) ctx.waitUntil(all); else await all;
    return json(200, { written, findings, rejected }, NO_STORE);
  }

  /** Public status page per enrolment: HTML or .json. Read-only, edge-cacheable for 5 minutes. */
  async function statusPage(id: string, fmt: string, base: string) {
    const x = await sellerBundle(id);
    if (!x) return json(404, { error: "not_found", detail: "Unknown enrollment, or no plan (free, trial or paid) yet." }, { "Cache-Control": "public, max-age=60" });
    const { e, plans } = x;
    const t = now();
    const st = tierState(plans, t);
    const ref = st.frozen ? st.freezeAt! : t;
    const lastPlan = [...plans].filter((p) => p.plan !== "audit").sort((a, b) => b.ends_at - a.ends_at)[0];
    const tier = watchTier((st.top ?? lastPlan)?.plan ?? "") ?? null;
    const histDays = tier?.historyDays ?? 30;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const rows = await store.uptimeFor(e.id, day(ref - (histDays - 1) * DAY_MS), day(ref));
    const runs = x.runs.filter((r) => r.ts <= ref && r.ts > ref - histDays * DAY_MS && r.outcome !== "skipped");
    const eps = (st.top ? planEndpoints(e, st.top.plan, st.top.endpoints) : lastPlan ? planEndpoints(e, lastPlan.plan, lastPlan.endpoints) : []).map((ep) => {
      const mine = rows.filter((r) => r.endpoint === ep.url);
      const checks = mine.reduce((a, r) => a + r.checks, 0), ok = mine.reduce((a, r) => a + r.ok, 0);
      const recent = mine.filter((r) => r.day >= day(ref - 1 * DAY_MS));
      const rc = recent.reduce((a, r) => a + r.checks, 0), rok = recent.reduce((a, r) => a + r.ok, 0);
      const lastRun = runs.find((r) => r.endpoint === ep.url);
      const status = !rc && !lastRun ? "No recent data" : (rc && rok === 0) || (lastRun && failed(lastRun) && (!rc || rok < rc)) ? "Not delivering" : rc && rok < rc ? "Degraded" : "Operational";
      return { url: ep.url, status, quote_uptime: checks ? Math.round((ok / checks) * 10000) / 100 : null, checks, p95_ms: mine[0]?.p95_ms ?? null,
        last_test_buy: lastRun ? { at: iso(lastRun.ts), outcome: lastRun.outcome, ...(lastRun.network ? { network: lastRun.network } : {}) } : null,
        days: mine.slice(0, histDays).map((r) => ({ day: r.day, checks: r.checks, ok: r.ok, p95_ms: r.p95_ms })) };
    });
    const order = ["Not delivering", "Degraded", "No recent data", "Operational"];
    const overall = eps.length ? order.find((o) => eps.some((x) => x.status === o))! : "No recent data";
    const freeOnly = st.top?.plan === "watch_free";
    // An ended trial is not monitored: never show a stale "Operational".
    const frozenStatus = st.frozen ? `Trial ended ${iso(st.freezeAt!)!.slice(0, 10)}, not monitored` : "";
    const body = {
      kind: "lumi_monitor_status", enrollment_id: e.id, pay_to: e.pay_to, network: e.network, domain: e.domain, ...(e.is_test ? { test: true } : {}),
      status: st.frozen ? frozenStatus : overall, tier: st.top?.plan ?? null, tier_label: freeOnly ? WATCH_FREE.label : tierLabel(st.top?.plan), history_days: histDays,
      ...(st.frozen ? { frozen: true, frozen_at: iso(st.freezeAt!), frozen_note: `${WATCH_TRIAL_END} Data stops at the trial end.`, last_status_before_end: overall } : {}),
      ...(!st.top && !st.frozen ? { note: "No active plan: showing the last period." } : {}),
      endpoints: eps, seller_page: `${base}/v1/monitor/sellers/${e.id}`, disclosure: relationshipView(e, plans, base).disclosure,
      independence: "Monitoring and payment never change Lumi's scores, tiers, rankings or Tested-by-Lumi results.", as_of: iso(ref),
    };
    const hdr = { "Cache-Control": "public, max-age=300" };
    if (fmt === "json") return json(200, body, hdr);
    const row = (x: (typeof eps)[number]) => `<tr><td>${esc(x.url)}</td><td>${esc(st.frozen ? `${x.status} at trial end` : x.status)}</td><td>${x.quote_uptime ?? "–"}${x.quote_uptime == null ? "" : "%"}</td><td>${x.p95_ms ?? "–"}</td><td>${x.last_test_buy ? esc(`${x.last_test_buy.outcome} ${x.last_test_buy.at}`) : "–"}</td></tr>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status: ${esc(e.domain ?? e.pay_to)} — Lumi</title>` +
      `<style>body{font:15px system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;font-size:13px}.s{font-size:1.4rem;font-weight:600}.m{color:#555}</style></head><body>` +
      `<h1>${esc(e.domain ?? e.pay_to)}</h1><p class="s">${esc(st.frozen ? frozenStatus : overall)}</p><p class="m">${esc(String(body.tier_label))}${st.frozen ? ` · read-only since ${esc(String(iso(st.freezeAt!)))} (trial ended, no charge)` : ""} · last ${histDays} days</p>` +
      `<table><thead><tr><th>Endpoint</th><th>Status</th><th>Quote uptime</th><th>p95 ms</th><th>Last test-buy</th></tr></thead><tbody>${eps.map(row).join("")}</tbody></table>` +
      `<p class="m">${esc(body.disclosure)} ${esc(body.independence)}</p><p class="m"><a href="${esc(body.seller_page)}">Seller page</a> · <a href="${esc(`${base}/v1/monitor/status/${e.id}.json`)}">JSON</a></p></body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...hdr } });
  }

  // ---------------- test-buy packs (Re-test pack, Founder pack): x402 purchase, credit balance, manual fulfilment queue

  const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
  /** Company keys: the payTo wallet and the registrable domain of the enrolled domain and of every endpoint host. */
  /** Founder places, read from the claim tables written atomically at settlement (migration 0030): places taken, whether
   *  e's company (any shared payTo / domain key) holds one, and how many Founder packs that place has bought. */
  async function founderPlaces(_plan: PlanId, e: Enrollment | null) {
    const st = await store.founderState(e ? [...founderCompanyKeys(e)] : []);
    return { taken: st.taken, holdsPlace: !!st.place, used: st.used };
  }
  /** The endpoint a pack job buys: the one asked for (must be an enrolled seller endpoint within the cap) or the first eligible. */
  function pickPackEndpoint(e: Enrollment, want: string | null): { ok: true; ep: MonitorEndpoint } | { ok: false; res: Response } {
    const eps = packEndpoints(e);
    if (want) {
      const ep = sellerEps(e).find((x) => x.url === want);
      if (!ep) return { ok: false, res: json(409, { error: "endpoint_not_enrolled", endpoint: want.slice(0, 300), detail: "Name one of the seller endpoints of this enrolment (enrol it first).", note: "Not charged." }, NO_STORE) };
      if (!eps.includes(ep)) return { ok: false, res: json(409, { error: "endpoint_above_cap", endpoint: ep.url, listed_price_usd: ep.price_usd, detail: `Pack test-buys are capped at $${PACK_LIMITS.maxBuyUsd.toFixed(2)} per buy; this endpoint's enrolled price is above it (or unpriced).`, note: "Not charged." }, NO_STORE) };
      return { ok: true, ep };
    }
    if (!eps.length) return { ok: false, res: json(409, { error: "no_endpoint_within_cap", detail: `No enrolled seller endpoint is priced at or below $${PACK_LIMITS.maxBuyUsd.toFixed(2)}, so a pack could not be used.`, note: "Not charged." }, NO_STORE) };
    return { ok: true, ep: eps[0] };
  }
  async function packBalance(e: Enrollment, t: number) {
    const rows = (await store.plansFor(e.id)).filter((p) => isPack(p.plan));
    const jobs = await store.packJobsFor(e.id);
    const packs = rows.map((p) => {
      const total = p.credits ?? PLANS[p.plan as PlanId].pack!.buys;
      const used = jobs.filter((j) => j.plan_id === p.id && j.status !== "cancelled").length;
      const expired = t >= p.ends_at;
      return { pack_id: p.id, pack: p.plan, name: PLANS[p.plan as PlanId].name, bought_at: iso(p.created_at), expires_at: iso(p.ends_at), test_buys: total, used, left: expired ? 0 : Math.max(0, total - used), ...(expired ? { expired: true } : {}), ...(p.is_test ? { test: true } : {}), _row: p };
    });
    return { packs, left: packs.reduce((n, p) => n + p.left, 0), jobs };
  }
  const packView = (p: { _row: PlanRow } & Record<string, unknown>) => { const { _row, ...v } = p; return v; };
  const jobView = (j: PackJobRow) => ({ job_id: j.id, pack_id: j.plan_id, endpoint: j.endpoint, day: j.day, status: j.status, ...(j.run_id ? { run_id: j.run_id } : {}), ...(j.note ? { note: j.note } : {}), queued_at: iso(j.created_at) });
  /** Queue one test-buy from the pack that expires first and still has buys left. */
  async function queuePackJob(e: Enrollment, ep: MonitorEndpoint, t: number, only?: string): Promise<{ ok: true; job: PackJobRow } | { ok: false; error: string; detail: string }> {
    const bal = await packBalance(e, t);
    const pick = bal.packs.filter((p) => p.left > 0 && (!only || p.pack_id === only)).sort((a, b) => a._row.ends_at - b._row.ends_at)[0];
    if (!pick) return { ok: false, error: "no_pack_balance", detail: `No unexpired pack with test-buys left. Buy one: GET /v1/monitor/subscribe/retest_pack?enrollment=${e.id}` };
    const job: PackJobRow = { id: `mpj_${randHex(10)}`, plan_id: pick.pack_id, enrollment_id: e.id, endpoint: ep.url, day: utcDay(t), status: "queued", run_id: null, note: null, created_at: t, updated_at: t };
    if ((await store.addPackJob(job)) === "duplicate") return { ok: false, error: "already_queued_today", detail: `This endpoint already has a test-buy queued or run today (${job.day} UTC). One counted test-buy per endpoint per day; try again tomorrow or pick another endpoint.` };
    return { ok: true, job };
  }

  function packsDoc(base: string) {
    return {
      packs: PACK_PLANS.map((id) => {
        const p = PLANS[id], k = p.pack!;
        return { plan: id, name: p.name, price_usd: p.usd, checkout_usd: Number(p.usd).toFixed(2) /* always two decimals: "5.00", "6.50" */, test_buys: k.buys, expiry_days: k.expiryDays, max_usd_per_test_buy: PACK_LIMITS.maxBuyUsd,
          ...(id === "retest_pack" ? { pitch: "Fixed something? Get re-tested now." } : {}),
          ...(k.founder ? { founder: { seats: k.founder.seats, one_place_per_company: "enrolments sharing a payTo wallet or a registrable domain", max_purchases_per_company: k.founder.maxPurchases } } : {}),
          buy: `${base}${p.path}?enrollment=<enrollment_id>[&endpoint=<enrolled endpoint URL>]`, summary: p.summary };
      }),
      use: `POST ${base}/v1/monitor/packs/use {enrollment_id, endpoint?} with Authorization: Bearer <management token>: queues one test-buy (one per endpoint per UTC day).`,
      balance: `GET ${base}/v1/monitor/packs?enrollment=<id> with Authorization: Bearer <management token>.`,
      single_test_buy: { status: "coming_soon", detail: "A single paid test-buy without a pack is not sold yet; no price is published until its checkout is live." },
      terms: PACK_TERMS,
    };
  }

  async function packsGet(request: Request, url: URL, base: string) {
    const t = now();
    const f = await founderPlaces("founder_pack", null);
    const pub = { kind: "lumi_testbuy_packs", ...packsDoc(base), founder_places_left: Math.max(0, PLANS.founder_pack.pack!.founder!.seats - f.taken), docs: `${base}/v1/monitor` };
    const id = url.searchParams.get("enrollment");
    if (!id) return json(200, pub, { "Cache-Control": "public, max-age=60" });
    if (!bearer(request)) return json(401, { error: "management_token_required", hint: "Authorization: Bearer <management token from enrolment>" }, { ...NO_STORE, "WWW-Authenticate": "Bearer" });
    const e = ENROLL_ID_RE.test(id) ? await store.enrollment(id) : null;
    if (!e) return json(404, { error: "unknown_enrollment" }, NO_STORE);
    if (!(await tokenOk(request, e))) return json(401, { error: "management_token_required" }, NO_STORE);
    const bal = await packBalance(e, t);
    return json(200, { ...pub, enrollment_id: e.id, balance: { left: bal.left, packs: bal.packs.map(packView), jobs: bal.jobs.slice(0, 50).map(jobView) }, endpoints_within_cap: packEndpoints(e).map(epView) }, NO_STORE);
  }

  async function packUse(request: Request, base: string) {
    const a = await authEnrollment(request);
    if (!a.ok) return a.res;
    const { e, b } = a;
    const sx = await sanctioned("monitor_pack_use", e.pay_to, { enrollment_id: e.id });
    if (sx) return sanctionedRes(sx);
    const pe = pickPackEndpoint(e, b.endpoint ? String(b.endpoint).slice(0, 500) : null);
    if (!pe.ok) return pe.res;
    const t = now();
    const q = await queuePackJob(e, pe.ep, t);
    if (!q.ok) return json(409, { error: q.error, detail: q.detail }, NO_STORE);
    const bal = await packBalance(e, t);
    return json(201, { queued: true, job: jobView(q.job), balance_left: bal.left, seller_page: `${base}/v1/monitor/sellers/${e.id}`, note: "Run by hand from Lumi's operator box during the pre-sale (no guaranteed turnaround). The result is published on your seller page, failures included." }, NO_STORE);
  }

  async function buyPack(request: Request, url: URL, plan: PlanId, e: Enrollment, base: string, ctx?: WaitUntil) {
    const def = PLANS[plan], k = def.pack!;
    // Preflight, all before any 402 (never charged): an endpoint within the cap, and (Founder pack) a place and purchases left.
    const pe = pickPackEndpoint(e, url.searchParams.get("endpoint"));
    if (!pe.ok) return pe.res;
    if (k.founder && !e.is_test) {
      const f = await founderPlaces(plan, e);
      if (!f.holdsPlace && f.taken >= k.founder.seats) return json(409, { error: "founder_offer_full", plan, detail: `The Founder pack is limited to the first ${k.founder.seats} sellers and all places are taken. Re-test pack: ${base}${PLANS.retest_pack.path}?enrollment=${e.id}`, note: "Not charged." }, NO_STORE);
      if (f.used >= k.founder.maxPurchases) return json(409, { error: "founder_purchases_used", plan, detail: `The Founder pack can be bought ${k.founder.maxPurchases} times per company (one place per payTo wallet and per domain); this company has bought it ${f.used} times. Re-test pack: ${base}${PLANS.retest_pack.path}?enrollment=${e.id}`, purchases_left: 0, note: "Not charged." }, NO_STORE);
    }
    const usd = def.usd; // exact price for everyone (no test-price override, no discounts)
    const quote = planQuote(deps.cfg, plan, e.id, usd, `${base}${def.path}?enrollment=${e.id}`, false);
    return requirePayment(request, deps.cfg, deps.paywall(ctx), quote, async (s: Settlement, req: PaymentRequirements) => {
      const t = now();
      const tx = s.transaction || `unknown_${randHex(8)}`;
      const row: PlanRow = {
        id: `mpl_${randHex(10)}`, enrollment_id: e.id, plan, starts_at: t, ends_at: t + k.expiryDays * DAY_MS, paid_tx: tx, paid_network: s.network, paid_asset: assetLabel(req),
        paid_amount: String(req.amount), payer: s.payer ?? null, usd: Number(usd), budget_usd: Math.round(k.buys * PACK_LIMITS.maxBuyUsd * 1e6) / 1e6, spent_usd: 0,
        is_test: e.is_test, reminded: 0, created_at: t, credits: k.buys,
      };
      // Founder pack: the place and the purchase number are claimed atomically HERE, at settlement (the pre-payment check
      // above can be overtaken by a racing buyer). A payment that loses the race is recorded for manual review, no credit.
      if (k.founder && !e.is_test) {
        const c = await store.claimFounder({ keys: [...founderCompanyKeys(e)], enrollment_id: e.id, plan_id: row.id, paid_tx: tx, t, seats: k.founder.seats, maxPurchases: k.founder.maxPurchases });
        if (!c.ok && c.reason !== "duplicate_payment") {
          await store.addPackRefusal({ paid_tx: tx, enrollment_id: e.id, plan, reason: c.reason, paid_network: s.network, paid_asset: assetLabel(req), paid_amount: String(req.amount), payer: s.payer ?? null, usd: Number(usd), is_test: e.is_test, created_at: t })
            .catch((err) => deps.log({ event: "monitor_pack_refusal_error", error: String(err) }));
          deps.log({ event: "monitor_pack_refused_at_settlement", plan, enrollment: e.id, reason: c.reason, tx });
          deps.saleOutcome?.(tx, { kind: "refused", reason: c.reason });
          return json(409, {
            error: c.reason === "founder_offer_full" ? "founder_offer_full_at_settlement" : "founder_purchases_used_at_settlement",
            plan, paid: true, credited: false, tx, network: s.network, enrollment_id: e.id,
            detail: c.reason === "founder_offer_full"
              ? `Your payment settled, but the last of the ${k.founder.seats} Founder places was taken by another seller while it was settling. No pack was added and no test-buys were queued.`
              : `Your payment settled, but your company had already used its ${k.founder.maxPurchases} Founder pack purchases (another purchase settled first). No pack was added and no test-buys were queued.`,
            what_happens_next: FOUNDER_RACE_TEXT,
            contact: CONTACT_EMAIL,
          }, NO_STORE);
        }
      }
      const ins = await store.addPlan(row).catch((err) => { deps.log({ event: "monitor_pack_error", error: String(err) }); return "error" as const; });
      deps.saleOutcome?.(tx, ins === "error" ? { kind: "unknown" } : { kind: "credited" });
      let job: PackJobRow | null = null, jobNote: string | null = null;
      if (ins === "inserted") {
        const q = await queuePackJob(e, pe.ep, t, row.id).catch((err) => ({ ok: false as const, error: "queue_error", detail: String(err).slice(0, 200) }));
        if (q.ok) job = q.job; else jobNote = q.detail;
      }
      deps.log({ event: "monitor_pack_paid", plan, enrollment: e.id, test: e.is_test, inserted: ins, job: job?.id ?? null });
      const bal = await packBalance(e, t);
      return json(201, {
        paid: true, plan: def.name, pack_id: row.id, enrollment_id: e.id, price_usd: usd2(usd), ...(e.is_test ? { test: true } : {}),
        test_buys: k.buys, expires_at: iso(row.ends_at), auto_renew: false, max_usd_per_test_buy: PACK_LIMITS.maxBuyUsd,
        ...(ins === "duplicate" ? { note_duplicate: "This payment was already recorded; no second pack was added." } : {}),
        first_retest: job ? jobView(job) : { queued: false, ...(jobNote ? { reason: jobNote } : {}) },
        balance_left: bal.left,
        use: `POST ${base}/v1/monitor/packs/use {enrollment_id, endpoint?} with your management token`,
        balance: `GET ${base}/v1/monitor/packs?enrollment=${e.id} with your management token`,
        seller_page: `${base}/v1/monitor/sellers/${e.id}`,
        terms: PACK_TERMS,
        note: "Test-buys are run by hand from Lumi's operator box during the pre-sale (no guaranteed turnaround). Each result is dated, kept with a signed receipt and published on your seller page, failures included. Paying never changes a score.",
      }, NO_STORE);
    });
  }

  /** Box-runner tasks for queued pack jobs (sanctioned payTos and expired packs are skipped, never handed to the runner). */
  async function packJobTasks(t: number) {
    const out: Record<string, unknown>[] = [];
    for (const j of await store.queuedPackJobs(25)) {
      const e = await store.enrollment(j.enrollment_id);
      const plan = e ? (await store.plansFor(e.id)).find((p) => p.id === j.plan_id) : null;
      const ep = e?.endpoints.find((x) => x.url === j.endpoint);
      if (!e || !plan || !ep) continue;
      if (t >= plan.ends_at) continue;
      if (await sanctioned("monitor_pack_due", e.pay_to, { enrollment_id: e.id, plan_id: plan.id })) continue;
      const chain = buyChains(ep, e, PACK_LIMITS.maxBuyUsd)[0];
      if (!chain) continue;
      out.push({
        pack_job_id: j.id, plan_id: plan.id, plan: plan.plan, enrollment_id: e.id, network: chain.network, pay_to: chain.pay_to, ...(chain.proven ? {} : { pay_to_proven: false }),
        endpoint: { url: ep.url, method: ep.method, ...(ep.body ? { body: ep.body } : {}) }, mode: "buy",
        max_usd: Math.round(Math.min(PACK_LIMITS.maxBuyUsd, chain.usd! * 1.15) * 1e6) / 1e6, enrolled_price_usd: String(chain.usd), funding: "seller-funded (pack)", queued_at: iso(j.created_at), ...(plan.is_test ? { test: true } : {}),
      });
    }
    return out;
  }

  async function ownerPacks(base: string) {
    const t = now();
    const f = await founderPlaces("founder_pack", null);
    const queued = await store.queuedPackJobs(100);
    const refused = await store.packRefusals(50);
    return json(200, { kind: "owner_monitor_packs", refused_at_settlement: refused.map((r) => ({ ...r, created_at: iso(r.created_at), note: "Paid, no credit added; excluded from revenue totals on /v1/owner/sales. Manual review: any refund or credit needs the owner's approval; nothing is refunded automatically." })), founder_places_taken: f.taken, founder_seats: PLANS.founder_pack.pack!.founder!.seats, queued: queued.map((j) => ({ ...jobView(j), enrollment_id: j.enrollment_id })), tasks: await packJobTasks(t), due: `${base}/v1/owner/monitor/due`, cancel: `POST ${base}/v1/owner/monitor/packs/cancel {job_id, note}` }, NO_STORE);
  }

  async function packCancel(request: Request) {
    const b = await readJson(request);
    const j = b?.job_id ? await store.packJob(String(b.job_id).slice(0, 40)) : null;
    if (!j) return json(404, { error: "unknown_job" }, NO_STORE);
    if (j.status !== "queued") return json(409, { error: "job_not_queued", status: j.status }, NO_STORE);
    await store.setPackJob(j.id, { status: "cancelled", note: b?.note ? String(b.note).slice(0, 300) : "cancelled by Lumi", updated_at: now() });
    return json(200, { cancelled: true, job_id: j.id, note: "The test-buy went back to the pack." }, NO_STORE);
  }

  async function handle(request: Request, path: string, url: URL, base: string, ctx?: WaitUntil): Promise<Response | null> {
    const m = request.method;
    const get = m === "GET" || m === "HEAD";
    if (path === "/v1/monitor" && get) return json(200, doc(base), { "Cache-Control": "public, max-age=600" });
    if (path === "/v1/monitor/challenge" && get) {
      const a = (url.searchParams.get("pay_to") ?? url.searchParams.get("payTo") ?? "").trim();
      const sx = await sanctioned("monitor_challenge", a);
      if (sx) return sanctionedRes(sx);
      const c = await makeChallenge(deps.cfg.invoiceSecret, "monitor-enroll", a, now());
      if (!c) return a ? bad("invalid_pay_to", "pay_to is not a valid XRPL r-address or Base 0x address.", { example: "?pay_to=<XRPL r-address or Base 0x address>" }) : bad("pay_to_required", "?pay_to=<XRPL r-address or Base 0x address>");
      return json(200, { ...c, sign: c.network === "xrpl:0" ? "ripple-keypairs sign(utf8 hex of message, privateKey) with the payTo's master or regular key; send public_key too" : "EIP-191 personal_sign(message) from the payTo", next: `POST ${base}/v1/monitor/enroll` }, NO_STORE);
    }
    if (path === "/v1/monitor/enroll") return m === "POST" ? enroll(request, base) : json(405, { error: "method_not_allowed", detail: `POST JSON. Docs: ${base}/v1/monitor` }, { Allow: "POST, OPTIONS" });
    if (path === "/v1/monitor/replies") return m === "POST" ? reply(request) : json(405, { error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    if (path === "/v1/monitor/free") return m === "POST" ? freeTier(request, base) : json(405, { error: "method_not_allowed", detail: `POST {enrollment_id} with the management token. Docs: ${base}/v1/monitor` }, { Allow: "POST, OPTIONS" });
    if (path === "/v1/monitor/trial/challenge" && get) return trialChallenge(url, base);
    if (path === "/v1/monitor/trial") return m === "POST" ? trial(request, base) : json(405, { error: "method_not_allowed", detail: `GET ${base}/v1/monitor/trial/challenge first, then POST here.` }, { Allow: "POST, OPTIONS" });
    if (path === "/v1/monitor/packs" && get) return packsGet(request, url, base);
    if (path === "/v1/monitor/packs/use") return m === "POST" ? packUse(request, base) : json(405, { error: "method_not_allowed", detail: `POST {enrollment_id, endpoint?} with the management token. Docs: ${base}/v1/monitor/packs` }, { Allow: "POST, OPTIONS" });
    const stp = path.match(/^\/v1\/monitor\/status\/([^/.]+)(?:\.(json))?$/);
    if (stp && get) return statusPage(stp[1], stp[2] ?? "html", base);
    const sub = path.match(/^\/v1\/monitor\/subscribe\/([^/]+)$/);
    if (sub && get) {
      const p = sub[1];
      if ((MONITOR_PLANS as string[]).includes(p)) return subscribe(request, url, p as PlanId, base, ctx);
      if (/[{}<>:[\]$]/.test(decodeURIComponent(p))) return bad("path_template_not_filled", `Use one of: ${SOLD_MONITOR_PLANS.join(", ")}.`, { example: `${base}/v1/monitor/subscribe/watch?enrollment=<enrollment_id>&endpoints=1` });
      return json(404, { error: "unknown_plan", plans: SOLD_MONITOR_PLANS }, NO_STORE);
    }
    if (path === "/v1/monitor/sellers" && get) return sellers(base);
    const sp = path.match(/^\/v1\/monitor\/sellers\/([^/]+)$/);
    if (sp && get) return sellerPage(sp[1], base);
    const rp = path.match(/^\/v1\/monitor\/sellers\/([^/]+)\/report$/);
    if (rp && get) return sellerReport(request, rp[1], url);
    const bp = path.match(/^\/v1\/monitor\/badge\/([^/.]+)\.(svg|json)$/);
    if (bp && get) return badge(bp[1], bp[2], base);
    if (path === "/v1/monitor/corrections" && get) return corrections();
    if (path.startsWith("/v1/owner/monitor") || path === "/v1/owner/corrections") {
      const deny = await ownerOnly(request);
      if (deny) return deny;
      if (path === "/v1/owner/monitor" && get) return owner(base);
      if (path === "/v1/owner/monitor/due" && get) return due(base);
      if (path === "/v1/owner/monitor/results" && m === "POST") return results(request, base, ctx);
      if (path === "/v1/owner/monitor/report-draft" && get) return reportDraft(url);
      if (path === "/v1/owner/monitor/report" && m === "POST") return putReport(request);
      if (path === "/v1/owner/monitor/probes" && get) return probes(base);
      if (path === "/v1/owner/monitor/uptime" && m === "POST") return uptime(request, base, ctx);
      if (path === "/v1/owner/monitor/packs" && get) return ownerPacks(base);
      if (path === "/v1/owner/monitor/packs/cancel" && m === "POST") return packCancel(request);
      if (path === "/v1/owner/corrections" && m === "POST") {
        const b = await readJson(request);
        const subject = String(b?.subject ?? "").slice(0, 200), summary = String(b?.summary ?? "").slice(0, 2000);
        if (!subject || !summary) return bad("subject_and_summary_required");
        const id = await store.addCorrection({ ts: now(), subject, summary, ref: b?.ref ? String(b.ref).slice(0, 300) : null });
        return json(201, { id }, NO_STORE);
      }
      return json(404, { error: "not_found" }, NO_STORE);
    }
    return null;
  }

  return { handle, cron, relationships, doc };
}
