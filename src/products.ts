/**
 * Composite products built only from data Lumi already publishes on lumitrades.io/data:
 *   /v1/brief      daily market brief (JSON + markdown): BTC, CoinMarketCap Fear & Greed, movers, key levels, yen, events, current paper-trade ideas, news
 *   /v1/macro/yen  USD/JPY + Nikkei 225 and a rule-based carry-trade risk read around the 155 line
 *   /v1/sentiment  Fear & Greed (CoinMarketCap) + BTC perp funding/OI + market-wide breadth
 *   /v1/events     sourced, dated macro/crypto events and per-coin catalysts
 * Rules: whitelist fields, omit anything that is missing (never invent), run through the privacy filter (envelope -> sanitize),
 * keep the disclaimer.
 */

import type { Json } from "./data";
import { isSignedObject } from "./signed";
import {
  DISCLAIMER, FALLBACK_COINS, envelope, levelsBlock, num, priceBlock, activeIdeas, yenNote, type CoinRef,
} from "./views";

/** Lumi's carry-trade line in the sand for USD/JPY (newsletter + analysis: "watching ~155"). */
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

/** Plain-English read of a perp funding rate (percent per funding interval). */
export function fundingRead(ratePct: number | null): string | null {
  if (ratePct === null) return null;
  if (ratePct >= 0.03) return "hot: longs pay a large premium (crowded long, squeeze risk to the downside)";
  if (ratePct >= 0.01) return "positive: longs pay the usual premium (mild long bias)";
  if (ratePct > -0.005) return "flat: below the usual 0.01% baseline, no strong leverage bias";
  return "negative: shorts pay longs (crowded short, squeeze risk to the upside)";
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

function breadthBlock(prices: Json, signals: Json, coins: CoinRef[]) {
  let up = 0;
  let down = 0;
  const changes: number[] = [];
  const labels: Record<string, number> = {};
  for (const c of coins) {
    const ch = num(prices?.assets?.[c.id]?.change_24h);
    if (ch !== null) {
      changes.push(ch);
      ch >= 0 ? up++ : down++;
    }
    const l = signals?.coins?.[c.id]?.label;
    if (l) labels[l] = (labels[l] ?? 0) + 1;
  }
  return {
    coins_tracked: coins.length,
    up_24h: up,
    down_24h: down,
    avg_change_24h_pct: changes.length ? round(changes.reduce((a, b) => a + b, 0) / changes.length) : null,
    signal_labels: labels,
  };
}

export function sentimentView(context: Json, prices: Json, signals: Json, coins: CoinRef[]) {
  const fg = fearGreedBlock(context);
  const der = derivativesBlock(context);
  const glob = globalBlock(context);
  const br = breadthBlock(prices, signals, coins);
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
    method: "Fear & Greed is CoinMarketCap's index (alternative.me only as a fallback, labelled in `source`). Funding/OI: OKX public API. Global: CoinGecko. Breadth: Lumi's 13 tracked coins.",
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

/** Rule-based carry-trade risk around Lumi's 155 USD/JPY line. Returns null without a USD/JPY quote. */
export function carryRisk(usdjpy: ReturnType<typeof quoteBlock>, nikkei: ReturnType<typeof quoteBlock>) {
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
  if (px <= YEN_KEY_LEVEL) bump("elevated", `USD/JPY ${px} is at/below the ${YEN_KEY_LEVEL} line`);
  else if (dist < 2) bump("watch", `USD/JPY ${px} is only ${dist}% above ${YEN_KEY_LEVEL}`);
  if (d1 !== null && d1 <= -1.5) bump("elevated", `yen rallied fast: USD/JPY ${d1}% on the day`);
  else if (d1 !== null && d1 <= -0.5) bump("watch", `yen strengthening: USD/JPY ${d1}% on the day`);
  if (d5 !== null && d5 <= -3) bump("elevated", `USD/JPY ${d5}% over 5 sessions`);
  if (nk !== null && nk <= -4) bump("elevated", `Nikkei ${nk}% on the day`);
  else if (nk !== null && nk <= -2) bump("watch", `Nikkei ${nk}% on the day (risk-off in Japan)`);
  if (!why.length) why.push(`USD/JPY ${px} is ${dist}% above ${YEN_KEY_LEVEL} with no fast yen move`);
  return {
    level,
    key_level: YEN_KEY_LEVEL,
    distance_to_key_level_pct: dist,
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
    carry_trade_risk: carryRisk(usdjpy, nikkei),
    lumi_note: yenNote(backdrop?.commentary),
    btc: btc ? { usd: btc.usd, change_24h_pct: round(btc.change_24h_pct) } : null,
    japan_events: dedupe(upcoming),
    sources: Array.isArray(backdrop?.sources)
      ? backdrop.sources.filter((s: Json) => JP.test(String(s?.title ?? ""))).map((s: Json) => ({ title: s.title, url: s.url }))
      : null,
    why_it_matters:
      "A stronger yen (falling USD/JPY) can force traders who borrowed cheap yen to buy risk assets to unwind; in Aug 2024 a fast yen rally " +
      "(roughly 161 to 142) triggered a carry-trade unwind and a sharp crypto sell-off.",
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
      out.push({ date: c.date, coin, text: c.text, source: c.source, url: c.url });
    }
  };
  add(analysis?.backdrop?.catalysts, "MARKET");
  for (const [id, a] of Object.entries<Json>(analysis?.coins ?? {})) {
    if (id === analysis?.backdrop?.coin) continue; // backdrop already covers BTC's macro events
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

// ---------------------------------------------------------------- brief

function movers(prices: Json, coins: CoinRef[]) {
  const rows = coins
    .map((c) => ({ coin: c.symbol, usd: num(prices?.assets?.[c.id]?.price), change_24h_pct: round(num(prices?.assets?.[c.id]?.change_24h)) }))
    .filter((r) => r.change_24h_pct !== null && r.usd !== null)
    .sort((a, b) => b.change_24h_pct! - a.change_24h_pct!);
  if (!rows.length) return null;
  return { top: rows.slice(0, 3), bottom: rows.slice(-3).reverse() };
}

function keyLevels(analysis: Json, prices: Json, coins: CoinRef[]) {
  const out: Record<string, unknown>[] = [];
  for (const c of coins) {
    const a = analysis?.coins?.[c.id];
    const px = num(prices?.assets?.[c.id]?.price);
    if (!a || px === null) continue;
    const sup = (Array.isArray(a.support) ? a.support : []).filter((x: unknown) => num(x) !== null && (x as number) <= px);
    const res = (Array.isArray(a.resistance) ? a.resistance : []).filter((x: unknown) => num(x) !== null && (x as number) >= px);
    out.push({
      coin: c.symbol,
      usd: px,
      bias: a.bias ?? null,
      nearest_support: sup.length ? Math.max(...sup) : null,
      nearest_resistance: res.length ? Math.min(...res) : null,
    });
  }
  return out;
}

const fresh = (date: unknown, now: number, days = 2) =>
  typeof date === "string" && !Number.isNaN(Date.parse(date)) && now - Date.parse(date) <= days * DAY;

export function briefView(d: { prices: Json; context: Json; analysis: Json; signals: Json; ideas: Json; events?: Json; brief?: Json }, coins: CoinRef[], now: number) {
  const btc = priceBlock(d.prices, "bitcoin");
  const backdrop = d.analysis?.backdrop ?? d.analysis?.coins?.bitcoin ?? null;
  const btcLv = levelsBlock(backdrop);
  const usdjpy = quoteBlock(freshQuote(d.context?.yen?.usd_jpy, now));
  const nikkei = quoteBlock(freshQuote(d.context?.yen?.nikkei, now));
  const tr: Json[] = activeIdeas(d.ideas);
  const nl = d.brief?.newsletter && fresh(d.brief.newsletter.date, now) ? d.brief.newsletter : null;
  const news = Array.isArray(d.brief?.news?.items) ? d.brief.news.items.filter((n: Json) => fresh(n.date, now) && n.source_url) : [];
  const nowIso = new Date(now).toISOString();
  const evs = eventRows(d.events, now).filter((e) => e.at_utc >= nowIso && Date.parse(e.at_utc) <= now + 2 * DAY);
  const cats = catalystRows(d.analysis, coins, now).filter((c) => Date.parse(c.date) <= now + 8 * DAY).slice(0, 6);

  const body = compact({
    date: nowIso.slice(0, 10),
    headline: nl?.subject ?? null,
    lumi_take: nl?.tldr ? (() => {
      const synced = btc ? syncBtcLede(String(nl.tldr), btc.usd, round(btc.change_24h_pct)) : { text: String(nl.tldr), changed: false };
      return { text: synced.text, from: `Trade with Lumi newsletter, ${nl.date}${synced.changed && btc?.as_of ? `; BTC figures updated to live data as of ${btc.as_of}` : ""}` };
    })() : null,
    bitcoin: btc
      ? {
          usd: btc.usd,
          change_24h_pct: round(btc.change_24h_pct),
          high_24h: btc.high_24h,
          low_24h: btc.low_24h,
          bias: btcLv?.bias ?? null,
          support: btcLv?.support ?? null,
          resistance: btcLv?.resistance ?? null,
          signal: d.signals?.coins?.bitcoin?.label ?? null,
          as_of: btc.as_of,
        }
      : null,
    sentiment: {
      fear_greed: fearGreedBlock(d.context),
      btc_funding: derivativesBlock(d.context),
      global: globalBlock(d.context),
    },
    movers_24h: movers(d.prices, coins),
    key_levels: keyLevels(d.analysis, d.prices, coins),
    yen: usdjpy || nikkei ? { usd_jpy: usdjpy?.price, usd_jpy_change_pct: usdjpy?.change_pct, nikkei: nikkei?.price, nikkei_change_pct: nikkei?.change_pct, carry_trade_risk: carryRisk(usdjpy, nikkei)?.level } : null,
    events_next_48h: evs.map((e) => ({ at_utc: e.at_utc, at_ct: e.at_ct, title: e.title, why: e.why, source: e.source, url: e.url })),
    coming_up: cats,
    paper_trades: {
      active: tr.map((t) =>
        compact({ id: t.id, coin: sym(coins, t.coin), direction: t.direction, leverage: t.leverage, status: t.status, entry: t.entry, entry_zone: t.entry_zone, stop: t.stop, targets: t.targets, timeframe: t.timeframe, expiry: t.expiry ?? t.fill_by })),
    },
    what_happened: nl?.what_happened ?? null,
    news: news.map((n: Json) => ({ date: n.date, headline: n.headline, summary: n.summary, coins: n.coins, source: n.source_name, url: n.source_url })),
    sources_as_of: { prices: d.prices?.updated_utc, context: d.context?.generated_utc, analysis: d.analysis?.as_of, ideas: d.ideas?.as_of, newsletter: nl?.date },
  });
  const env = envelope("brief", body as Record<string, unknown>);
  return { ...env, markdown: briefMarkdown(env as Json) };
}

/**
 * The newsletter take is written hours earlier; rewrite its Bitcoin price (and the 24h % right after it) with the live
 * numbers so the lede agrees with the structured bitcoin field and the Market section.
 */
export function syncBtcLede(text: string, usd: number | undefined | null, changePct: number | undefined | null): { text: string; changed: boolean } {
  if (typeof usd !== "number" || !isFinite(usd)) return { text, changed: false };
  let changed = false;
  const re = /\b(Bitcoin|BTC)\b([^$.;]{0,40}?)\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?(\s*\(\s*[+\-\u2212]?\d+(?:\.\d+)?%[^()]{0,24}\))?/;
  const out = text.replace(re, (_m, coin: string, mid: string, _n: string, _k: string, pctPart: string | undefined) => {
    changed = true;
    const price = `$${Math.round(usd).toLocaleString("en-US")}`;
    // a stale 24h % is dropped when there is no live one to replace it with
    const live = typeof changePct === "number" && isFinite(changePct) ? `${changePct >= 0 ? "+" : ""}${changePct}%` : null;
    let p = live ? ` (${live})` : "";
    // keep the writer's wording around the stale % ("(-2.1% in 24h)" becomes "(-3.93% in 24h)")
    if (live && pctPart) p = " " + pctPart.trim().replace(/[+\-\u2212]?\d+(?:\.\d+)?%/, live);
    return `${coin}${mid}${price}${p}`;
  });
  return { text: out, changed };
}

const fmtUsd = (v: number) => (v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}` : `$${Number(v.toPrecision(3))}`);
const pct = (v: number | undefined | null) => (v === null || v === undefined ? "" : `${v >= 0 ? "+" : ""}${v}%`);

/** Render the (already sanitized) brief as markdown. */
export function briefMarkdown(b: Json): string {
  const L: string[] = [];
  L.push(`# Lumi's market brief, ${b.date}`);
  if (b.headline) L.push("", `**${b.headline}**`);
  if (b.lumi_take) L.push("", `${b.lumi_take.text} _(${b.lumi_take.from})_`);
  L.push("", "## Market");
  if (b.bitcoin) {
    const x = b.bitcoin;
    L.push(`- **BTC ${fmtUsd(x.usd)}** (${pct(x.change_24h_pct)} 24h${x.low_24h && x.high_24h ? `, range ${fmtUsd(x.low_24h)}-${fmtUsd(x.high_24h)}` : ""})${x.signal ? `, signal: ${x.signal}` : ""}.`);
    if (x.support || x.resistance) L.push(`- BTC levels: support ${(x.support ?? []).map(fmtUsd).join(" / ") || "n/a"}; resistance ${(x.resistance ?? []).map(fmtUsd).join(" / ") || "n/a"}${x.bias ? `. Bias: ${x.bias}` : ""}.`);
  }
  const s = b.sentiment ?? {};
  if (s.fear_greed) L.push(`- **Fear & Greed ${s.fear_greed.value}** (${s.fear_greed.classification}${s.fear_greed.previous !== undefined ? `, yesterday ${s.fear_greed.previous}` : ""}; ${s.fear_greed.source}).`);
  if (s.global) L.push(`- Total crypto cap ${s.global.total_mcap_usd ? `$${(s.global.total_mcap_usd / 1e12).toFixed(2)}T` : ""} ${s.global.mcap_change_24h_pct !== undefined ? `(${pct(s.global.mcap_change_24h_pct)} 24h)` : ""}${s.global.btc_dominance_pct ? `, BTC dominance ${s.global.btc_dominance_pct}%` : ""}.`.replace(/\s+/g, " "));
  if (s.btc_funding?.funding_rate_pct !== undefined) L.push(`- BTC perp funding ${s.btc_funding.funding_rate_pct}% (${s.btc_funding.instrument}): ${s.btc_funding.funding_read}.`);
  if (b.movers_24h) {
    const m = (r: Json) => `${r.coin} ${pct(r.change_24h_pct)}`;
    L.push(`- Movers (24h, Lumi's 13 coins): best ${b.movers_24h.top.map(m).join(", ")}; worst ${b.movers_24h.bottom.map(m).join(", ")}.`);
  }
  if (b.yen) L.push(`- Yen watch: USD/JPY ${b.yen.usd_jpy ?? "n/a"} (${pct(b.yen.usd_jpy_change_pct)}), Nikkei ${b.yen.nikkei ?? "n/a"} (${pct(b.yen.nikkei_change_pct)}); carry-trade risk: ${b.yen.carry_trade_risk ?? "n/a"} (key level ${YEN_KEY_LEVEL}).`);
  if (Array.isArray(b.key_levels) && b.key_levels.length) {
    L.push("", "## Key levels");
    for (const k of b.key_levels) {
      L.push(`- **${k.coin} ${fmtUsd(k.usd)}**: support ${k.nearest_support !== undefined ? fmtUsd(k.nearest_support) : "n/a"}, resistance ${k.nearest_resistance !== undefined ? fmtUsd(k.nearest_resistance) : "n/a"}${k.bias ? ` (${k.bias})` : ""}`);
    }
  }
  if (b.what_happened?.length) {
    L.push("", "## What happened");
    for (const w of b.what_happened) L.push(`- ${w}`);
  }
  if (b.news?.length) {
    L.push("", "## News");
    for (const n of b.news) L.push(`- **${n.headline}** ${n.summary ?? ""} ([${n.source}](${n.url}), ${n.date})`);
  }
  if (b.events_next_48h?.length || b.coming_up?.length) {
    L.push("", "## Events");
    for (const e of b.events_next_48h ?? []) L.push(`- ${e.at_utc.replace("T", " ").slice(0, 16)} UTC: **${e.title}**${e.why ? `. ${e.why}` : ""}${e.url ? ` ([source](${e.url}))` : ""}`);
    for (const c of b.coming_up ?? []) L.push(`- ${c.date}${c.coin && c.coin !== "MARKET" ? ` [${c.coin}]` : ""}: ${c.text}${c.url ? ` ([source](${c.url}))` : ""}`);
  }
  const pt = b.paper_trades;
  if (pt) {
    L.push("", "## Lumi's current paper-trade ideas");
    for (const t of pt.active ?? []) {
      L.push(`- ${t.id} ${t.coin} ${t.direction}${t.leverage ? ` ${t.leverage}x` : ""} (${t.status})${t.entry !== undefined ? `: entry ${t.entry}` : ""}${t.stop !== undefined ? `, stop ${t.stop}` : ""}${t.targets ? `, targets ${t.targets.join(" / ")}` : ""}`);
    }
  }
  L.push("", `_Source: Lumi Trades (lumitrades.io), ${b.timestamp}. ${DISCLAIMER}_`, "");
  return L.join("\n");
}
