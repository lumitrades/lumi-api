/**
 * One plain-English `summary` line on every trust check answer (free /v1/trust/check, paid /v1/trust/check/high-value,
 * the free /v1/check, MCP lumi_trust_check, A2A trust_check), written so an AI agent can show it to its user verbatim.
 * Owner approved building it on a branch, 2026-10-28.
 *
 * Rules (tested in test/summary_line.test.ts):
 *  - Facts only: how many times Lumi test-bought the seller, how many delivered, how many did not, how many were
 *    inconclusive, the date of the latest test-buy (UTC), and Lumi's check label. Nothing else.
 *  - Bad results read exactly as plainly as good ones (the "did not deliver" count is always shown when it is non-zero).
 *  - Never "safe", "trusted", "guaranteed", "recommend", or any wording aimed at the agent rather than its user. No
 *    instructions, no hidden or non-printable characters, plain ASCII, one line.
 *  - No test-buys: says so ("Lumi has not test-bought this ... yet."), never implies a negative finding.
 * The same facts ship machine-readable as `summary_facts`, and both are inside the signed lumi_receipt payload.
 */
import { LABELS, type Label } from "./verdict";

export const SUMMARY_VERSION = "1";

export interface SummaryFacts {
  /** listing: Lumi's record of this exact catalog URL; seller: a curated vendor (windowed); url: no record of this exact URL
   *  (other listings on the domain may exist); not_observed: no record at all; lumi_itself: Lumi's own API. */
  scope: "listing" | "seller" | "url" | "not_observed" | "lumi_itself";
  test_buys: number;
  delivered: number;
  not_delivered: number;
  inconclusive: number;
  /** ISO time of Lumi's latest test-buy in the counted set, or null. */
  last_test_buy_at: string | null;
  /** Counts cover only the last N days (curated vendors); null = every recorded test-buy of the listing. */
  window_days: number | null;
  /** Latest free (unpaid) 402-quote check, when there are no test-buys. */
  last_quote_check: { at: string; valid_quote: boolean | null } | null;
  label: Label | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 28, 2026" (UTC). Null for an unparsable time. */
export function summaryDate(iso: string | number | null | undefined): string | null {
  if (iso == null || iso === "") return null;
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

const n0 = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** Build the facts from the lookup documents the check core already read (exact URL first, then the domain lookup). */
export function summaryFactsFrom(exact: any, dom: any, label: Label | null): SummaryFacts {
  const empty = { test_buys: 0, delivered: 0, not_delivered: 0, inconclusive: 0, last_test_buy_at: null, window_days: null, last_quote_check: null };
  if (exact?.self || dom?.self) return { scope: "lumi_itself", ...empty, label };
  const entry = exact?.catalog?.entries?.[0] ?? null;
  // The exact listing first; else the curated seller this URL belongs to (its windowed test-buys are of this seller, even
  // when other catalog listings share the domain: saying "not test-bought" there would understate what Lumi did).
  const curated = [...(exact?.curated ?? []), ...(dom?.curated ?? [])][0] ?? null;
  if (entry) {
    const tb = entry.test_buys ?? countsFromPurchases(entry.purchases);
    const qc = entry.quote_checks ?? null;
    const lq = entry.last_quote_check ?? null;
    const quote = qc?.last_checked_at ? { at: String(qc.last_checked_at), valid_quote: qc.last_valid_quote ?? null } : lq?.at ? { at: String(lq.at), valid_quote: lq.valid_quote ?? null } : null;
    return {
      scope: "listing",
      test_buys: n0(tb?.count), delivered: n0(tb?.delivered), not_delivered: n0(tb?.not_delivered), inconclusive: n0(tb?.inconclusive),
      last_test_buy_at: tb?.last_at ?? null, window_days: null,
      last_quote_check: n0(tb?.count) ? null : quote,
      label,
    };
  }
  if (curated) {
    const tb = curated.xrpl_test_buys ?? {};
    return {
      scope: "seller",
      test_buys: n0(tb.count), delivered: n0(tb.delivered), not_delivered: n0(tb.not_delivered), inconclusive: n0(tb.inconclusive),
      last_test_buy_at: tb.last_at ?? null, window_days: typeof tb.window_days === "number" ? tb.window_days : null,
      last_quote_check: null, label,
    };
  }
  const observed = !!(curated || dom?.catalog?.entries?.length || exact?.observed || dom?.observed);
  return { scope: observed ? "url" : "not_observed", ...empty, label };
}

/** Delivery counts from a purchases list (fallback when the view carries no test_buys aggregate). */
function countsFromPurchases(ps: unknown) {
  const xs = Array.isArray(ps) ? ps : [];
  let delivered = 0, not_delivered = 0, inconclusive = 0;
  for (const p of xs as any[]) {
    const s = p?.delivery ?? (p?.data_returned === true ? "delivered" : p?.data_returned === false ? "not_delivered" : "inconclusive");
    if (s === "delivered") delivered++; else if (s === "not_delivered") not_delivered++; else inconclusive++;
  }
  const last = [...(xs as any[])].sort((a, b) => Date.parse(b?.at) - Date.parse(a?.at))[0];
  return { count: xs.length, delivered, not_delivered, inconclusive, last_at: last?.at ?? null };
}

/** The one line. Plain ASCII, no instructions, bad results stated as plainly as good ones. */
export function summaryLine(f: SummaryFacts): string {
  if (f.scope === "lumi_itself") return "This is Lumi's own API; Lumi does not test-buy or rate itself.";
  if (f.scope === "not_observed") return "Lumi has no record of this seller: it is not in the x402 catalog Lumi reads and Lumi has not test-bought it. No record is not a negative finding.";
  const noun = f.scope === "listing" ? "listing" : f.scope === "seller" ? "seller" : "URL";
  const result = f.label ? ` Lumi's check result: ${LABELS[f.label]}.` : "";
  if (f.test_buys === 0) {
    let s = `Lumi has not test-bought this ${noun} yet${f.window_days ? ` (none in the last ${f.window_days} days)` : ""}.`;
    const qd = summaryDate(f.last_quote_check?.at);
    if (qd && f.last_quote_check) {
      s += f.last_quote_check.valid_quote === true
        ? ` Its last free quote check (no payment) on ${qd} got a valid x402 price quote.`
        : f.last_quote_check.valid_quote === false
        ? ` Its last free quote check (no payment) on ${qd} did not get a valid x402 price quote.`
        : ` Lumi last sent it a free quote check (no payment) on ${qd}.`;
    }
    return `${s}${result} Not a guarantee.`;
  }
  const parts = [`${f.delivered} delivered`];
  if (f.not_delivered > 0) parts.push(`${f.not_delivered} did not deliver`);
  if (f.inconclusive > 0) parts.push(`${f.inconclusive} inconclusive (not counted)`);
  const d = summaryDate(f.last_test_buy_at);
  const win = f.window_days ? ` in the last ${f.window_days} days` : "";
  return `Lumi test-bought this ${noun} ${times(f.test_buys)}${win}; ${parts.join(", ")}${d ? ` (last test-buy ${d})` : ""}.${result} Not a guarantee.`;
}

/** Both fields together, as attached to responses. */
export function summaryFor(exact: any, dom: any, label: Label | null) {
  const facts = summaryFactsFrom(exact, dom, label);
  return { summary: summaryLine(facts), summary_facts: { ...facts, version: SUMMARY_VERSION } };
}
