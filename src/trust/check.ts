import { DECISION_TO_LABEL, LABELS, DISPUTE_URL, type Label } from "./verdict";
/**
 * Lumi Check v0 (server side, proprietary): the free pre-pay check, the signed payload of the paid trust/check, and the
 * earned-only "Tested by Lumi" badge (signed, short-lived, linked to the live score).
 *
 *   GET /v1/check?url=&payTo=&amount=&network=   free, rate-limited like free lookups: allow / warn / block, reason
 *                                                codes, the seller's current Lumi score, a link, and a signed receipt.
 *                                                Answer-only (codes, no tx hashes); the paid /v1/trust/check adds detail.
 *   GET /v1/check/keys                           Lumi's public signing key(s) (also /.well-known/lumi-keys.json)
 *   GET /v1/badge/{key}.json                     earned-only badge: signed JSON verdict, valid BADGE_SIGNED_TTL_SEC
 *   GET /v1/badge/{key}.svg                      rendered from the same decision; "no badge" when not earned
 *
 * Privacy: only origin + path of the checked URL is used or echoed (query strings and fragments are dropped before any
 * lookup, signing or logging), and nothing about the query is logged.
 * Integrity: the badge decision takes ONLY the live score inputs (score value, confidence, sample counts, latest
 * conclusive test-buy). It has no access to monitoring plans, payments to Lumi or contributor badges.
 */
import { esc } from "./badge";

/** Origin + path only: no query string, fragment or userinfo. Null for non-http(s) or unparsable input. */
export function originPath(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(String(u).trim());
    if (x.protocol !== "https:" && x.protocol !== "http:") return null;
    let p = x.pathname || "/";
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return `${x.protocol}//${x.host.toLowerCase()}${p}`;
  } catch {
    return null;
  }
}

export const CHECK_SIGNED_TTL_SEC = 15 * 60;
export const BADGE_SIGNED_TTL_SEC = 15 * 60;
/**
 * Badge thresholds, approved by the owner on Oct 23 2026 (earned-only, auto-removal, score >= 80 AND >= 3 conclusive paid
 * Lumi test-buys). These are the defaults; a deployment can override them with the BADGE_MIN_SCORE /
 * BADGE_MIN_PAID_TESTS vars (see badgeThresholds). Inconclusive test-buys never count toward the minimum.
 */
export const BADGE_MIN_SCORE = 80;
export const BADGE_MIN_PAID_TESTS = 3;
export interface BadgeThresholds { minScore: number; minPaidTests: number }
export const DEFAULT_BADGE_THRESHOLDS: Readonly<BadgeThresholds> = Object.freeze({ minScore: BADGE_MIN_SCORE, minPaidTests: BADGE_MIN_PAID_TESTS });

/** Thresholds from env overrides; anything missing or out of range (score 1..100, tests integer >= 1) keeps the default. */
export function badgeThresholds(env: { BADGE_MIN_SCORE?: string; BADGE_MIN_PAID_TESTS?: string } = {}): BadgeThresholds {
  const num = (v: string | undefined) => (v == null || v.trim() === "" ? NaN : Number(v));
  const sc = num(env.BADGE_MIN_SCORE), pt = num(env.BADGE_MIN_PAID_TESTS);
  return {
    minScore: Number.isFinite(sc) && sc >= 1 && sc <= 100 ? sc : BADGE_MIN_SCORE,
    minPaidTests: Number.isInteger(pt) && pt >= 1 && pt <= 1000 ? pt : BADGE_MIN_PAID_TESTS,
  };
}
export const BADGE_CACHE = "public, max-age=300, s-maxage=300";

export interface ScoreInput {
  value: number | null;
  confidence: string;
  samples: { paid_test_buys: number; delivered: number; inconclusive_test_buys?: number };
}

/**
 * Earned-only rule. Inputs are the live score only; extra fields (e.g. monitoring or payment status) are ignored by design.
 * Earned = score >= minScore (default BADGE_MIN_SCORE), at least minPaidTests (default BADGE_MIN_PAID_TESTS) conclusive Lumi test-buys in the window, the latest
 * conclusive test-buy delivered, and the vendor is not currently unreachable.
 */
export function badgeDecision(s: { score: ScoreInput; last_conclusive: "delivered" | "not_delivered" | null; status?: string }, t: BadgeThresholds = DEFAULT_BADGE_THRESHOLDS) {
  const v = s.score.value;
  const conclusive = (s.score.samples.paid_test_buys ?? 0) - (s.score.samples.inconclusive_test_buys ?? 0);
  if (v == null) return { earned: false as const, reason: "not_scored" };
  if (conclusive < t.minPaidTests) return { earned: false as const, reason: "too_few_lumi_test_buys" };
  if (v < t.minScore) return { earned: false as const, reason: "score_below_threshold" };
  if (s.last_conclusive !== "delivered") return { earned: false as const, reason: "latest_test_buy_not_delivered" };
  if (s.status === "unreachable") return { earned: false as const, reason: "currently_unreachable" };
  return { earned: true as const, reason: "score_at_or_above_threshold" };
}

/** Compact, answer-only check payload (signed). Reasons are codes + severity; details stay in the paid check. */
export function checkPayload(o: {
  query: { url?: string | null; payTo?: string; amountUsd?: number; network?: string };
  verdict: Record<string, any>;
  score: Record<string, unknown> | null;
  link: string;
  paid: boolean;
}) {
  const v = o.verdict;
  const reasons = (Array.isArray(v.reasons) ? v.reasons : []).map((r: any) => ({ code: String(r.code), severity: String(r.severity) }));
  return {
    decision: String(v.verdict) as "allow" | "warn" | "block" | "unknown",
    // Shared label set (legal review M4). The legacy decision stays for existing clients; the mapping is in /v1/verdict/rules.
    label: (v.label ?? DECISION_TO_LABEL[String(v.verdict) as keyof typeof DECISION_TO_LABEL] ?? "no_data") as Label,
    label_text: LABELS[(v.label ?? DECISION_TO_LABEL[String(v.verdict) as keyof typeof DECISION_TO_LABEL] ?? "no_data") as Label],
    confidence: v.confidence ?? null,
    reasons,
    query: { url: originPath(o.query.url ?? null), pay_to: o.query.payTo ?? null, amount_usd: o.query.amountUsd ?? null, network: o.query.network ?? null },
    matched: v.matched ? { resource: originPath(v.matched.resource) ?? null, domain: v.matched.domain ?? null, tier: v.matched.tier ?? null, exact: !!v.matched.exact } : null,
    score: o.score,
    link: o.link,
    reply_url: DISPUTE_URL,
    // Disclosure only (M13/M14): never an input to the decision or label.
    relationship: v.relationship ?? null,
    commercial_relationship: v.commercial_relationship ?? [],
    // Free probe-checked tier: always labelled "Checked, not test-bought" unless Lumi has a delivered test-buy; verified is always false.
    free_checks: v.free_checks ?? null,
    paid: o.paid,
  };
}

export function noBadgeSvg(text: string): string {
  const t = esc(text);
  const w = 90 + t.length * 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="Lumi: ${t}"><title>Lumi: ${t}</title><rect width="${w}" height="20" rx="3" fill="#5b6b7c"/><text x="8" y="14" fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">Lumi · ${t}</text></svg>`;
}

export function earnedBadgeSvg(score: number, date: string): string {
  const right = esc(`score ${score} · ${date}`);
  const lw = 98, rw = 20 + right.length * 6.5, w = Math.round(lw + rw);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="Tested by Lumi: ${right}"><title>Tested by Lumi: ${right}. Live score, earned only, not an endorsement or guarantee.</title><rect width="${lw}" height="20" fill="#3a3f47"/><rect x="${lw}" width="${Math.round(rw)}" height="20" fill="#2e8540"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="8" y="14">Tested by Lumi</text><text x="${lw + 8}" y="14">${right}</text></g></svg>`;
}
