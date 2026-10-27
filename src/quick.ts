/**
 * Stage C products: cheap, focused market data (funding, Fear & Greed, next-48h events) and the "should I pay this x402
 * URL?" verdict. Data and observations only; not financial advice. (The lite read and the all-coins scan were retired
 * on 2026-10-25.)
 */
import { envelope, type CoinRef } from "./views";
import { compact, eventRows, catalystRows } from "./products";
import { band } from "./feeds";
import { VENDORS, vendorById, vendorPayTos } from "./vendors";
import { sanctionedReason, type SanctionsScreen } from "./sanctions";
import { failureStreak, FAILED_RULE, EVIDENCE_AGE } from "./trust/verdict";

type Json = any;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// ---------------------------------------------------------------- funding
/** Neutral size band of an 8h-normalised funding rate (describes the number, not a market call). */
function fundingRead(rate8h: number) {
  if (rate8h >= 0.05) return "strongly positive";
  if (rate8h >= 0.015) return "positive";
  if (rate8h > -0.015) return "near zero";
  if (rate8h > -0.05) return "negative";
  return "strongly negative";
}

export function fundingView(doc: Json) {
  const coins: Json[] = Array.isArray(doc?.coins) ? doc.coins : [];
  if (!coins.length) return null;
  const rows = coins.map((c) => ({ ...c, read: fundingRead(c.rate_8h_pct) })).sort((a, b) => b.rate_8h_pct - a.rate_8h_pct);
  const btc = rows.find((c) => c.symbol === "BTC");
  const sorted8 = rows.map((c) => c.rate_8h_pct).sort((a, b) => a - b);
  const median = sorted8[Math.floor(sorted8.length / 2)];
  return envelope("funding", {
    venue: doc.venue,
    count: rows.length,
    btc: btc ?? null,
    median_rate_8h_pct: median,
    summary: `${btc ? `BTC funding ${btc.rate_8h_pct}% per 8h (${btc.read}). ` : ""}Median across ${rows.length} coins ${median}% per 8h (${fundingRead(median)}).`,
    most_positive: rows.slice(0, 5).map((c) => ({ symbol: c.symbol, rate_8h_pct: c.rate_8h_pct })),
    most_negative: rows.slice(-5).reverse().map((c) => ({ symbol: c.symbol, rate_8h_pct: c.rate_8h_pct })),
    coins: rows,
    note: "rate_pct is the current period's rate; rate_8h_pct normalises it to 8 hours; annualized_pct = rate x periods per year. A positive rate means the perpetual traded above its index over the period; negative means below. Data only, not a prediction.",
  });
}

// ---------------------------------------------------------------- fear & greed
export function fearGreedView(doc: Json) {
  const v = num(doc?.now?.value);
  if (v == null) return null;
  const y = num(doc?.yesterday?.value), w = num(doc?.last_week?.value), m = num(doc?.last_month?.value);
  return envelope("fear_greed", compact({
    source: "CoinMarketCap",
    value: v,
    classification: band(v),
    at: doc.now.at,
    yesterday: doc.yesterday, last_week: doc.last_week, last_month: doc.last_month,
    year_high: doc.year_high, year_low: doc.year_low,
    change: { vs_yesterday: y == null ? null : v - y, vs_last_week: w == null ? null : v - w, vs_last_month: m == null ? null : v - m },
    series_30d: doc.series_30d,
    bands: "0-20 Extreme fear, 20-40 Fear, 40-60 Neutral, 60-80 Greed, 80-100 Extreme greed",
  }));
}

/** Fallback when the live feed is unavailable: the site's CoinMarketCap snapshot (context.json). */
export function fearGreedFromContext(context: Json) {
  const fg = context?.fear_greed;
  if (fg?.source !== "CoinMarketCap" || num(fg?.value) == null || fg.stale) return null;
  return fearGreedView({ now: { value: fg.value, at: fg.timestamp }, yesterday: fg.previous != null ? { value: fg.previous, classification: band(fg.previous) } : null });
}

// ---------------------------------------------------------------- next 48h events
export function events48View(events: Json, analysis: Json, coins: CoinRef[], now: number) {
  const end = now + 48 * 3_600_000;
  const timed = eventRows(events, now).filter((e) => Date.parse(e.at_utc) >= now && Date.parse(e.at_utc) <= end);
  const lastDay = new Date(end).toISOString().slice(0, 10);
  const byDate = analysis ? catalystRows(analysis, coins, now).filter((c) => c.date <= lastDay) : [];
  if (!timed.length && !byDate.length && !events) return null;
  return envelope("events_48h", compact({
    window: { from: new Date(now).toISOString(), to: new Date(end).toISOString() },
    count: timed.length + byDate.length,
    next: timed[0] ?? null,
    timed,
    by_date: byDate,
    note: timed.length + byDate.length
      ? "Scheduled releases and decisions in the next 48 hours (UTC + US Central), each with its source. Dates can move; check the source."
      : "Nothing sourced and scheduled in the next 48 hours.",
  }));
}

// ---------------------------------------------------------------- should I pay this x402 URL?
export interface CheckInput { url: string; payTo?: string; amountUsd?: number; network?: string }
interface Reason { code: string; severity: "block" | "warn" | "info"; detail: string }

/**
 * Verdict from Lumi's observations (CDP Bazaar listing + free quote checks + paid test-buys):
 * block = a concrete red flag (payTo or price differs from the listing, Lumi paid and got nothing);
 * warn = not enough evidence (unlisted, unchecked, failing quotes, young domain, slow);
 * allow = listed and its quotes check out (test-bought = Lumi paid and got data).
 */
/** A purchase whose delivery is known (inconclusive = Lumi never recorded a response: never a reason to warn or block). */
const conclusive = (p: Json) => p?.delivery !== "inconclusive" && p?.data_returned !== null && !(p?.data_returned === false && (p?.http_status == null || p?.http_status === 0));
const inconclusiveText = (p: Json, what: string) =>
  p.inconclusive_reason === "empty_result"
    ? `Lumi's latest ${what} (${p.at}, tx ${p.tx_hash}) paid ${p.amount} ${p.asset}; the seller answered with an empty result for Lumi's test query (empty_result): delivery unknown. An empty result can be a correct answer, so it is not counted against the seller.`
    : p.inconclusive_reason === "our_query_error"
    ? `Lumi's latest ${what} (${p.at}, tx ${p.tx_hash}) paid ${p.amount} ${p.asset}; the seller's error was caused by Lumi's own test input (our_query_error): delivery unknown. It is not counted against the seller.`
    : `Lumi's latest ${what} (${p.at}, tx ${p.tx_hash}) paid ${p.amount} ${p.asset}, but Lumi recorded no HTTP response (${p.inconclusive_reason ?? "no_http_response"}): delivery unknown. This was a Lumi-side failure and is not counted against the seller.`;

/** Evidence older than this supports at most check_first, and older than NO_DATA_AFTER_DAYS at most no_data. */
export const EVIDENCE_CAUTION_AFTER_DAYS = EVIDENCE_AGE.checkFirstAfterDays;
export const EVIDENCE_NO_DATA_AFTER_DAYS = EVIDENCE_AGE.noDataAfterDays;
/** Reason codes that mean "Lumi has no evidence about this seller": alone they give decision "unknown" (label no_data), not warn. */
export const NO_DATA_CODES = ["not_observed", "not_quote_checked"];

export function trustVerdict(input: CheckInput, exact: Json | null, domainDoc: Json | null, base: string, sanctions?: Pick<SanctionsScreen, "check" | "checkAny">, now = Date.now()) {
  const reasons: Reason[] = [];
  const add = (code: string, severity: Reason["severity"], detail: string) => reasons.push({ code, severity, detail });
  let confirmRebuy = false;
  const exactEntries: Json[] = exact?.catalog?.entries ?? [];
  const domEntries: Json[] = domainDoc?.catalog?.entries ?? [];
  const self = exact?.self ?? domainDoc?.self;
  const e = exactEntries[0] ?? null;
  const curated: Json[] = [...(exact?.curated ?? []), ...(domainDoc?.curated ?? [])];

  if (self) {
    add("lumi_itself", "info", "This is Lumi's own API; Lumi does not score itself.");
  } else if (!e && !domEntries.length && !curated.length) {
    add("not_observed", "info", "Not in the CDP x402 Bazaar catalog Lumi ingests (refreshed daily) or Lumi's curated list. Lumi has no evidence either way; this is not a negative finding.");
  } else if (!e && !domEntries.length) {
    add("curated_vendor", "info", `In Lumi's curated XRPL vendor list (${curated[0].name}), which Lumi probes every 30 minutes and test-buys; see ${curated[0].detail}.`);
    const xps: Json[] = curated[0].purchases ?? [];
    const xb = xps.find(conclusive);
    const n = curated[0].xrpl_test_buys;
    if (xps[0] && !conclusive(xps[0])) add("xrpl_purchase_inconclusive", "info", inconclusiveText(xps[0], "XRPL test-buy"));
    if (xb) {
      if (xb.data_returned === false) add("xrpl_paid_no_data", "warn", `Lumi's latest XRPL test-buy (${xb.at}, tx ${xb.tx_hash}) paid ${xb.amount} ${xb.asset} and got no usable data (HTTP ${xb.http_status}); ${n?.delivered ?? 0} of ${n?.count ?? 0} XRPL test-buys in 30 days returned data.`);
      else add("xrpl_purchase_verified", "info", `Lumi paid ${xb.amount} ${xb.asset} on XRPL on ${xb.at} and got data back (tx ${xb.tx_hash}); ${n?.delivered ?? 0} of ${n?.count ?? 0} XRPL test-buys in 30 days returned data.`);
    } else add("no_recent_xrpl_buy", "warn", "No Lumi XRPL test-buy of this vendor in the last 30 days.");
  } else if (!e) {
    add("resource_not_listed", "warn", `This exact URL is not listed, but ${domEntries.length} listing(s) on the same domain are. Compare against those.`);
  }

  const ref = e ?? domEntries[0];
  const entries: Json[] = e ? [e] : domEntries;
  const listedPayTo: string[] = [...new Set<string>(entries.flatMap((x) => (x.pay_to ?? []).map((p: Json) => String(p.pay_to).toLowerCase())))];
  // The Bazaar only lists EVM/Solana payTos, so an XRPL payTo Lumi itself paid was a false block.
  // Also known: the payTos of Lumi's curated record for this seller (by id, or the same operator via a shared listed payTo)
  // and seller.pay_to of Lumi's own signed test-buy receipts for these entries.
  const knownRaw: string[] = [
    ...listedPayTo,
    ...curated.flatMap((c) => { const v = c?.id ? vendorById(String(c.id)) : undefined; return v ? vendorPayTos(v) : []; }),
    ...(listedPayTo.length ? VENDORS.filter((v) => vendorPayTos(v).some((p) => listedPayTo.includes(p.toLowerCase()))).flatMap(vendorPayTos) : []),
    ...entries.flatMap((x) => (x.purchases ?? []).map((p: Json) => p?.receipt?.seller?.pay_to).filter((p: unknown): p is string => typeof p === "string")),
  ];
  const knownPayTo = new Set<string>(knownRaw.map((p) => p.toLowerCase()));
  // OFAC SDN screen first: the quoted payTo, or any payTo Lumi has on record for this resource, on the list => block.
  const sanctionedHit = sanctions ? sanctions.check(input.payTo) ?? sanctions.checkAny([...entries.flatMap((x) => (x.pay_to ?? []).map((p: Json) => String(p.pay_to))), ...knownRaw]) : null;
  if (sanctionedHit) reasons.unshift(sanctionedReason(sanctionedHit));
  if (input.payTo) {
    const q = input.payTo.toLowerCase();
    if (knownPayTo.has(q)) add("pay_to_matches", "info", listedPayTo.includes(q) ? "The payTo you were quoted matches the listing." : "The payTo you were quoted is a known address of this seller (Lumi's curated vendor record or Lumi's own paid test-buy), not a Bazaar-listed one.");
    else if (listedPayTo.length) add("pay_to_mismatch", "block", `The payTo you were quoted (${input.payTo}) is not an address this ${e ? "resource" : "domain"} lists in the Bazaar (${listedPayTo.slice(0, 3).join(", ")}) or that Lumi has on record for this seller.`);
    else if (knownPayTo.size) add("pay_to_unrecognised", "warn", `The payTo you were quoted (${input.payTo}) is not one Lumi has on record for this seller (${[...knownPayTo].slice(0, 3).join(", ")}). It may be new; check it with the seller.`);
  }
  if (e) {
    const listed = Number(e.listed_price_usd);
    if (input.amountUsd != null && Number.isFinite(listed) && listed > 0 && input.amountUsd > listed * 1.5 && input.amountUsd - listed > 0.001) {
      add("price_above_listing", "block", `You were quoted $${input.amountUsd}, more than the listed $${e.listed_price_usd}.`);
    }
    const q = e.quote_checks;
    if (!q) add("not_quote_checked", "info", "Listed, but Lumi has not quote-checked it yet. Not a negative signal.");
    else {
      if (q.last_valid_quote === false) add("last_quote_invalid", "warn", `Lumi's last free quote check (${q.last_checked_at}) did not get a valid x402 quote${q.last_note ? `: ${String(q.last_note).slice(0, 120)}` : ""}.`);
      if (q.last_quote_pays_listed_address === false) add("quote_pays_unlisted_address", "block", "At Lumi's last check the live 402 quote paid an address that is not in the listing.");
      if (q.last_price_matches_listing === false) add("quoted_price_differs", "warn", `At Lumi's last check the quoted price ($${q.last_quoted_price_usd}) differed from the listing ($${e.listed_price_usd}).`);
      if (typeof q.valid_quote_rate === "number" && q.checks_recorded >= 3 && q.valid_quote_rate < 0.5) add("unreliable_quotes", "warn", `Only ${Math.round(q.valid_quote_rate * 100)}% of ${q.checks_recorded} quote checks were valid.`);
      if (typeof q.median_latency_ms === "number" && q.median_latency_ms > 5000) add("slow", "warn", `Median quote latency ${q.median_latency_ms} ms.`);
    }
    const ps: Json[] = e.purchases ?? [];
    const last = ps.find(conclusive);
    if (ps[0] && !conclusive(ps[0])) add("purchase_inconclusive", "info", inconclusiveText(ps[0], "test-buy"));
    if (last) {
      if (last.data_returned === false) {
        // checks_failed from test-buys only after failed buys on >= 2 UTC days within 14 days, no
        // success since, and a confirming re-buy. Otherwise check_first and a confirm re-buy is requested. Old evidence is capped.
        const st = failureStreak(ps, now);
        const ageDays = (now - Date.parse(last.at)) / 86_400_000;
        const facts = `Lumi's latest test-buy (${last.at}, tx ${last.tx_hash}) paid and got no usable data (HTTP ${last.http_status}); ${st.failed} failed in a row, ${st.failedInWindow} on ${st.failedDays} UTC day(s) in the last ${FAILED_RULE.windowDays} days.`;
        if (ageDays > EVIDENCE_NO_DATA_AFTER_DAYS) add("old_buy_failed", "info", `${facts} This is more than ${EVIDENCE_NO_DATA_AFTER_DAYS} days old and no longer counts.`);
        else if (st.qualifies && ageDays <= EVIDENCE_CAUTION_AFTER_DAYS) add("paid_no_data", "block", `${facts} This includes a confirming re-buy and no later buy succeeded.`);
        else { add("recent_buy_failed", "warn", `${facts} Lumi needs failed buys on ${FAILED_RULE.minFailedDays} different days within ${FAILED_RULE.windowDays} days plus a confirming re-buy before reporting checks_failed; a re-buy is requested.`); confirmRebuy = st.confirmDue && ageDays <= FAILED_RULE.windowDays; }
      }
      else add("purchase_verified", "info", `Lumi paid ${last.amount} ${last.asset} on ${last.at} and got data back (tx ${last.tx_hash}).`);
    }
    if (e.listed_until) add("delisted", "warn", `No longer in the Bazaar listing (last seen ${e.listed_until}).`);
    // Listing reachability: only the 3-strike flag adds a reason (check_first); notes such as no_paywall or a payTo
    // difference stay disclosure in `reachability`. Clears with the flag on the next check that gets an answer.
    const reach = e.reachability;
    const day = (x: unknown) => (typeof x === "string" ? x.slice(0, 10) : "unknown date");
    if (reach?.flag === "listing_looks_dead") add("listing_looks_dead", "warn", `listing looks dead: do not pay until it answers again. Lumi's last ${reach.failed_checks_in_a_row} checks on separate occasions got no working answer (last checked ${day(reach.last_checked_at)}, ${reach.last_result ?? "no answer"}).`);
  }
  const age = ref?.domain_age?.age_days;
  if (typeof age === "number" && age < 30) add("young_domain", "warn", `The domain was registered ${age} days ago.`);

  // Free evidence (dated facts, attributed): Coinbase Bazaar usage, payTo census, vet402 (third party).
  const day = (x: unknown) => (typeof x === "string" ? x.slice(0, 10) : "unknown date");
  const bq = e?.bazaar_quality;
  if (bq) {
    if (bq.calls_30d > 0) add("bazaar_usage", "info", `Coinbase Bazaar reports ${bq.calls_30d} calls from ${bq.unique_payers_30d ?? "?"} unique payers in the 30 days before ${day(bq.as_of)}${bq.last_called_at ? ` (last called ${day(bq.last_called_at)})` : ""}.`);
    else add("no_bazaar_usage", "info", `Coinbase Bazaar reports no calls in the 30 days before ${day(bq.as_of)}.`);
  }
  for (const c of (exact?.payto_census ?? []) as Json[]) {
    if (c.status !== "ok") { if (c.status === "queued") add("payto_census_queued", "info", `A ledger read of payTo ${c.pay_to} is queued; check again in a few minutes.`); continue; }
    const chain = c.network === "xrpl:0" ? "XRPL" : "Base";
    const win = c.window?.from ? ` between ${day(c.window.from)} and ${day(c.window.to)}` : "";
    if (c.organic_payers > 0) add("organic_payers", "info", `${chain} payTo ${c.pay_to}: ${c.organic_payers} organic payer cluster(s), ${c.organic_payments} payment(s)${win}, last ${day(c.last_organic_at)} (Lumi, known test wallets and self-funded payers excluded).`);
    else if (c.payers_seen > 0) add("no_organic_payers", "warn", `${chain} payTo ${c.pay_to}: ${c.payers_seen} payer(s) seen${win}, but all were Lumi, known test wallets, or funded by the seller.`);
    else add("no_organic_payers", "info", `${chain} payTo ${c.pay_to}: no incoming x402-style payments seen${win}.`);
  }
  const v = e?.third_party?.vet402;
  if (v) {
    if (v.l0?.verdict === "fail") add("vet402_l0_fail", "warn", `vet402 (third party, CC BY 4.0) recorded a failed free probe on ${day(v.l0.probed_at)}; source ${v.link}.`);
    else if (v.l0?.verdict) add("vet402_l0", "info", `vet402 (third party, CC BY 4.0) free probe verdict "${v.l0.verdict}" on ${day(v.l0.probed_at)}.`);
    if (v.l1) add("vet402_l1", "info", `vet402 (third party) recorded ${v.l1.purchase_attempts} purchase attempt(s), ${v.l1.settled} settled, ${v.l1.settled_with_2xx} with a 2xx response (last ${day(v.l1.last_at)}). Not counted in Lumi's own test-buys.`);
  }

  const verdict = sanctionedHit ? "block" : self ? "allow" : reasons.some((r) => r.severity === "block") ? "block" : reasons.some((r) => r.severity === "warn") ? "warn" : reasons.some((r) => NO_DATA_CODES.includes(r.code)) ? "unknown" : "allow";
  if (verdict === "allow" && e && !reasons.some((r) => r.code === "purchase_verified")) add("quote_verified", "info", "Listed in the Bazaar and its recent free quote checks are valid.");
  const confidence = self ? "n/a" : (e?.purchases ?? []).some(conclusive) || (!e && curated.length) ? "medium" : e?.quote_checks ? "low" : "very low";
  const cur = curated[0];
  return envelope("trust_check", compact({
    query: compact({ url: input.url, payTo: input.payTo, amount_usd: input.amountUsd, network: input.network }),
    verdict,
    confidence,
    reasons,
    confirm_rebuy: confirmRebuy || undefined,
    matched: ref ? compact({ resource: ref.resource, domain: ref.domain, tier: ref.tier, listed_price_usd: ref.listed_price_usd, pay_to: (ref.pay_to ?? []).slice(0, 4), last_quote_check: ref.quote_checks?.last_checked_at, exact: !!e }) : null,
    next_steps: compact({
      free_lookup: `${base}/v1/trust/vendors?url=${encodeURIComponent(input.url)}`,
      full_report: cur?.id ? { url: `${base}/v1/trust/vendors/${cur.id}/report`, price_usd: "0.02", what: "every quote check and paid test-buy with tx hashes, latency trend, uptime %" } : null,
    }),
    note: "Observations, not a rating or a guarantee. label: checks_passed / check_first / checks_failed / no_data (verdict is the older allow / warn / block / unknown name for the same result; see /v1/verdict/rules).",
  }));
}
