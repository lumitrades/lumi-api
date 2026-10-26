/**
 * Which test-buys count (adopted badge rules, 2026-10-25). Pure: no storage, no clock.
 *
 * - Seller-paid runs (Watch / Pro / packs / legacy plans) and Lumi's own baseline buys are pooled and counted the same way.
 * - At most ONE counted test-buy per endpoint per UTC day: whichever came first (Lumi's baseline buy wins a tie). Later
 *   runs that day are kept and published as history, flagged counted:false, but never move the badge.
 * - Failures count exactly like successes: a counted failure is the latest counted result until a later counted buy.
 * - Lumi-side inconclusive baseline buys (Lumi never saw a response) and unpaid quote-only / skipped runs are not test-buys.
 *
 * Because a paid run can only take the single daily slot a baseline buy would otherwise take, and a baseline buy that came
 * first always wins, paying cannot add counted buys beyond what one baseline buy a day would give. Lumi's trust score and
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
  not_counted_reason?: "lumi_baseline_buy_first" | "earlier_buy_same_day";
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
  const first = new Map<string, CountedBuy>();
  for (const x of mine) {
    const k = `${endpointKey(x.endpoint)} ${x.day}`;
    const f = first.get(k);
    if (!f) { x.counted = true; first.set(k, x); continue; }
    x.not_counted_reason = f.source === "lumi_baseline" ? "lumi_baseline_buy_first" : "earlier_buy_same_day";
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
