/**
 * Catalog listing reachability (dead-listing flags). One row per listing: the reach_* columns of `catalog` (migration
 * 0031) are updated in place, never appended. Two sources feed it, both unpaid checks that happen anyway:
 *   - the Worker's rotating free 402-quote check (probeRow), written in the same UPDATE as the probe_* columns;
 *   - the operator box test-buyer's quote step that stopped before paying ("skip" events), posted by the owner to
 *     POST /v1/trust/catalog/reachability (batched, at most REACH_POST_MAX per call).
 *
 * Rules (Bobby, 2026-10-26):
 *   1. Three strikes. A listing is flagged "listing looks dead" only after REACH_STRIKES consecutive failed checks on
 *      separate occasions (checks at least REACH_OCCASION_GAP_MS apart). Failures are 404, 410, DNS / connection failure
 *      (no answer at all) and, counted as "down when checked", 5xx and timeouts. One failure never flags a listing.
 *   2. HTTP 2xx without a 402 paywall: plain factual note, not a penalty.
 *   3. A quote whose payTo differs from the listing: factual caution. Lumi never pays these.
 *   4. 400/401/405 (and other 4xx): needs a different request or its own key. Neutral, not dead.
 *   5. Nothing here touches any score. Paying never changes a score.
 *   6. Every flag carries the date it was last checked and clears on the next check that gets an answer.
 * Wording is factual only (no accusations); see REACH_TEXT.
 */
import type { CatalogRow, ProbeResult } from "./catalog";

export type ReachKind = "ok" | "dead" | "down" | "needs_request" | "no_paywall" | "pay_to_differs" | "rate_limited";
export interface ReachCheck { ts: number; kind: ReachKind; detail: string }
export interface ReachState {
  reach_at: number | null;
  reach_kind: ReachKind | null;
  reach_detail: string | null;
  /** Failed checks in a row, counted once per occasion. 0 after any answer. */
  reach_strikes: number | null;
  /** When the latest counted strike happened (the occasion-gap anchor). */
  reach_strike_at: number | null;
  /** First failed check of the current run of failures. */
  reach_since: number | null;
}

export const REACH_STRIKES = 3;
/** Checks closer together than this are one occasion: they update "last checked" but add no strike. */
export const REACH_OCCASION_GAP_MS = 12 * 3_600_000;
export const REACH_POST_MAX = 200;

export const REACH_TEXT = {
  listing_looks_dead: "listing looks dead: Lumi's last 3 checks, on separate occasions, got no working answer. Do not pay this listing until it answers again.",
  down_when_checked: "down when checked. One failed check is not a flag.",
  no_paywall: "no paywall: returned data without asking for payment",
  pay_to_differs: "payment address in the quote does not match the listing",
  needs_different_request: "needs a different request or its own key",
  rate_limited: "rate limited when checked",
  clears: "Clears automatically when a later check gets an answer.",
} as const;

const FAIL: ReadonlySet<ReachKind> = new Set(["dead", "down"]);
export const isFailure = (k: ReachKind | null | undefined) => !!k && FAIL.has(k);

function fromStatus(status: number): { kind: ReachKind; detail: string } {
  const detail = `HTTP ${status}`;
  if (status === 404 || status === 410) return { kind: "dead", detail };
  if (status >= 500) return { kind: "down", detail };
  if (status === 429) return { kind: "rate_limited", detail };
  if (status >= 200 && status < 300) return { kind: "no_paywall", detail };
  return { kind: "needs_request", detail }; // 3xx, 400, 401, 403, 405, 406, 422, 423 ...
}

/**
 * A test-buyer skip reason -> one reachability check. Null when the skip is not about the seller at all (Lumi's own
 * budget, balance, listed-price limit) or the text is not recognised: those are never recorded.
 */
export function classifySkipReason(reason: string): { kind: ReachKind; detail: string } | null {
  const r = String(reason ?? "");
  const m = /^HTTP (\d{3}) \(expected 402\)/.exec(r);
  if (m) return fromStatus(Number(m[1]));
  if (/^(listed price|budget \(|buyer balance)/.test(r)) return null;
  if (/fetch failed|network error|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(r)) return { kind: "dead", detail: "no answer (DNS or connection failure)" };
  if (/timeout|timed out|aborted/i.test(r)) return { kind: "down", detail: "no answer before the timeout" };
  if (/^quote payTo .* differs from listing/.test(r)) return { kind: "pay_to_differs", detail: "quote payTo differs from listing" };
  // It answered with a 402 payment request; the reason it was not bought is on Lumi's side (limits, chain, format).
  if (/^(unreadable 402|no Base USDC|price .* above|transfer method|quote lacks EIP-712)/.test(r)) return { kind: "ok", detail: "answered with a 402 payment request" };
  return null;
}

/** The Worker's own free quote check -> one reachability check. */
export function classifyProbe(p: Pick<ProbeResult, "ts" | "status" | "valid" | "pay_to_match" | "error">): ReachCheck {
  if (p.status == null) {
    return /no answer within/i.test(p.error ?? "")
      ? { ts: p.ts, kind: "down", detail: "no answer before the timeout" }
      : { ts: p.ts, kind: "dead", detail: "no answer (DNS or connection failure)" };
  }
  if (p.status === 402) {
    if (p.valid && p.pay_to_match === false) return { ts: p.ts, kind: "pay_to_differs", detail: "quote payTo differs from listing" };
    return { ts: p.ts, kind: "ok", detail: "answered with a 402 payment request" };
  }
  return { ts: p.ts, ...fromStatus(p.status) };
}

export function reachStateOf(row: Partial<CatalogRow> | null | undefined): ReachState {
  return {
    reach_at: row?.reach_at ?? null, reach_kind: (row?.reach_kind as ReachKind | null | undefined) ?? null, reach_detail: row?.reach_detail ?? null,
    reach_strikes: row?.reach_strikes ?? null, reach_strike_at: row?.reach_strike_at ?? null, reach_since: row?.reach_since ?? null,
  };
}

/**
 * Fold one check into the stored state. A check older than the stored one is ignored (the latest check wins). An answer
 * of any kind resets the strikes; a failure adds a strike only on a new occasion.
 */
export function nextReach(prev: ReachState, c: ReachCheck): ReachState {
  if (prev.reach_at != null && c.ts < prev.reach_at) return prev;
  if (!isFailure(c.kind)) return { reach_at: c.ts, reach_kind: c.kind, reach_detail: c.detail, reach_strikes: 0, reach_strike_at: null, reach_since: null };
  const strikes = prev.reach_strikes ?? 0;
  const sameOccasion = strikes > 0 && prev.reach_strike_at != null && c.ts - prev.reach_strike_at < REACH_OCCASION_GAP_MS;
  return {
    reach_at: c.ts, reach_kind: c.kind, reach_detail: c.detail,
    reach_strikes: sameOccasion ? strikes : strikes + 1,
    reach_strike_at: sameOccasion ? prev.reach_strike_at : c.ts,
    reach_since: strikes > 0 ? prev.reach_since ?? c.ts : c.ts,
  };
}

export const reachChanged = (a: ReachState, b: ReachState) =>
  a.reach_at !== b.reach_at || a.reach_kind !== b.reach_kind || a.reach_detail !== b.reach_detail || a.reach_strikes !== b.reach_strikes || a.reach_strike_at !== b.reach_strike_at || a.reach_since !== b.reach_since;

export type ReachStatus = "answering" | "down_when_checked" | "listing_looks_dead";
export type ReachFlag = "listing_looks_dead" | "no_paywall" | "pay_to_differs" | "needs_different_request" | null;
export interface ReachView {
  status: ReachStatus;
  flag: ReachFlag;
  note: string | null;
  last_checked_at: string;
  last_result: string | null;
  failed_checks_in_a_row: number;
  failing_since: string | null;
}

const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

/** Public shape (free and paid views, Lumi Check). Null when Lumi has no reachability check of this listing yet. */
export function reachView(row: Partial<CatalogRow> | null | undefined): ReachView | null {
  const s = reachStateOf(row);
  if (s.reach_at == null || s.reach_kind == null) return null;
  const strikes = s.reach_strikes ?? 0;
  const base = { last_checked_at: iso(s.reach_at)!, last_result: s.reach_detail, failed_checks_in_a_row: isFailure(s.reach_kind) ? strikes : 0, failing_since: isFailure(s.reach_kind) ? iso(s.reach_since) : null };
  if (isFailure(s.reach_kind)) {
    return strikes >= REACH_STRIKES
      ? { status: "listing_looks_dead", flag: "listing_looks_dead", note: `${REACH_TEXT.listing_looks_dead} ${REACH_TEXT.clears}`, ...base }
      : { status: "down_when_checked", flag: null, note: `${REACH_TEXT.down_when_checked} ${REACH_TEXT.clears}`, ...base };
  }
  const flag: ReachFlag = s.reach_kind === "no_paywall" ? "no_paywall" : s.reach_kind === "pay_to_differs" ? "pay_to_differs" : s.reach_kind === "needs_request" ? "needs_different_request" : null;
  const note = flag ? REACH_TEXT[flag] : s.reach_kind === "rate_limited" ? REACH_TEXT.rate_limited : null;
  return { status: "answering", flag, note, ...base };
}
