/**
 * ONE label vocabulary for the free /v1/check, the paid /v1/trust/check and /v1/verdict (legal review 2026-10-25, M4):
 *
 *   checks_passed  "Delivered in recent checks"
 *   check_first    "Check first"
 *   checks_failed  "Recent checks failed"
 *   no_data        "Not enough data" (not a negative signal)
 *
 * The label is computed by labelFor() from the shared check core (trustVerdict in src/quick.ts + the review/appeal gate in
 * src/trust/reviews.ts) and Lumi's own dated test-buys. /v1/check and /v1/verdict call the same function on the same data,
 * so they cannot disagree. Nothing about the seller's relationship with Lumi (monitoring, reports, payments to Lumi, being a
 * competitor or a customer) is an input: labelFor() takes no such field. Customer-activity counts are not an input either
 * (review §6.3: never feed them into a negative verdict).
 *
 * Every threshold and sentence lives here or in FAILED_RULE (below) so the review can change them in one place.
 */

export type Label = "checks_passed" | "check_first" | "checks_failed" | "no_data";
export const LABELS: Record<Label, string> = {
  checks_passed: "Delivered in recent checks",
  check_first: "Check first",
  checks_failed: "Recent checks failed",
  no_data: "Not enough data",
};
/** Legacy /v1/check `decision` values (kept for existing clients) -> label. Published in the docs. */
export const DECISION_TO_LABEL: Record<string, Label> = { block: "checks_failed", warn: "check_first", unknown: "no_data", allow: "checks_passed" };

export const VERDICT_KIND = "lumi_verdict";
/** Bump when the mapping, thresholds or wording change, so signed responses say which rules produced them. */
export const VERDICT_RULES_VERSION = "2026-10-25.2";
export const DISPUTE_URL = "https://lumitrades.io/contact/";
export const DEFINITION =
  "This is a summary of Lumi's own dated observations of this endpoint, not a rating of the business or a statement about its honesty. checks_failed means that, in the window shown, at least two of Lumi's paid test-buys on different days paid and got no usable data, a confirming re-buy failed too, no later buy succeeded and a person at Lumi reviewed it (or the quote paid an unlisted address, an address that is not the seller's, a higher price than listed, or an address on the OFAC SDN list). no_data means Lumi has too little evidence and is not a negative signal. Sellers can reply or ask for a re-test at hello@lumitrades.io, https://lumitrades.io/contact/ or /v1/trust/replies; an open re-test request pauses checks_failed for up to 72 hours while Lumi re-buys. Paying Lumi never changes this result.";

/**
 * The evidence bar for a test-buy based checks_failed (M1). Live quote mismatches and OFAC hits do not use it (immediate).
 * minFailedDays: failed conclusive paid buys on at least this many different UTC days...
 * windowDays: ...within this many days, with no successful buy since...
 * requireConfirm: ...plus one more failed buy after that (the automatic confirm re-buy) before the label can flip.
 */
export const FAILED_RULE = { minFailedDays: 2, windowDays: 14, requireConfirm: true };
/** Appeal / re-test request: checks_failed is paused (shown as check_first, retest_requested) for this long while Lumi re-buys. */
export const APPEAL_PAUSE_HOURS = 72;
/** /v1/check note (legal review M5 + N2 wording, verbatim). */
export const CHECK_NOTE =
  "Free pre-pay check. Paying Lumi (checks, monitoring, reports) never changes a score, tier, ranking or 'Tested by Lumi' result. The paid 'Monitored by Lumi' badge is separate and labelled as paid. " +
  "Only origin + path of the URL is used. We don't store who checked what. A checked seller that shows a warning signal may be queued for a test-buy.";
/** M1 recency caps: evidence older than checkFirstAfterDays supports at most check_first; older than noDataAfterDays, no_data. */
export const EVIDENCE_AGE = { checkFirstAfterDays: 30, noDataAfterDays: 90 };

export interface VerdictThresholds {
  /** checks_passed needs a delivered Lumi test-buy no older than this many days (else check_first: untested or stale). */
  payMaxAgeDays: number;
  /** Customer activity (information only): fewest independent payer groups before anything is shown (M8). */
  activityMinPayerGroups: number;
  /** Customer-activity rows older than this are not shown. */
  activityMaxAgeDays: number;
  /** Top-payer share (%) at which the information-only concentration flag is shown (only with >= activityMinPayerGroups). */
  concentrationPct: number;
}
export const VERDICT_DEFAULTS: VerdictThresholds = { payMaxAgeDays: 30, activityMinPayerGroups: 5, activityMaxAgeDays: 14, concentrationPct: 60 };

export function verdictThresholds(env: Record<string, string | undefined> = {}): VerdictThresholds {
  const n = (k: string, lo: number, hi: number, d: number) => { const v = env[k]; const x = v == null || v.trim() === "" ? NaN : Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
  return {
    payMaxAgeDays: n("VERDICT_PAY_MAX_AGE_DAYS", 1, EVIDENCE_AGE.checkFirstAfterDays, VERDICT_DEFAULTS.payMaxAgeDays), // never above 30 (M1)
    activityMinPayerGroups: n("VERDICT_ACTIVITY_MIN_GROUPS", 5, 1000, VERDICT_DEFAULTS.activityMinPayerGroups), // never below 5 (M8)
    activityMaxAgeDays: n("VERDICT_ACTIVITY_MAX_AGE_DAYS", 1, 90, VERDICT_DEFAULTS.activityMaxAgeDays),
    concentrationPct: n("VERDICT_CONCENTRATION_PCT", 1, 100, VERDICT_DEFAULTS.concentrationPct),
  };
}

/** Lumi's own test-buys of this seller (from the same lookup /v1/check uses). Inconclusive buys (Lumi-side) never count. */
export interface TestBuyEvidence {
  last_at: string | null;
  last_delivered: boolean | null;
  last_delivered_at: string | null;
  last_failed_at: string | null;
  consecutive_failed: number;
  conclusive: number;
  /** Oldest and newest conclusive buy in the lookup (the evidence window). */
  window_from: string | null;
  window_to: string | null;
}

export interface CheckLike { decision: string; reasons: { code: string; severity: string }[] }

const day = (iso: string | null | undefined) => (typeof iso === "string" ? iso.slice(0, 10) : "an unknown date");

/**
 * Plain-language, factual one-liners keyed by check reason code (or label-only codes). Never accusations: each states what
 * Lumi observed and when. Edit freely; tests check the code mapping, not the prose.
 */
export const WORDING: Record<string, (t: TestBuyEvidence, th: VerdictThresholds) => string> = {
  // checks_failed (a check "block" reason)
  sanctioned_address: () => "A payTo address for this seller appears on the OFAC SDN sanctions list.",
  paid_no_data: (t) => `Lumi's last ${t.consecutive_failed} paid test-buys (latest ${day(t.last_failed_at)}) got no usable data back, on at least ${FAILED_RULE.minFailedDays} different days, including a confirming re-buy; reviewed by a person at Lumi.`,
  pay_to_mismatch: () => "The payTo you were quoted is not an address this seller lists or that Lumi has on record for it.",
  quote_pays_unlisted_address: () => "At Lumi's latest quote check, the seller's 402 quote paid an address that is not in its listing.",
  price_above_listing: () => "The amount you were quoted is more than 1.5x the seller's listed price.",
  // check_first (a check "warn" reason, or a gate code)
  checks_failed_pending_review: () => "Lumi's recent paid test-buys of this seller got no usable data; a person at Lumi is reviewing before anything stronger is shown.",
  retest_requested: () => `The seller asked for a re-test; Lumi is re-buying, and the result is paused for up to ${APPEAL_PAUSE_HOURS} hours.`,
  recent_buy_failed: (t) => `Lumi's latest paid test-buy (${day(t.last_failed_at)}) got no usable data back; Lumi re-buys before reporting anything stronger.`,
  xrpl_paid_no_data: (t) => `Lumi's latest XRPL test-buy (${day(t.last_failed_at ?? t.last_at)}) got no usable data back.`,
  pay_to_unrecognised: () => "The payTo you were quoted is not one Lumi has on record for this seller; it may be new.",
  last_quote_invalid: () => "Lumi's latest free quote check did not get a valid x402 quote.",
  unreliable_quotes: () => "Fewer than half of Lumi's recent quote checks of this seller returned a valid x402 quote.",
  quoted_price_differs: () => "At Lumi's latest quote check, the quoted price differed from the listed price.",
  delisted: () => "This resource is no longer in the x402 Bazaar listing.",
  young_domain: () => "The seller's domain was registered less than 30 days ago.",
  no_organic_payers: () => "Payers seen at this seller's payTo were all Lumi, known test wallets, or funded by the seller.",
  vet402_l0_fail: () => "A third-party monitor (vet402) recorded a failed free probe of this seller.",
  slow: () => "The seller's median quote latency is above 5 seconds.",
  no_recent_xrpl_buy: () => "Lumi has not test-bought this seller on XRPL in the last 30 days.",
  resource_not_listed: () => "This exact URL is not listed, but other listings on the same domain are; check the exact resource URL.",
  untested: () => "Listing and quote checks agree, but Lumi has not completed a paid test-buy of this seller yet.",
  old_evidence: (t) => `Lumi's newest test-buy evidence for this seller (${day(t.last_at)}) is more than ${EVIDENCE_AGE.noDataAfterDays} days old, so it no longer supports a label. This is not a negative signal.`,
  stale_test: (t, th) => `Lumi's last delivered test-buy was on ${day(t.last_delivered_at)}, more than ${th.payMaxAgeDays} days ago.`,
  // no_data
  not_observed: () => "Lumi has no observations of this seller yet. This is not a negative signal.",
  not_quote_checked: () => "Listed in the x402 Bazaar, but Lumi has not checked it yet. This is not a negative signal.",
  lumi_itself: () => "This is Lumi's own API; Lumi does not rate itself.",
  // checks_passed
  delivered_recently: (t) => `Lumi's paid test-buy on ${day(t.last_delivered_at)} delivered, and the listing and quote checks agree.`,
  generic_block: () => "Lumi's check found a concrete mismatch; see the evidence link.",
  generic_warn: () => "Lumi's check does not have enough evidence yet; see the evidence link.",
};

/** Order in which reasons are chosen for the one-line reason (first present wins). */
export const BLOCK_PRIORITY = ["sanctioned_address", "pay_to_mismatch", "price_above_listing", "quote_pays_unlisted_address", "paid_no_data"];
export const WARN_PRIORITY = [
  "retest_requested", "checks_failed_pending_review", "recent_buy_failed", "xrpl_paid_no_data", "pay_to_unrecognised", "last_quote_invalid",
  "unreliable_quotes", "quoted_price_differs", "delisted", "young_domain", "no_organic_payers", "vet402_l0_fail", "slow", "no_recent_xrpl_buy", "resource_not_listed",
];
export const NO_DATA_PRIORITY = ["not_observed", "not_quote_checked", "lumi_itself", "old_evidence"];

export const conclusiveBuy = (p: any) => !!p && !p.inconclusive && p.delivery !== "inconclusive" && p.data_returned !== null && p.data_returned !== undefined && !(p.data_returned === false && (p.http_status == null || p.http_status === 0));

/**
 * M1: does a run of failed buys meet FAILED_RULE? `buys` newest first (any order is sorted). Returns the streak facts either way.
 */
export function failureStreak(buys: any[], now: number, rule = FAILED_RULE) {
  const c = buys.filter(conclusiveBuy).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const streak: any[] = [];
  for (const b of c) { if (b.data_returned === false) streak.push(b); else break; }
  const inWindow = streak.filter((b) => now - Date.parse(b.at) <= rule.windowDays * 86_400_000);
  const days = (xs: any[]) => new Set(xs.map((b) => String(b.at).slice(0, 10))).size;
  // With requireConfirm, the newest failure must come after the minFailedDays condition was already met by older failures.
  const qualifies = rule.requireConfirm ? inWindow.length >= 2 && days(inWindow.slice(1)) >= rule.minFailedDays : days(inWindow) >= rule.minFailedDays;
  // A confirm re-buy is due when the two-day condition is met but not yet confirmed, or after a fresh first failure.
  const confirmDue = !qualifies && inWindow.length > 0;
  return { qualifies, confirmDue, streakStartAt: streak.length ? streak[streak.length - 1].at as string : null, failed: streak.length, failedInWindow: inWindow.length, failedDays: days(inWindow), lastFailedAt: streak[0]?.at ?? null };
}

/** Test-buy evidence from the same lookup docs trustVerdict read (exact entry first, else the curated record). */
export function testBuyEvidence(exact: any, dom: any): TestBuyEvidence {
  const entry = exact?.catalog?.entries?.[0] ?? null;
  const curated = [...(exact?.curated ?? []), ...(dom?.curated ?? [])][0] ?? null;
  const buys: any[] = (entry ? entry.purchases : !dom?.catalog?.entries?.length ? curated?.purchases : null) ?? [];
  const c = buys.filter(conclusiveBuy).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let fails = 0;
  for (const b of c) { if (b.data_returned === false) fails++; else break; }
  return {
    last_at: c[0]?.at ?? null,
    last_delivered: c.length ? c[0].data_returned !== false : null,
    last_delivered_at: c.find((b) => b.data_returned !== false)?.at ?? null,
    last_failed_at: c.find((b) => b.data_returned === false)?.at ?? null,
    consecutive_failed: fails,
    conclusive: c.length,
    window_from: c.length ? c[c.length - 1].at : null,
    window_to: c[0]?.at ?? null,
  };
}

export interface LabelResult { label: Label; reason_code: string; reason: string }

/** The whole mapping from the shared check result (+ Lumi's own test-buy dates) to a label. Nothing else is an input. */
export function labelFor(o: { check: CheckLike; tests: TestBuyEvidence; now: number; th: VerdictThresholds }): LabelResult {
  const { check, tests, th } = o;
  const codes = new Set(check.reasons.map((r) => r.code));
  const say = (label: Label, code: string): LabelResult => ({ label, reason_code: code, reason: (WORDING[code] ?? WORDING[label === "checks_failed" ? "generic_block" : "generic_warn"])(tests, th) });
  const pick = (order: string[], sev?: string) => { const xs = check.reasons.filter((r) => !sev || r.severity === sev).map((r) => r.code); return order.find((c) => xs.includes(c)) ?? xs[0]; };
  if (check.decision === "block") return say("checks_failed", pick(BLOCK_PRIORITY, "block") ?? "generic_block");
  if (check.decision === "warn") return say("check_first", pick(WARN_PRIORITY, "warn") ?? "generic_warn");
  if (check.decision === "unknown") return say("no_data", NO_DATA_PRIORITY.find((c) => codes.has(c)) ?? "not_observed");
  if (codes.has("lumi_itself")) return say("no_data", "lumi_itself");
  if (!tests.last_delivered_at) return say("check_first", "untested");
  if ((o.now - Date.parse(tests.last_delivered_at)) / 86_400_000 > EVIDENCE_AGE.noDataAfterDays) return say("no_data", "old_evidence");
  if (!((o.now - Date.parse(tests.last_delivered_at)) / 86_400_000 <= th.payMaxAgeDays)) return say("check_first", "stale_test");
  return say("checks_passed", "delivered_recently");
}

/** Human description of the rules, served free at /v1/verdict/rules and in the docs. */
export function thresholdsDoc(th: VerdictThresholds) {
  return {
    rules_version: VERDICT_RULES_VERSION,
    labels: LABELS,
    legacy_decision_mapping: DECISION_TO_LABEL,
    definition: DEFINITION,
    checks_failed: `Immediate only for facts about the quote itself: the payTo you were quoted is not the seller's, the amount is over 1.5x the listing, the seller's live quote paid an unlisted address (reviewed by a person first), or an OFAC SDN hit. From test-buys only after failed paid buys on at least ${FAILED_RULE.minFailedDays} different UTC days within ${FAILED_RULE.windowDays} days, no success since, a further failed confirming re-buy, and review by a person at Lumi.`,
    check_first: `Not enough positive evidence yet: a warning signal from the check, a failed test-buy that has not met the bar above, a pending review or re-test (paused up to ${APPEAL_PAUSE_HOURS} h), or no Lumi test-buy delivered within ${th.payMaxAgeDays} days.`,
    checks_passed: `The check found no warning and a Lumi paid test-buy delivered within ${th.payMaxAgeDays} days.`,
    no_data: `Lumi has no observations (or has not checked this listing yet), its newest test-buy evidence is more than ${EVIDENCE_AGE.noDataAfterDays} days old, or it is Lumi itself. Not a negative signal.`,
    evidence_age: EVIDENCE_AGE,
    failed_rule: FAILED_RULE,
    appeal_pause_hours: APPEAL_PAUSE_HOURS,
    pay_max_age_days: th.payMaxAgeDays,
    never_considered: "Whether the seller pays Lumi for anything (monitoring, reports), whether it is a competitor or customer of Lumi (disclosed in `relationship`, never used), whether you paid for this answer, and on-chain payment activity.",
  };
}
