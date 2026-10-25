/**
 * Shapes Lumi's raw site JSON into stable, documented API payloads.
 * Everything is whitelisted field-by-field (nothing is passed through blindly)
 * and then run through the privacy sanitizer.
 */

import type { Json } from "./data";
import { sanitize, splitSentences } from "./sanitize";
import { TRUST_DISCLAIMER } from "./lines";
import { neutralText, neutralWords } from "./bias";

export const SOURCE = "lumitrades.io";
export const DISCLAIMER =
  "Market data and information only. Not financial advice and not a recommendation about any asset. Crypto is volatile. Do your own research.";

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
  ["dogecoin", "DOGE", "Dogecoin", "majors"],
  ["cardano", "ADA", "Cardano", "majors"],
  ["chainlink", "LINK", "Chainlink", "majors"],
  ["sui", "SUI", "Sui", "majors"],
].map(([id, symbol, name, group]) => ({ id, symbol, name, group }));

/** Coins never shown in public output (no Solana). */
export const EXCLUDED_COIN_IDS = new Set(["solana"]);
export const EXCLUDED_SYMBOLS = new Set(["SOL"]);
export const isExcludedCoin = (c: { id?: unknown; symbol?: unknown }) =>
  EXCLUDED_COIN_IDS.has(String(c?.id ?? "")) || EXCLUDED_SYMBOLS.has(String(c?.symbol ?? "").toUpperCase());

export function coinList(coinsJson: Json | undefined): CoinRef[] {
  const list = coinsJson?.coins;
  if (!Array.isArray(list) || list.length === 0) return FALLBACK_COINS;
  return list
    .filter((c: Json) => c && typeof c.id === "string" && typeof c.symbol === "string" && !isExcludedCoin(c))
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

const MACRO_TERMS = /\b(yen|usd\/jpy|jpy|boj|bank of japan|nikkei)\b/i;
/** Sentences with trading or chart-level wording are never published (2026-10-25). */
export const TRADING_WORDS =
  /\b(trades?|trader?s?|trading|carry[- ]?trade|longs?|shorts?|leverag\w*|support|resistance|bullish|bearish|bias|entry|entries|stops?|stop[- ]loss|targets?|setups?|breakouts?|breakdowns?|buy|sell|squeeze|levels?)\b/i;

/** Pull the yen / Japan macro sentences out of the BTC backdrop commentary (trade-plan sentences dropped, wording neutral). */
export function yenNote(commentary: unknown): string | null {
  if (typeof commentary !== "string") return null;
  const picked = splitSentences(commentary).filter((s) => MACRO_TERMS.test(s) && !TRADING_WORDS.test(s));
  return picked.length ? neutralText(picked.join(" ")) : null;
}

/** Dated catalysts with sources (event text reworded neutrally; trade-plan sentences dropped). */
export function catalystsBlock(a: Json) {
  return Array.isArray(a?.catalysts)
    ? a.catalysts
        .map((c: Json) => ({ date: c.date, kind: c.kind, text: neutralText(c.text), source: c.source, url: c.url }))
        .filter((c: Json) => c.text && !TRADING_WORDS.test(c.text))
    : [];
}

/**
 * BTC + macro backdrop. Market data only: no bias label or indicator score, no support/resistance or other chart levels,
 * no commentary (2026-10-25: Lumi no longer publishes trade-related readings).
 */
export function marketView(analysis: Json, prices: Json, context: Json, coins: CoinRef[]) {
  const backdrop = analysis?.backdrop ?? analysis?.coins?.bitcoin ?? null;
  const btc = coins.find((c) => c.id === "bitcoin") ?? FALLBACK_COINS[6];
  let up = 0;
  let down = 0;
  for (const c of coins) {
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
      catalysts: catalystsBlock(backdrop),
      sources: Array.isArray(backdrop?.sources) ? backdrop.sources.map((s: Json) => ({ title: typeof s.title === "string" ? neutralWords(s.title) : s.title, url: s.url })) : [],
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
    },
    analysis_as_of: analysis?.as_of ?? null,
  });
}
