/**
 * Composite products built only from data Lumi already publishes on lumitrades.io/data:
 *   /v1/macro/yen  USD/JPY + Nikkei 225 and a rule-based yen risk level against a 155 reference
 *   /v1/sentiment  Fear & Greed (CoinMarketCap) + BTC perp funding/OI + market-wide breadth
 *   /v1/events     sourced, dated macro/crypto events and per-coin catalysts
 * (The daily market brief, /v1/brief, was retired on 2026-10-25.)
 * Rules: whitelist fields, omit anything that is missing (never invent), run through the privacy filter (envelope -> sanitize),
 * keep the disclaimer.
 */

import type { Json } from "./data";
import { isSignedObject } from "./signed";
import {
  FALLBACK_COINS, TRADING_WORDS, envelope, isExcludedCoin, num, priceBlock, yenNote, type CoinRef,
} from "./views";
import { neutralText } from "./bias";

/** USD/JPY reference line Lumi's macro watch measures against. */
export const YEN_KEY_LEVEL = 155;
const DAY = 86_400_000;

/** Drop null/undefined/empty-array/empty-object values (recursively) so missing data is omitted, not faked. */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact).filter((x) => x !== null && x !== undefined) as T;
  if (isSignedObject(v)) return v; // H-2: never drop nulls (e.g. inconclusive delivery.data_returned) inside a signed receipt
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const c = compact(x);
      if (c === null || c === undefined) continue;
      if (Array.isArray(c) && c.length === 0) continue;
      if (typeof c === "object" && !Array.isArray(c) && Object.keys(c as object).length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return v;
}

const round = (v: number | null, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const sym = (coins: CoinRef[], id: string) => coins.find((c) => c.id === id)?.symbol ?? id;
const isoOk = (s: unknown) => typeof s === "string" && !Number.isNaN(Date.parse(s));

// ---------------------------------------------------------------- sentiment

export function fearGreedBlock(context: Json) {
  const fg = context?.fear_greed;
  const v = num(fg?.value);
  if (v === null) return null;
  const prev = num(fg.previous);
  return {
    value: v,
    classification: fg.classification ?? null,
    previous: prev,
    change: prev === null ? null : v - prev,
    source: fg.source ?? null,
    as_of: fg.timestamp ?? null,
    scale:
      fg.source === "CoinMarketCap"
        ? "CoinMarketCap bands: 0-20 Extreme fear, 20-40 Fear, 40-60 Neutral, 60-80 Greed, 80-100 Extreme greed"
        : null,
  };
}

/** Neutral size band of a perp funding rate (percent per funding interval). Describes the number only, no market call. */
export function fundingRead(ratePct: number | null): string | null {
  if (ratePct === null) return null;
  if (ratePct >= 0.03) return "high positive: well above the usual 0.01% baseline";
  if (ratePct >= 0.01) return "positive: around the usual 0.01% baseline";
  if (ratePct > -0.005) return "near zero: below the usual 0.01% baseline";
  return "negative: perpetual below its index";
}

function derivativesBlock(context: Json) {
  const d = context?.derivatives;
  if (!d?.instrument) return null;
  const rate = num(d.funding_rate_pct);
  return {
    instrument: d.instrument,
    funding_rate_pct: rate === null ? null : round(rate, 5),
    funding_read: fundingRead(rate),
    next_funding_time: d.next_funding_time ?? null,
    open_interest_btc: round(num(d.open_interest_btc), 2),
    open_interest_usd: round(num(d.open_interest_usd), 0),
  };
}

function globalBlock(context: Json) {
  const g = context?.global;
  if (!g || g.error) return null;
  return {
    total_mcap_usd: round(num(g.total_mcap_usd), 0),
    total_volume_usd: round(num(g.total_volume_usd), 0),
    mcap_change_24h_pct: round(num(g.mcap_change_24h_pct)),
    btc_dominance_pct: round(num(g.btc_dominance_pct)),
    eth_dominance_pct: round(num(g.eth_dominance_pct)),
  };
}

function breadthBlock(prices: Json, coins: CoinRef[]) {
  let up = 0;
  let down = 0;
  const changes: number[] = [];
  for (const c of coins) {
    const ch = num(prices?.assets?.[c.id]?.change_24h);
    if (ch !== null) {
      changes.push(ch);
      ch >= 0 ? up++ : down++;
    }
  }
  return {
    coins_tracked: coins.length,
    up_24h: up,
    down_24h: down,
    avg_change_24h_pct: changes.length ? round(changes.reduce((a, b) => a + b, 0) / changes.length) : null,
  };
}

export function sentimentView(context: Json, prices: Json, coins: CoinRef[]) {
  const fg = fearGreedBlock(context);
  const der = derivativesBlock(context);
  const glob = globalBlock(context);
  const br = breadthBlock(prices, coins);
  const parts: string[] = [];
  if (fg) parts.push(`Fear & Greed ${fg.value} (${fg.classification}${fg.previous !== null ? `, ${fg.change! >= 0 ? "up" : "down"} from ${fg.previous}` : ""}, ${fg.source})`);
  if (der?.funding_rate_pct !== null && der?.funding_rate_pct !== undefined) parts.push(`BTC perp funding ${der.funding_rate_pct.toFixed(4)}% (${der.funding_read!.split(":")[0]})`);
  if (glob?.mcap_change_24h_pct !== null && glob?.mcap_change_24h_pct !== undefined) parts.push(`total crypto cap ${glob.mcap_change_24h_pct >= 0 ? "+" : ""}${glob.mcap_change_24h_pct}% in 24h`);
  if (br.up_24h + br.down_24h > 0) parts.push(`${br.up_24h} of ${br.up_24h + br.down_24h} tracked coins up on the day`);
  return envelope("sentiment", compact({
    summary: parts.length ? parts.join("; ") + "." : null,
    fear_greed: fg,
    derivatives: der,
    global: glob,
    breadth: br,
    context_as_of: context?.generated_utc ?? null,
    method: "Fear & Greed is CoinMarketCap's index (alternative.me only as a fallback, labelled in `source`). Funding/OI: OKX public API. Global: CoinGecko. Breadth: 24h price change across Lumi's tracked coins. Market data only.",
  }));
}

// ---------------------------------------------------------------- yen

function quoteBlock(q: Json) {
  if (!q || q.error || num(q.price) === null) return null;
  const closes: number[] = Array.isArray(q.closes_5d) ? q.closes_5d.filter((x: unknown) => num(x) !== null) : [];
  return {
    name: q.name ?? null,
    price: q.price,
    change_pct: round(num(q.change_pct)),
    change_5d_pct: closes.length >= 2 ? round((q.price / closes[0] - 1) * 100) : null,
    day_high: num(q.day_high),
    day_low: num(q.day_low),
    week52_high: num(q.week52_high),
    week52_low: num(q.week52_low),
    closes_5d: closes.length ? closes : null,
    as_of: q.as_of ?? null,
    source: q.source ?? null,
  };
}

/** Quotes older than 4 days (a long weekend for FX/Tokyo) are treated as missing, never served as current. */
function freshQuote(q: Json, now: number) {
  return q && typeof q.as_of === "string" && now - Date.parse(q.as_of) <= 4 * DAY ? q : null;
}

const JP = /\b(japan|japanese|boj|bank of japan|yen|jpy|nikkei|tokyo)\b/i;

/** Rule-based yen macro risk level against the 155 USD/JPY reference. Returns null without a USD/JPY quote. */
export function yenRisk(usdjpy: ReturnType<typeof quoteBlock>, nikkei: ReturnType<typeof quoteBlock>) {
  if (!usdjpy) return null;
  const px = usdjpy.price as number;
  const dist = round((px / YEN_KEY_LEVEL - 1) * 100)!;
  const d1 = usdjpy.change_pct;
  const d5 = usdjpy.change_5d_pct;
  const nk = nikkei?.change_pct ?? null;
  const why: string[] = [];
  let level: "low" | "watch" | "elevated" = "low";
  const bump = (to: "watch" | "elevated", reason: string) => {
    why.push(reason);
    if (to === "elevated" || level === "low") level = to;
  };
  if (px <= YEN_KEY_LEVEL) bump("elevated", `USD/JPY ${px} is at/below the ${YEN_KEY_LEVEL} reference`);
  else if (dist < 2) bump("watch", `USD/JPY ${px} is only ${dist}% above ${YEN_KEY_LEVEL}`);
  if (d1 !== null && d1 <= -1.5) bump("elevated", `yen rallied fast: USD/JPY ${d1}% on the day`);
  else if (d1 !== null && d1 <= -0.5) bump("watch", `yen strengthening: USD/JPY ${d1}% on the day`);
  if (d5 !== null && d5 <= -3) bump("elevated", `USD/JPY ${d5}% over 5 sessions`);
  if (nk !== null && nk <= -4) bump("elevated", `Nikkei ${nk}% on the day`);
  else if (nk !== null && nk <= -2) bump("watch", `Nikkei ${nk}% on the day (risk-off in Japan)`);
  if (!why.length) why.push(`USD/JPY ${px} is ${dist}% above ${YEN_KEY_LEVEL} with no fast yen move`);
  return {
    level,
    reference_level: YEN_KEY_LEVEL,
    distance_to_reference_pct: dist,
    reasons: why,
    rules:
      `elevated: USD/JPY <= ${YEN_KEY_LEVEL}, or <= -1.5% in a day, or <= -3% in 5 sessions, or Nikkei <= -4%; ` +
      `watch: within 2% of ${YEN_KEY_LEVEL}, or <= -0.5% in a day, or Nikkei <= -2%; otherwise low.`,
  };
}

export function yenView(context: Json, analysis: Json, events: Json, prices: Json, now: number) {
  const usdjpy = quoteBlock(freshQuote(context?.yen?.usd_jpy, now));
  const nikkei = quoteBlock(freshQuote(context?.yen?.nikkei, now));
  if (!usdjpy && !nikkei) return null;
  const backdrop = analysis?.backdrop ?? analysis?.coins?.bitcoin ?? null;
  const upcoming = [
    ...eventRows(events, now).filter((e) => e.at_utc >= new Date(now).toISOString() && JP.test(`${e.title} ${e.why ?? ""}`)),
    ...catalystRows(analysis, [], now).filter((c) => JP.test(c.text ?? "")).map((c) => ({ date: c.date, title: c.text, source: c.source, url: c.url })),
  ];
  const btc = priceBlock(prices, "bitcoin");
  return envelope("macro_yen", compact({
    usd_jpy: usdjpy,
    nikkei_225: nikkei,
    yen_risk: yenRisk(usdjpy, nikkei),
    lumi_note: yenNote(backdrop?.commentary),
    btc: btc ? { usd: btc.usd, change_24h_pct: round(btc.change_24h_pct) } : null,
    japan_events: dedupe(upcoming),
    sources: Array.isArray(backdrop?.sources)
      ? backdrop.sources.filter((s: Json) => JP.test(String(s?.title ?? ""))).map((s: Json) => ({ title: s.title, url: s.url }))
      : null,
    why_it_matters:
      "Fast yen strength (falling USD/JPY) has coincided with broad risk-asset sell-offs; in Aug 2024 USD/JPY fell from roughly 161 " +
      "to 142 in a few weeks while crypto dropped sharply.",
    context_as_of: context?.generated_utc ?? null,
  }));
}

// ---------------------------------------------------------------- events

interface EventRow { at_utc: string; at_ct?: string; title: string; why?: string; source?: string; url?: string; url2?: string }

export function eventRows(events: Json, now: number): EventRow[] {
  const rows: Json[] = Array.isArray(events?.events) ? events.events : [];
  return rows
    .filter((e) => isoOk(e?.at_utc) && typeof e.title === "string" && (e.source || e.url))
    .filter((e) => Date.parse(e.at_utc) >= now - DAY)
    .map((e) => ({ at_utc: e.at_utc, at_ct: e.at_ct, title: e.title, why: e.why, source: e.source, url: e.url, url2: e.url2 }))
    .sort((a, b) => a.at_utc.localeCompare(b.at_utc));
}

interface CatalystRow { date: string; coin?: string; text: string; source?: string; url?: string }

export function catalystRows(analysis: Json, coins: CoinRef[], now: number): CatalystRow[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const out: CatalystRow[] = [];
  const add = (list: Json, coin?: string) => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (c?.kind !== "event" || typeof c.date !== "string" || c.date < today || typeof c.text !== "string") continue;
      if (!(c.source || c.url)) continue;
      const text = neutralText(c.text);
      if (!text || TRADING_WORDS.test(text)) continue;
      out.push({ date: c.date, coin, text, source: c.source, url: c.url });
    }
  };
  add(analysis?.backdrop?.catalysts, "MARKET");
  for (const [id, a] of Object.entries<Json>(analysis?.coins ?? {})) {
    if (id === analysis?.backdrop?.coin) continue; // backdrop already covers BTC's macro events
    if (isExcludedCoin({ id })) continue;
    add(a?.catalysts, sym(coins.length ? coins : FALLBACK_COINS, id));
  }
  return dedupe(out).sort((a, b) => a.date.localeCompare(b.date));
}

function dedupe<T extends { title?: string; text?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = String(r.title ?? r.text ?? "").toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function eventsView(events: Json, analysis: Json, coins: CoinRef[], now: number) {
  const rows = eventRows(events, now);
  const nowIso = new Date(now).toISOString();
  const upcoming = rows.filter((e) => e.at_utc >= nowIso);
  const recent = rows.filter((e) => e.at_utc < nowIso).reverse();
  const catalysts = catalystRows(analysis, coins, now);
  if (!upcoming.length && !recent.length && !catalysts.length) return null;
  return envelope("events", compact({
    next: upcoming[0] ?? null,
    upcoming_timed: upcoming,
    recent_24h: recent,
    upcoming_by_date: catalysts,
    note:
      "upcoming_timed: scheduled releases/decisions with exact times (UTC + US Central). upcoming_by_date: dated macro and per-coin " +
      "catalysts from Lumi's analysis (coin MARKET = macro backdrop). Every row carries its source; dates can move, so check the source.",
    events_as_of: events?.generated_utc ?? null,
    analysis_as_of: analysis?.as_of ?? null,
  }));
}
