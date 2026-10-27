/**
 * Which test-buys count (adopted badge rules, 2026-10-25). Pure: no storage, no clock.
 *
 * - Seller-paid runs (Watch / Pro / packs / legacy plans) and Lumi's own baseline buys are pooled and counted the same way.
 * - At most ONE counted test-buy per endpoint per UTC day. If ANY buy that day failed (Lumi's baseline buy or a seller-paid
 *   buy), the day's counted result is the first failure of that day; otherwise it is the first success (Lumi's baseline
 *   buy wins an exact tie). A failure later in the day therefore removes the badge at once, and extra successes never add
 *   anything: they are kept and published as history, flagged counted:false, but never move the badge.
 * - Failures count exactly like successes: a counted failure is the latest counted result until a later day's counted buy.
 * - Inconclusive baseline buys (Lumi-side: Lumi never saw a response; or an empty result for Lumi's test query, or an error caused by Lumi's own test input) and unpaid
 *   quote-only / skipped runs are not test-buys.
 *
 * Because a paid run can only take the single daily slot a baseline buy would otherwise take, a paid success can never
 * replace or bury a failure the same day, and paying cannot add counted buys beyond what one baseline buy a day would give. Lumi's trust score and
 * the /v1/badge "Tested by Lumi" badge do not read monitoring runs at all (see MONITOR_SAFEGUARDS).
 */
import type { RunRow } from "./store";
import type { BuyRow } from "../trust/catalog";
import { deliveryState } from "../trust/delivery";

export const COUNTING = { perEndpointPerUtcDay: 1, badgeLapseDays: 30 } as const;
export const BADGE_LAPSE_MS = COUNTING.badgeLapseDays * 86_400_000;

export type CountSource = "seller_paid" | "lumi_baseline";
export interface CountedBuy {
  endpoint: string;
  ts: number;
  day: string;
  delivered: boolean;
  source: CountSource;
  counted: boolean;
  /** Why a buy is not counted (counted:false only). */
  not_counted_reason?: "failure_same_day" | "lumi_baseline_buy_first" | "earlier_buy_same_day";
  run?: RunRow;
}

/** Normalised endpoint key (case-insensitive scheme/host, no trailing slash) so a catalog resource matches an enrolled URL. */
export function endpointKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return u.replace(/\/+$/, "");
  }
}

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** A monitoring run that is a test (a paid buy, or a failed attempt to get a quote): not skipped, not quote-only. */
export const isTestRun = (r: Pick<RunRow, "outcome">) => r.outcome !== "skipped" && r.outcome !== "quote_only";

/**
 * Pool seller-paid runs and Lumi baseline buys, newest first, each flagged counted / not counted.
 * Only buys on `endpoints` are returned (when given).
 */
export function countBuys(runs: RunRow[], baseline: BuyRow[], endpoints?: string[]): CountedBuy[] {
  const want = endpoints ? new Set(endpoints.map(endpointKey)) : null;
  const all: CountedBuy[] = [];
  for (const r of runs) {
    if (!isTestRun(r)) continue;
    all.push({ endpoint: r.endpoint, ts: r.ts, day: utcDay(r.ts), delivered: r.outcome === "delivered", source: "seller_paid", counted: false, run: r });
  }
  for (const b of baseline) {
    const st = deliveryState(b);
    if (st === "inconclusive") continue;
    all.push({ endpoint: b.resource, ts: b.ts, day: utcDay(b.ts), delivered: st === "delivered", source: "lumi_baseline", counted: false });
  }
  const mine = want ? all.filter((x) => want.has(endpointKey(x.endpoint))) : all;
  // Oldest first; on an exact tie Lumi's baseline buy comes first.
  mine.sort((a, b) => a.ts - b.ts || (a.source === b.source ? 0 : a.source === "lumi_baseline" ? -1 : 1));
  // Group per endpoint per UTC day; the day's counted buy is its first failure if any buy failed, else its first buy.
  const days = new Map<string, CountedBuy[]>();
  for (const x of mine) {
    const k = `${endpointKey(x.endpoint)} ${x.day}`;
    const g = days.get(k);
    if (g) g.push(x); else days.set(k, [x]);
  }
  for (const g of days.values()) {
    const pick = g.find((x) => !x.delivered) ?? g[0];
    pick.counted = true;
    for (const x of g) {
      if (x === pick) continue;
      x.not_counted_reason = !pick.delivered && x.delivered ? "failure_same_day" : pick.source === "lumi_baseline" ? "lumi_baseline_buy_first" : "earlier_buy_same_day";
    }
  }
  return mine.reverse();
}

/** Latest counted result per endpoint, and the last counted delivered buy (the date the badge shows). */
export function countedSummary(buys: CountedBuy[], endpoints: string[]) {
  const counted = buys.filter((b) => b.counted); // newest first
  const latest = endpoints.map((u) => counted.find((b) => endpointKey(b.endpoint) === endpointKey(u)) ?? null);
  const lastDelivered = counted.find((b) => b.delivered)?.ts ?? null;
  return { latest, lastDelivered, counted: counted.length };
}

/** Public wording of the counting rules (seller page, /v1/badge, OpenAPI, llms.txt, skill.md). Must match countBuys + badgeStatus. */
export const COUNTING_TEXT = {
  rule: `At most ${COUNTING.perEndpointPerUtcDay} counted test-buy per endpoint per UTC day, from Lumi's own baseline buys and seller-paid buys (plan or pack) together. If any buy that day failed, the day counts as a failure (the first failure), even if it came after a success; otherwise the first success counts. Extra buys that day are shown as history with counted:false and never add anything, so paying cannot hide a failure or freshen the badge more than once a day.`,
  failures: "Failures are published and counted exactly like successes; the latest counted result per endpoint decides the badge.",
  dating: `The badge shows the date of the last delivered counted test-buy and lapses ${COUNTING.badgeLapseDays} days after it (sooner on tiers with a shorter window).`,
  score: "Paying never changes a score: Lumi's trust score and the earned 'Tested by Lumi' badge read only Lumi's own baseline buys, never seller-paid runs.",
};

/** One-sentence form of COUNTING_TEXT for endpoint lists. */
export const MONITORED_BADGE_SUMMARY = `one counted test-buy per endpoint per UTC day (any failure that day makes the day a failure); the latest counted result per endpoint decides, so a failure removes the badge; dated by the last delivered counted test-buy and gone ${COUNTING.badgeLapseDays} days after it (sooner on tiers with a shorter window); paying never changes a score`;
