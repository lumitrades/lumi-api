/**
 * x402 Bazaar discovery metadata (the `bazaar` extension of a v2 PaymentRequired), one entry per paid route.
 *
 * The CDP facilitator indexes a resource after its first successful settlement, using `paymentPayload.resource`
 * (url, description <= 500 chars, mimeType) and `paymentPayload.extensions.bazaar` (`info` validated against
 * `schema` with JSON Schema 2020-12). The shape matches `declareDiscoveryExtension()` from @x402/extensions, with
 * `routeTemplate` + `pathParams` for the parameterised routes so all coins / vendors collapse into one listing.
 * Examples are deliberately short: the whole PaymentRequired also travels base64-encoded in a response header.
 */

import { DEFAULT_PRICES, type PaidRoute } from "./config";
import { MARKET_IDEAS_NAME, MARKET_IDEAS_NOTICE, MARKET_IDEAS_ROUTES } from "./lines";

/** CDP rejects verify/settle when resource.description is longer than this. */
export const BAZAAR_MAX_DESCRIPTION = 500;

/**
 * Bazaar service metadata (x402 v2 `resource.serviceName/tags/iconUrl`): printable ASCII, serviceName <= 32 chars,
 * at most 5 tags of <= 32 chars each. Each route gets its own tag set so the listings cover many search terms.
 */
export const SERVICE_NAME = "Lumi Trades";
/** The trust layer (pay-check, vendor reports, monitoring and feed plans) is listed under its own service name. */
export const TRUST_SERVICE_NAME = "Lumi Trust";
export const TRUST_ROUTES: PaidRoute[] = ["trust_check", "vendor_report", "verdict"];
/** Signal-style routes (signal, lite, scan, slate, levels) are listed as their own line, apart from the trust layer. */
export const MARKET_IDEAS_SERVICE_NAME = MARKET_IDEAS_NAME;
export const SERVICE_ICON = "https://lumitrades.io/assets/icon-512.png";
export const ROUTE_TAGS: Record<PaidRoute, string[]> = {
  signal: ["crypto-signals", "trading-signals", "technical-analysis", "bitcoin", "ethereum"],
  levels: ["support-resistance", "technical-analysis", "price-levels", "bitcoin", "crypto"],
  slate: ["trade-ideas", "paper-trading", "crypto-trading", "bitcoin", "crypto"],
  market: ["market-data", "bitcoin", "funding-rates", "open-interest", "crypto"],
  brief: ["market-brief", "crypto-news", "daily-report", "bitcoin", "crypto"],
  yen: ["macro", "forex", "yen-carry-trade", "japan", "bitcoin"],
  sentiment: ["sentiment", "fear-and-greed", "funding-rates", "open-interest", "crypto"],
  events: ["economic-calendar", "events", "macro", "bitcoin", "crypto"],
  institutional: ["regulation", "stablecoins", "tokenization", "policy", "crypto"],
  vendor_report: ["x402", "trust-score", "api-monitoring", "security", "due-diligence"],
  scan: ["crypto-screener", "trading-signals", "market-scan", "technical-analysis", "crypto"],
  lite: ["crypto-signals", "trading-signals", "bitcoin", "cheap", "crypto"],
  trust_check: ["x402", "payment-safety", "trust-score", "payment-check", "agent-payments"],
  verdict: ["x402", "payment-check", "pre-payment", "test-buys", "agent-payments"],
  funding: ["funding-rates", "perpetuals", "derivatives", "positioning", "crypto"],
  fear_greed: ["fear-and-greed", "sentiment", "coinmarketcap", "bitcoin", "crypto"],
  events_48h: ["economic-calendar", "events", "macro", "fomc", "crypto"],
};

export function serviceMeta(route: PaidRoute): { serviceName: string; tags: string[]; iconUrl: string } {
  return { serviceName: serviceNameFor(route), tags: ROUTE_TAGS[route], iconUrl: SERVICE_ICON };
}

export function serviceNameFor(route: PaidRoute): string {
  return TRUST_ROUTES.includes(route) ? TRUST_SERVICE_NAME : MARKET_IDEAS_ROUTES.includes(route) ? MARKET_IDEAS_SERVICE_NAME : SERVICE_NAME;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface RouteMeta {
  /** Listing text (<= 500 chars, plain description). */
  description: string;
  /** Colon-style template for routes with a path parameter. */
  routeTemplate?: string;
  pathParam?: { name: string; schema: Record<string, Json> };
  /** Query parameters. */
  query?: Record<string, Record<string, Json>>;
  /** Query parameters that must be present (the request is refused with 400, never charged, without them). */
  queryRequired?: string[];
  example: Record<string, Json>;
}

/** Coin input: ticker or CoinGecko id, case-insensitive (XRP, xrp and ripple are the same coin). */
export const COIN_PATTERN = "^[A-Za-z0-9-]{1,40}$";
const COIN_PARAM = {
  name: "coin",
  schema: { type: "string", pattern: COIN_PATTERN, description: "Coin ticker or CoinGecko id, case-insensitive, e.g. XRP, BTC, ETH, HBAR (list: GET /v1/coins, free)" },
};
/** Vendor id input, identical in the OpenAPI document and the 402 bazaar schema. */
export const VENDOR_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
const FORMAT_QUERY = {
  format: { type: "string", enum: ["json", "md"], description: "md returns the brief as text/markdown; default JSON (with a markdown field)" },
};

/** Example `payment` block of a paid response, at the route's real (default) Base USDC price. */
const pay = (route: PaidRoute, usd: string = DEFAULT_PRICES[route].usd): Record<string, Json> => ({
  network: "eip155:8453",
  asset: "USDC",
  amount: usd,
  transaction: "0x5f0c...e41a",
  payer: "0x12ab...89cd",
});

/** Example freshness fields (present on every paid response): as_of, data_age_seconds, next_update, stale_after. */
const FRESH = (asOf: string, staleAfter: string, ageSeconds = 600, nextUpdate?: string): Record<string, Json> => {
  const next = nextUpdate ?? new Date(Math.min(Date.parse(asOf) + 6 * 3_600_000, Date.parse(staleAfter))).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { as_of: asOf, data_age_seconds: ageSeconds, next_update: next, stale_after: staleAfter };
};

/** Shared promise appended to every listing. */
export const FAIR_USE =
  "Every response carries as_of, data_age_seconds, next_update and stale_after. Not charged on bad input or stale data.";

export const BAZAAR_ROUTES: Record<PaidRoute, RouteMeta> = {
  signal: {
    description:
      "Lumi Market Ideas (educational, not financial advice). Rule-based technical read for one of 51 large-cap crypto assets (XRP, BTC, ETH and more): label (Strong Buy to Strong Sell) and score, 1h/4h/1d labels, indicator summary (RSI, MACD, EMA stack, Bollinger, StochRSI, volume) and price with 24h change. From public exchange candles; 1h refreshes about every 13 min. Paper-trade analysis, not investment advice. Lumi does not trade real money. Not charged on unknown coins or stale data.",
    routeTemplate: "/v1/signal/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "signal",
      product_line: MARKET_IDEAS_NAME,
      notice: MARKET_IDEAS_NOTICE,
      coin: { symbol: "XRP", name: "XRP" },
      label: "Sell",
      score: -0.34,
      price: { usd: 2.41, change_24h_pct: -1.62 },
      timeframes: { "1h": { label: "Sell", score: -0.3 }, "4h": { label: "Neutral", score: 0 }, "1d": { label: "Strong Sell", score: -0.7 } },
      ...FRESH("2026-10-22T11:17:26Z", "2026-10-22T23:17:26Z"),
      payment: pay("signal"),
    },
  },
  levels: {
    description:
      "Lumi Market Ideas (educational, not financial advice). Support and resistance levels for one of 14 watchlist and major coins (XRP, BTC, ETH, HBAR, XLM and more), with a bias label, rule-based 7-day bull/base/bear scenario levels (not forecasts), commentary, dated catalysts and cited sources. Use for price reference levels on one coin. Paper-trade analysis, not investment advice. Lumi does not trade real money. Other coins return 404 without charge; see /v1/coins. Not charged on stale data.",
    routeTemplate: "/v1/levels/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "levels",
      product_line: MARKET_IDEAS_NAME,
      notice: MARKET_IDEAS_NOTICE,
      coin: { symbol: "XRP", name: "XRP" },
      price: { usd: 2.41 },
      bias: "neutral-to-soft",
      support: [2.35, 2.28],
      resistance: [2.5, 2.62],
      scenarios: { horizon_days: 7, bull: 2.62, base: 2.43, bear: 2.27, label: "rule-based scenario levels, not forecasts" },
      projection: { horizon_days: 7, bull: 2.62, base: 2.43, bear: 2.27, label: "rule-based scenario levels, not forecasts" },
      commentary: "Holding the 2.35 pivot; a close above 2.50 flips the read.",
      catalysts: [{ date: "2026-10-28", title: "FOMC decision" }],
      sources: [{ title: "CoinGecko", url: "https://www.coingecko.com/en/coins/ripple" }],
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-23T11:05:00Z"),
      payment: pay("levels"),
    },
  },
  slate: {
    description:
      "Lumi Market Ideas (educational, not financial advice). Lumi's current paper-trade setups, published for evaluation: coin, direction, entry zone, stop, targets, leverage and conviction for each idea, plus notes where no setup qualifies. Use when an agent needs structured, current trade-setup data to evaluate or compare against its own analysis. No performance is implied. Paper-trade analysis, not investment advice. Lumi does not trade real money. Not charged on stale data.",
    example: {
      kind: "slate",
      product_line: MARKET_IDEAS_NAME,
      notice: MARKET_IDEAS_NOTICE,
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      ideas: [{ coin: "BTC", direction: "long", entry_zone: { low: 81800, high: 82300 }, stop: 80800, targets: [84500, 86000], leverage: 3, conviction: "medium" }],
      payment: pay("slate"),
    },
  },
  market: {
    description:
      "Crypto market backdrop in one call: BTC support/resistance and bias, macro context (total market cap, BTC dominance, Fear & Greed, USD/JPY note, BTC perpetual funding and open interest) and 24h breadth across 14 tracked coins. Use when an agent needs the overall market context before analysing individual coins. Analytics only, not financial advice. Not charged on stale data.",
    example: {
      kind: "market",
      btc_backdrop: { bias: "soft", support: [80000, 81000], resistance: [82500, 84800] },
      macro: { total_mcap_usd: 2742576601668, btc_dominance_pct: 60.04, fear_greed: { value: 49, classification: "Neutral" } },
      breadth: { coins_tracked: 14, up_24h: 1, down_24h: 13 },
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      payment: pay("market"),
    },
  },
  brief: {
    description:
      "Daily crypto market brief as JSON with a ready-to-use markdown field (or text/markdown with format=md): headline, BTC price and signal label, key levels, Fear & Greed, funding, top and bottom movers, yen watch, events in the next 48 hours, current paper-trade ideas (pending/open only, no outcomes or P/L) and sourced news. Use when an agent needs a single daily summary of the crypto market to read or republish. Analytics only, not financial advice. Not charged on invalid format or stale data.",
    query: FORMAT_QUERY,
    example: {
      kind: "brief",
      date: "2026-10-22",
      headline: "Crypto slides with stocks",
      bitcoin: { usd: 81984, change_24h_pct: -1.62, signal: "Sell" },
      key_levels: [{ coin: "ETH", support: 3800, resistance: 4100 }],
      events_next_48h: [{ at_utc: "2026-10-22T23:30:00Z", title: "Japan September CPI" }],
      markdown: "# Lumi daily brief, Oct 22 2026 ...",
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-24T11:05:00Z"),
      payment: pay("brief"),
    },
  },
  yen: {
    description:
      "Yen carry-trade monitor: USD/JPY and Nikkei 225 levels with daily and 5-day changes, a rule-based carry-trade risk level (low, watch or elevated) measured against the 155 USD/JPY line with reasons, and upcoming Japan events such as BOJ decisions and CPI releases, with sources. Use when an agent needs to assess whether yen funding stress could affect risk assets including crypto. Analytics only, not financial advice. Not charged on stale data.",
    example: {
      kind: "macro_yen",
      usd_jpy: { price: 157.08, change_pct: -0.62, change_5d_pct: -0.67 },
      nikkei_225: { price: 62907.84, change_pct: -2.65 },
      carry_trade_risk: { level: "watch", key_level: 155, distance_to_key_level_pct: 1.34, reasons: ["USD/JPY within 1.5% of 155"] },
      japan_events: [{ date: "2026-10-30", title: "BOJ policy decision" }],
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      payment: pay("yen"),
    },
  },
  sentiment: {
    description:
      "Crypto sentiment and positioning snapshot: Fear and Greed index value, band and day-over-day change; BTC perpetual funding rate with a plain-English read and open interest; total market cap and BTC dominance; and 24h breadth across tracked coins. Use when an agent needs a compact read of market sentiment and derivatives positioning. Analytics only, not financial advice. Not charged on stale data.",
    example: {
      kind: "sentiment",
      fear_greed: { value: 49, classification: "Neutral", previous: 54, change: -5 },
      derivatives: { instrument: "BTC-USDT-SWAP (OKX)", funding_rate_pct: 0.00657, open_interest_usd: 2462680121 },
      global: { total_mcap_usd: 2742576601668, btc_dominance_pct: 60.04 },
      breadth: { coins_tracked: 14, up_24h: 1, down_24h: 13 },
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-22T23:05:00Z"),
      payment: pay("sentiment"),
    },
  },
  events: {
    description:
      "Calendar of scheduled macro and crypto events: timed releases and policy decisions in UTC and US Central time with a note on relevance, plus dated per-coin catalysts such as network upgrades and conferences. Every row cites a source. Use when an agent needs to know which scheduled events in the coming days could affect crypto markets. For only the next 48 hours, /v1/events/next48h is lower cost. Not charged on stale data.",
    example: {
      kind: "events",
      next: { at_utc: "2026-10-22T23:30:00Z", title: "Japan September CPI", why: "Last national CPI before the BOJ meeting." },
      upcoming_timed: [{ at_utc: "2026-10-28T18:00:00Z", title: "FOMC rate decision", url: "https://www.federalreserve.gov/" }],
      upcoming_by_date: [{ date: "2026-11-03", coin: "XLM", title: "Protocol 30 validator vote" }],
      ...FRESH("2026-10-22T11:05:00Z", "2026-10-24T11:05:00Z"),
      payment: pay("events"),
    },
  },
  institutional: {
    description:
      "Daily Institutional & Policy Brief: dated, sourced items on digital-asset and stablecoin activity by central banks, standard-setters, regulators, banks and tokenization firms, with impact, confidence and the networks each item touches. JSON with markdown, or format=md. Neutral; not advice.",
    query: FORMAT_QUERY,
    example: {
      kind: "institutional_brief",
      date: "2026-10-22",
      big_picture: ["Stablecoin rules move from consultation to implementation."],
      items: [
        {
          entity: "Example regulator",
          headline: "Regulator publishes final guidance for payment stablecoin issuers",
          date: "2026-10-21",
          source_url: "https://example.org/news/stablecoin-guidance",
          coins: ["RLUSD", "USDC"],
          link_type: "context",
          impact: "bullish",
          confidence: "high",
        },
      ],
      watch_next: [{ date: "2026-10-29", what: "BOJ policy meeting" }],
      markdown: "# Institutional & Policy Brief, Oct 22 2026 ...",
      ...FRESH("2026-10-22T11:20:32Z", "2026-10-24T11:20:32Z"),
      payment: pay("institutional"),
    },
  },
  vendor_report: {
    description:
      "Full observation history for one x402 vendor on Lumi's curated list: unpaid 402-quote checks with status, quoted price and latency; paid test purchases with ledger transaction hashes and delivered yes/no (XRP Ledger, Base, Stellar); uptime over 24h/7d/30d/90d; quoted-price history; score components with sample sizes. Automated observations, not a rating.",
    routeTemplate: "/v1/trust/vendors/:id/report",
    pathParam: {
      name: "id",
      schema: { type: "string", pattern: VENDOR_ID_PATTERN, description: "Vendor id from GET /v1/trust/vendors (free)" },
    },
    example: {
      kind: "trust_vendor_report",
      id: "example-vendor",
      name: "Example Vendor",
      score: { value: 82, confidence: "medium", window_days: 30 },
      windows: { "24h": { uptime_pct: 100 }, "7d": { uptime_pct: 99.4 } },
      paid_test_buys: { count: 6, delivered: 6, delivery_pct: 100 },
      quote_checks: { columns: ["checked_at", "endpoint", "http_status", "valid_quote", "price"], rows: [["2026-10-22T12:30:00Z", 0, 402, true, "0.01"]] },
      ...FRESH("2026-10-22T12:30:00Z", "2026-10-24T12:30:00Z"),
      payment: pay("vendor_report"),
    },
  },
  scan: {
    description:
      "Lumi Market Ideas (educational, not financial advice). Market-wide screen of 51 large-cap crypto assets in one call: label, score, 1h/4h/1d labels, 1h RSI, price and 24h change per coin, strongest first, plus label counts and breadth. Computed live; freshness fields reflect the oldest coin included; not sold when fewer than 40 coins are fresh. Use to compare many coins in one call. Paper-trade analysis, not investment advice. Lumi does not trade real money.",
    example: {
      kind: "scan",
      product_line: MARKET_IDEAS_NAME,
      notice: MARKET_IDEAS_NOTICE,
      count: 50,
      label_counts: { "Strong Buy": 3, Buy: 11, Neutral: 21, Sell: 12, "Strong Sell": 3 },
      breadth: { bullish: 14, neutral: 21, bearish: 15, read: "mixed" },
      coins: [{ symbol: "SOL", label: "Buy", score: 0.41, tf: { "1h": "Buy", "4h": "Buy", "1d": "Neutral" }, rsi_1h: 61.2, price_usd: 187.4, change_24h_pct: 2.1 }],
      ...FRESH("2026-10-23T11:02:00Z", "2026-10-23T12:17:00Z"),
      payment: pay("scan"),
    },
  },
  lite: {
    description:
      "Lumi Market Ideas (educational, not financial advice). Low-cost headline read for one of 51 large-cap crypto assets (XRP, BTC, ETH and more): overall label and score, 1h/4h/1d labels, and price with 24h change. Same live computation as /v1/signal/{coin}, without the indicator breakdown. Payable in USDC on Base or Stellar, or XRP, RLUSD or USDC on the XRP Ledger. Paper-trade analysis, not investment advice. Lumi does not trade real money. Not charged on unknown coins or stale data.",
    routeTemplate: "/v1/lite/:coin",
    pathParam: COIN_PARAM,
    example: {
      kind: "signal_lite",
      product_line: MARKET_IDEAS_NAME,
      notice: MARKET_IDEAS_NOTICE,
      coin: { symbol: "XRP", name: "XRP" },
      label: "Neutral",
      score: 0.05,
      price: { usd: 2.43, change_24h_pct: 0.4 },
      timeframes: { "1h": { label: "Buy", score: 0.3 }, "4h": { label: "Neutral", score: 0 }, "1d": { label: "Sell", score: -0.3 } },
      ...FRESH("2026-10-23T11:02:00Z", "2026-10-23T12:17:00Z"),
      payment: pay("lite"),
    },
  },
  trust_check: {
    description:
      "Pre-payment check for an x402 resource URL: allow, warn or block with coded reasons. Built from a daily index of the CDP Bazaar catalog, unpaid 402-quote checks and Lumi's own on-chain test purchases on Base, the XRP Ledger and Stellar. Optional payTo and amount inputs catch address or price mismatches. A free signed version, Lumi Check, is at /v1/check. Observations, not a guarantee.",
    query: {
      url: { type: "string", description: "The x402 resource URL you are about to pay (required)" },
      payTo: { type: "string", description: "The payTo address from its 402 quote (optional)" },
      amount: { type: "string", description: "The quoted price in USD, e.g. 0.01 (optional)" },
    },
    queryRequired: ["url"],
    example: {
      kind: "trust_check",
      query: { url: "https://api.example.com/v1/data", payTo: "0x12ab...89cd" },
      verdict: "warn",
      confidence: "low",
      reasons: [{ code: "last_quote_invalid", severity: "warn", detail: "Lumi's last free quote check did not get a valid x402 quote." }],
      next_steps: { free_lookup: "https://api.lumitrades.io/v1/trust/vendors?url=..." },
      ...FRESH("2026-10-23T11:00:00Z", "2026-10-24T11:00:00Z"),
      payment: pay("trust_check"),
    },
  },
  verdict: {
    description:
      "One-label pre-payment check for an x402 URL or seller domain: checks_passed, check_first, checks_failed or no_data, with as-of date, evidence window, conclusive Lumi test-buy count, last delivered/failed dates, reason codes, evidence and appeal links. Same data and signing key as the free /v1/check. Observed on-chain payments shown as ranges only (unverified; no payer addresses or amounts). Observations, not a guarantee.",
    query: {
      url: { type: "string", description: "The x402 resource URL or the seller's domain (required)" },
      payTo: { type: "string", description: "The payTo address from its 402 quote (optional)" },
      amount: { type: "string", description: "The quoted price in USD, e.g. 0.01 (optional)" },
    },
    queryRequired: ["url"],
    example: {
      kind: "lumi_verdict",
      label: "checks_passed",
      label_text: "Delivered in recent checks",
      reason_code: "delivered_recently",
      as_of: "2026-10-25",
      evidence_window: { from: "2026-09-02", to: "2026-10-20", test_buy_rule_days: 14 },
      n_conclusive: 3,
      last_delivered_at: "2026-10-20T09:12:00Z",
      last_failed_at: null,
      reply_url: "https://lumitrades.io/contact/",
      observed_onchain_payments: { shown: true, name: "Observed on-chain payments (unverified)", payer_groups_30d: "10–99", payments_30d: "100–999", last_payment: "within the last week" },
      commercial_relationship: [],
      ...FRESH("2026-10-25T11:00:00Z", "2026-10-26T11:00:00Z"),
      payment: pay("verdict"),
    },
  },
  funding: {
    description:
      "Perpetual funding rates for every Lumi coin listed on OKX USDT swaps: rate, 8h-normalised rate, annualised rate, next funding time and a plain-English read, plus the BTC read, the median and the most positive and negative coins (XRP, BTC, ETH and the rest). Positive means longs pay shorts. Refreshed every 15 minutes. Use when an agent needs derivatives positioning data across many coins. Analytics only, not financial advice. Not charged on stale data.",
    example: {
      kind: "funding",
      venue: "OKX USDT perpetual swaps",
      btc: { symbol: "BTC", rate_pct: 0.0061, interval_hours: 8, rate_8h_pct: 0.0061, annualized_pct: 6.68, read: "near neutral" },
      median_rate_8h_pct: 0.005,
      most_positive: [{ symbol: "PUMP", rate_8h_pct: 0.042 }],
      ...FRESH("2026-10-23T11:00:00Z", "2026-10-23T12:00:00Z"),
      payment: pay("funding"),
    },
  },
  fear_greed: {
    description:
      "CoinMarketCap Crypto Fear and Greed index (market sentiment): current value and classification, change versus yesterday, last week and last month, yearly high and low, and a 30-day daily series. Refreshed every 30 minutes. Use when an agent needs a sentiment gauge with recent history rather than a single reading. Payable in USDC on Base or Stellar, or XRP, RLUSD or USDC on the XRP Ledger. Not charged on stale data.",
    example: {
      kind: "fear_greed",
      source: "CoinMarketCap",
      value: 38,
      classification: "Fear",
      change: { vs_yesterday: -4, vs_last_week: 6, vs_last_month: -15 },
      series_30d: [{ date: "2026-10-22", value: 42 }],
      ...FRESH("2026-10-23T11:00:00Z", "2026-10-23T17:00:00Z"),
      payment: pay("fear_greed"),
    },
  },
  events_48h: {
    description:
      "Scheduled macro releases, policy decisions and dated per-coin catalysts in the next 48 hours, with exact UTC and US Central times, a note on relevance and a source for each. An empty window is a valid result. Use when an agent needs a short-horizon event check before acting or scheduling. The full multi-day calendar is /v1/events. Not charged on stale data.",
    example: {
      kind: "events_48h",
      count: 2,
      next: { at_utc: "2026-10-23T12:30:00Z", title: "US jobless claims", why: "Labor-market read ahead of the FOMC", source: "DOL" },
      timed: [{ at_utc: "2026-10-23T12:30:00Z", title: "US jobless claims" }],
      ...FRESH("2026-10-23T06:00:00Z", "2026-10-24T06:00:00Z"),
      payment: pay("events_48h"),
    },
  },
};

/** Minimal JSON Schema for an example value: type at every level, object properties to depth 2, all present keys required at the top. */
export function schemaFor(v: Json, depth = 0): Record<string, Json> {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) return { type: "array" };
  if (typeof v === "object") {
    if (depth >= 1) return { type: "object" };
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaFor(x, depth + 1)])),
      required: Object.keys(v).filter((k) => k === "kind" || k === "payment"),
    };
  }
  return { type: typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string" };
}

/**
 * The `bazaar` extension for one request. `arg` is the concrete path parameter (coin symbol / vendor id) of this URL,
 * `query` the recognised query parameters actually present.
 */
export function bazaarExtension(route: PaidRoute, arg?: string, query?: Record<string, string>, usd?: string): Record<string, Json> {
  const meta0 = BAZAAR_ROUTES[route];
  const meta = usd ? { ...meta0, example: { ...meta0.example, payment: pay(route, String(Number(usd))) } } : meta0;
  const input: Record<string, Json> = { type: "http", method: "GET" };
  const inputProps: Record<string, Json> = {
    type: { type: "string", const: "http" },
    method: { type: "string", enum: ["GET"] },
  };
  if (meta.query) {
    const present = Object.fromEntries(Object.entries(query ?? {}).filter(([k]) => k in meta.query!));
    if (Object.keys(present).length) input.queryParams = present;
    inputProps.queryParams = { type: "object", properties: meta.query, ...(meta.queryRequired ? { required: meta.queryRequired } : {}), additionalProperties: false };
  } else if (!meta.pathParam) {
    // No inputs at all: still declare an (empty) query schema so discovery tools see an input schema.
    inputProps.queryParams = { type: "object", properties: {}, additionalProperties: false };
  }
  if (meta.pathParam && arg !== undefined) {
    input.pathParams = { [meta.pathParam.name]: arg };
    inputProps.pathParams = {
      type: "object",
      properties: { [meta.pathParam.name]: meta.pathParam.schema },
      required: [meta.pathParam.name],
      additionalProperties: false,
    };
  }
  return {
    info: { input, output: { type: "json", example: meta.example } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: inputProps, required: ["type", "method"], additionalProperties: false },
        output: {
          type: "object",
          properties: { type: { type: "string" }, example: schemaFor(meta.example) },
          required: ["type"],
        },
      },
      required: ["input"],
    },
    ...(meta.routeTemplate && arg !== undefined ? { routeTemplate: meta.routeTemplate } : {}),
  };
}

/** resource.description for a quote: the full summary when it fits CDP's limit, otherwise the Bazaar listing text. */
/** Buyer-keyword headline per route, so Bazaar search and listings show what it is and what it costs first. */
const HEADLINES: Record<PaidRoute, (subject?: string) => string> = {
  signal: (c) => (c ? `${c} crypto trading signal (buy/sell score)` : "Crypto trading signal (buy/sell score)"),
  levels: (c) => `${c ? `${c} support` : "Crypto support"} and resistance levels with 7-day scenario levels`,
  slate: () => "Crypto paper-trade ideas (entry, stop, targets)",
  market: () => "Crypto market backdrop (BTC levels, macro, dominance, funding)",
  brief: () => "Daily crypto market brief (BTC, movers, key levels, news)",
  yen: () => "Yen carry-trade risk watch for crypto (USD/JPY, Nikkei, BOJ)",
  sentiment: () => "Crypto sentiment (Fear & Greed, BTC funding, open interest)",
  events: () => "Crypto and macro events calendar (Fed, CPI, BOJ, upgrades)",
  institutional: () => "Daily institutional & policy brief for digital assets (regulators, banks, tokenization)",
  vendor_report: (v) => `x402 vendor trust report${v ? ` for ${v}` : ""} (uptime, latency, test-buys)`,
  scan: () => "Crypto market scan: buy/sell signals for 50 large-cap coins in one call",
  lite: (c) => (c ? `${c} lite trading signal (label, score, price)` : "Crypto lite trading signal (label, score, price)"),
  trust_check: () => "Pre-payment check for an x402 URL (coded reasons, checks_passed/check_first/checks_failed/no_data)",
  verdict: () => "One-label x402 pre-payment check (Delivered in recent checks / Check first / Recent checks failed / Not enough data)",
  funding: () => "Crypto perpetual funding rates (OKX perps)",
  fear_greed: () => "Crypto Fear & Greed index (CoinMarketCap, 30-day history)",
  events_48h: () => "Crypto and macro events in the next 48 hours",
};

/**
 * The 402 resource description that the Bazaar and x402scan index: the route's v2 listing text (Scout,
 * notes/outreach/bazaar_descriptions_v2.md), never with a price inside it. Prices live only in accepts[] and in
 * openapi x-payment-info, so a listing can never show a stale or wrong price in its text.
 * `full`/`opts` are kept for call-site compatibility.
 */
export function resourceDescription(route: PaidRoute, full: string, opts: { subject?: string; usd?: string } = {}): string {
  void full; void opts;
  const desc = BAZAAR_ROUTES[route].description;
  return desc.length <= BAZAAR_MAX_DESCRIPTION ? desc : desc.slice(0, BAZAAR_MAX_DESCRIPTION - 1).replace(/\s+\S*$/, "") + "…";
}

/** Short keyword headline per route (not used in resource.description; kept for titles). */
export function routeHeadline(route: PaidRoute, subject?: string): string {
  return HEADLINES[route](subject);
}
