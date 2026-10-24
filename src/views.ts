/**
 * Shapes Lumi's raw site JSON into stable, documented API payloads.
 * Everything is whitelisted field-by-field (nothing is passed through blindly)
 * and then run through the privacy sanitizer.
 */

import type { Json } from "./data";
import { sanitize, splitSentences } from "./sanitize";
import { MARKET_IDEAS_KINDS, MARKET_IDEAS_NAME, MARKET_IDEAS_NOTICE, TRUST_DISCLAIMER } from "./lines";

export const SOURCE = "lumitrades.io";
export const DISCLAIMER =
  "Analytics and education only. Not financial advice. Trade ideas are hypothetical paper trades for illustration, " +
  "not orders or signals to copy. Crypto is volatile and leverage can magnify losses. Do your own research.";

export interface CoinRef {
  id: string;
  symbol: string;
  name: string;
  group: string;
}

/** Static fallback so coin validation still works if coins.json is unreachable. */
export const FALLBACK_COINS: CoinRef[] = [
  ["hedera-hashgraph", "HBAR", "Hedera", "watchlist"],
  ["stellar", "XLM", "Stellar", "watchlist"],
  ["ripple", "XRP", "XRP", "watchlist"],
  ["zebec-network", "ZBCN", "Zebec Network", "watchlist"],
  ["axelar", "AXL", "Axelar", "watchlist"],
  ["xdce-crowd-sale", "XDC", "XDC Network", "watchlist"],
  ["bitcoin", "BTC", "Bitcoin", "majors"],
  ["ethereum", "ETH", "Ethereum", "majors"],
  ["solana", "SOL", "Solana", "majors"],
  ["dogecoin", "DOGE", "Dogecoin", "majors"],
  ["cardano", "ADA", "Cardano", "majors"],
  ["chainlink", "LINK", "Chainlink", "majors"],
  ["sui", "SUI", "Sui", "majors"],
].map(([id, symbol, name, group]) => ({ id, symbol, name, group }));

export function coinList(coinsJson: Json | undefined): CoinRef[] {
  const list = coinsJson?.coins;
  if (!Array.isArray(list) || list.length === 0) return FALLBACK_COINS;
  return list
    .filter((c: Json) => c && typeof c.id === "string" && typeof c.symbol === "string")
    .map((c: Json) => ({ id: c.id, symbol: String(c.symbol).toUpperCase(), name: String(c.name ?? c.symbol), group: String(c.group ?? "") }));
}

/** Accepts a ticker (XRP) or a CoinGecko id (ripple), case-insensitive. */
export function resolveCoin(coins: CoinRef[], raw: string): CoinRef | undefined {
  const q = decodeURIComponent(raw).trim().toLowerCase();
  return coins.find((c) => c.symbol.toLowerCase() === q || c.id === q);
}

export function envelope(kind: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    kind,
    timestamp: new Date().toISOString(),
    source: SOURCE,
    ...sanitize(data),
    ...extra,
    // Lumi Market Ideas (signal, lite, scan, levels, slate, trades): additive, backward-compatible label + notice.
    ...(MARKET_IDEAS_KINDS.includes(kind) ? { product_line: MARKET_IDEAS_NAME, notice: MARKET_IDEAS_NOTICE } : {}),
    // Trust responses carry the trust disclaimer (no trade-idea wording).
    disclaimer: kind === "trust_check" ? TRUST_DISCLAIMER : DISCLAIMER,
  };
}

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function priceBlock(prices: Json, id: string) {
  const a = prices?.assets?.[id];
  if (!a) return null;
  return {
    usd: num(a.price),
    change_24h_pct: num(a.change_24h),
    change_7d_pct: num(a.change_7d),
    change_30d_pct: num(a.change_30d),
    high_24h: num(a.high_24h),
    low_24h: num(a.low_24h),
    market_cap_rank: num(a.market_cap_rank),
    volume_24h_usd: num(a.volume_24h),
    as_of: a.last_updated ?? prices?.updated_utc ?? null,
  };
}

function indicatorSummary(ind: Json) {
  if (!ind || typeof ind !== "object") return null;
  const pick = (k: string, fields: string[]) => {
    const x = ind[k];
    if (!x) return undefined;
    return Object.fromEntries(fields.filter((f) => x[f] !== undefined).map((f) => [f, x[f]]));
  };
  return {
    rsi: pick("rsi", ["value", "state", "points"]),
    macd: pick("macd", ["hist", "cross", "state", "points"]),
    ema: pick("ema", ["ema20", "ema50", "ema200", "state", "points"]),
    ema200: pick("ema200", ["ema200", "state", "points"]),
    bollinger: pick("bb", ["pct_b", "bandwidth_pct", "squeeze", "state", "points"]),
    stoch_rsi: pick("stochrsi", ["k", "d", "state", "points"]),
    volume: pick("volume", ["ratio", "state", "points"]),
  };
}

export function signalView(coin: CoinRef, signals: Json, prices: Json) {
  const s = signals?.coins?.[coin.id];
  if (!s) return null;
  const tfs: Record<string, unknown> = {};
  for (const tf of ["1h", "4h", "1d"]) {
    const t = s.timeframes?.[tf];
    if (!t) continue;
    tfs[tf] = {
      label: t.label ?? null,
      score: num(t.score),
      points: num(t.points),
      max_points: num(t.max_points),
      candle_time: t.candle_time ?? null,
      indicators: indicatorSummary(t.indicators),
    };
  }
  return envelope("signal", {
    coin: coin,
    label: s.label ?? null,
    score: num(s.score),
    price: priceBlock(prices, coin.id) ?? { usd: num(s.price) },
    timeframes: tfs,
    method: {
      timeframe_weights: signals?.method?.timeframe_weights ?? null,
      labels: signals?.method?.labels ?? null,
      points: signals?.method?.points ?? null,
      note: "Mechanical indicator readings from exchange candles; not predictions.",
    },
    generated_utc: signals?.generated_utc ?? null,
  });
}

/** Signal computed live in the Worker (src/live.ts): same shape as signalView, fresher (1h/4h about every 13 min). */
export function liveSignalView(coin: CoinRef, row: Json) {
  const tfs: Record<string, unknown> = {};
  for (const tf of ["1h", "4h", "1d"]) {
    const t = row?.timeframes?.[tf];
    if (!t) continue;
    tfs[tf] = { label: t.label ?? null, score: num(t.score), points: num(t.points), max_points: num(t.max_points), candle_time: t.candle_time ?? null, indicators: indicatorSummary(t.indicators) };
  }
  const p = row?.price ?? {};
  return envelope("signal", {
    coin,
    label: row?.label ?? null,
    score: num(row?.score),
    price: { usd: num(p.usd), change_24h_pct: num(p.change_24h_pct), high_24h: num(p.high_24h), low_24h: num(p.low_24h), volume_24h_usd: num(p.volume_24h_usd), as_of: new Date(row.computed_at).toISOString() },
    timeframes: tfs,
    method: {
      timeframe_weights: { "1h": 0.25, "4h": 0.35, "1d": 0.4 },
      labels: "score >= 0.5 Strong Buy; >= 0.15 Buy; > -0.15 Neutral; > -0.5 Sell; else Strong Sell",
      points: "RSI +-1/+-0.5, MACD hist +-1 (+-0.5 fresh cross), EMA stack +-1 (+-0.5 mixed), EMA200 +-1 (1d), Bollinger %B outside bands +-0.5, StochRSI turn +-0.5, volume >=1.5x avg +-0.5; score = points / max",
      note: "Mechanical indicator readings computed live from public exchange candles (1h refreshed about every 13 minutes; 4h built from 1h; 1d every few hours); not predictions.",
    },
    computed: "live",
    generated_utc: new Date(row.computed_at).toISOString(),
  });
}

/** Label carried on 7-day scenario levels wherever they appear. */
export const SCENARIO_LABEL = "rule-based scenario levels, not forecasts";

export function levelsBlock(a: Json) {
  if (!a) return null;
  const scenarios = a.projection
    ? {
        label: SCENARIO_LABEL,
        horizon_days: num(a.projection.horizon_days),
        bull: num(a.projection.bull),
        base: num(a.projection.base),
        bear: num(a.projection.bear),
      }
    : null;
  return {
    bias: a.bias ?? null,
    support: Array.isArray(a.support) ? a.support.filter((x: unknown) => num(x) !== null) : [],
    resistance: Array.isArray(a.resistance) ? a.resistance.filter((x: unknown) => num(x) !== null) : [],
    // `scenarios` is the preferred name; `projection` is kept unchanged-in-shape for existing clients (same values, same label).
    scenarios,
    projection: scenarios ? { ...scenarios } : null,
    commentary: typeof a.commentary === "string" ? a.commentary : null,
    catalysts: Array.isArray(a.catalysts)
      ? a.catalysts.map((c: Json) => ({ date: c.date, kind: c.kind, text: c.text, source: c.source, url: c.url }))
      : [],
    sources: Array.isArray(a.sources) ? a.sources.map((s: Json) => ({ title: s.title, url: s.url })) : [],
  };
}

export function levelsView(coin: CoinRef, analysis: Json, prices: Json) {
  const a = analysis?.coins?.[coin.id];
  if (!a) return null;
  return envelope("levels", {
    coin,
    price: priceBlock(prices, coin.id),
    ...levelsBlock(a),
    analysis_as_of: analysis?.as_of ?? null,
    analysis_label: analysis?.label ?? null,
  });
}

export const TRADE_FIELDS = [
  "id", "direction", "market", "leverage", "conviction", "leverage_reason", "status",
  "entry", "planned_entry", "entry_zone", "stop", "targets", "targets_hit", "move_stop_to_be",
  "opened_at", "filled_at", "expiry", "fill_by", "expires", "closed_at", "exit_price",
  "pnl_pct", "unrealized_pnl_pct", "mark_price", "timeframe", "timeframe_note",
  "missed_it", "plan_type", "trigger", "parent_id", "reasoning", "cancel_reason",
] as const;

/** Outcome fields are never published: no win/loss track record anywhere in the API. */
const OUTCOME_FIELDS = new Set<string>(["exit_price", "pnl_pct", "targets_hit"]);
const ACTIVE = new Set(["open", "pending"]);

export function tradeView(t: Json, coins: CoinRef[]) {
  const coin = coins.find((c) => c.id === t.coin);
  const out: Record<string, unknown> = { coin: coin ? coin.symbol : t.coin };
  const active = ACTIVE.has(String(t.status));
  for (const f of TRADE_FIELDS) {
    if (t[f] === undefined || t[f] === null) continue;
    if (OUTCOME_FIELDS.has(f) || (!active && (f === "unrealized_pnl_pct" || f === "mark_price"))) continue;
    out[f] = t[f];
  }
  // Outcome statuses are normalised so a closed idea never reads as a win or a loss.
  if (!active && t.status !== "cancelled") out.status = "closed";
  return out;
}

export function slateView(trades: Json, coins: CoinRef[]) {
  const all: Json[] = Array.isArray(trades?.trades) ? trades.trades : [];
  const active = all.filter((t) => ACTIVE.has(String(t.status)));
  const noSetup: Record<string, string> = {};
  for (const [id, entry] of Object.entries<Json>(trades?.slate?.coins ?? {})) {
    if (!entry?.trade_id && typeof entry?.note === "string") {
      const c = coins.find((x) => x.id === id);
      noSetup[c ? c.symbol : id] = entry.note;
    }
  }
  return envelope("slate", {
    slate_as_of: trades?.slate?.as_of ?? null,
    rules: trades?.slate?.rules ?? null,
    ideas: active.map((t) => tradeView(t, coins)),
    no_setup_notes: noSetup,
    evaluated_utc: trades?.tracked_utc ?? trades?.evaluated_utc ?? null,
  });
}

const MACRO_TERMS = /\b(yen|usd\/jpy|jpy|boj|bank of japan|nikkei|carry[- ]trade)\b/i;

/** Pull the yen / Japan macro sentences out of the BTC backdrop commentary. */
export function yenNote(commentary: unknown): string | null {
  if (typeof commentary !== "string") return null;
  const picked = splitSentences(commentary).filter((s) => MACRO_TERMS.test(s));
  return picked.length ? picked.join(" ") : null;
}

export function marketView(analysis: Json, signals: Json, prices: Json, context: Json, coins: CoinRef[]) {
  const backdrop = analysis?.backdrop ?? analysis?.coins?.bitcoin ?? null;
  const btc = coins.find((c) => c.id === "bitcoin") ?? FALLBACK_COINS[6];
  const btcSig = signals?.coins?.bitcoin;
  const labels: Record<string, number> = {};
  let up = 0;
  let down = 0;
  for (const c of coins) {
    const l = signals?.coins?.[c.id]?.label;
    if (l) labels[l] = (labels[l] ?? 0) + 1;
    const ch = num(prices?.assets?.[c.id]?.change_24h);
    if (ch !== null) ch >= 0 ? up++ : down++;
  }
  const g = context?.global ?? {};
  const fg = context?.fear_greed ?? {};
  const d = context?.derivatives ?? {};
  return envelope("market", {
    btc_backdrop: {
      coin: btc,
      price: priceBlock(prices, "bitcoin"),
      signal: btcSig
        ? {
            label: btcSig.label ?? null,
            score: num(btcSig.score),
            by_timeframe: Object.fromEntries(
              ["1h", "4h", "1d"].map((tf) => [tf, btcSig.timeframes?.[tf]?.label ?? null]),
            ),
          }
        : null,
      ...levelsBlock(backdrop),
    },
    macro: {
      yen_note: yenNote(backdrop?.commentary),
      total_mcap_usd: num(g.total_mcap_usd),
      mcap_change_24h_pct: num(g.mcap_change_24h_pct),
      btc_dominance_pct: num(g.btc_dominance_pct),
      eth_dominance_pct: num(g.eth_dominance_pct),
      fear_greed: fg.value !== undefined ? { value: num(fg.value), classification: fg.classification ?? null, previous: num(fg.previous) } : null,
      btc_perp: d.instrument
        ? { instrument: d.instrument, funding_rate_pct: num(d.funding_rate_pct), open_interest_usd: num(d.open_interest_usd) }
        : null,
      context_as_of: context?.generated_utc ?? null,
    },
    breadth: {
      coins_tracked: coins.length,
      up_24h: up,
      down_24h: down,
      signal_labels: labels,
    },
    analysis_as_of: analysis?.as_of ?? null,
  });
}
