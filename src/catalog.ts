/** Single source of truth for endpoints, prices and descriptions (used by docs, discovery and the paywall). */

import type { Config, PaidRoute } from "./config";
import { dropsToXrp } from "./config";
import { LINE_LABEL, MARKET_IDEAS_LABEL, productLine } from "./lines";

export interface PaidEndpoint {
  route: PaidRoute;
  method: "GET";
  path: string;
  /** Short listing name (XRPL AI Hub / x402 indexes ingest it). */
  name: string;
  /** OpenAPI-style template. */
  template: string;
  summary: string;
  example: string;
}

/** Shared buyer guarantee on every paid endpoint. */
export const NOT_CHARGED = "Not charged on bad input or stale data (every response carries as_of and stale_after).";

/**
 * Fixed example coin for discovery (/.well-known/x402 resources, OpenAPI x-example-url, samples, docs).
 * Keep this XRP permanently: the XRPL AI Hub indexes the concrete example URLs, and switching the example to BTC
 * made it retire /v1/signal/XRP and /v1/levels/XRP as "Inactive". Guarded by test/example_coin.test.ts.
 */
export const EXAMPLE_COIN = "XRP" as const;

export const PAID_ENDPOINTS: PaidEndpoint[] = [
  {
    route: "signal",
    name: "Lumi Market Ideas: coin signal (buy/sell read)",
    method: "GET",
    path: "/v1/signal/{coin}",
    template: "/v1/signal/{coin}",
    summary:
      MARKET_IDEAS_LABEL + " " +
      "Use this when you need a fast, mechanical buy/sell read on one coin before acting: overall label + score, per-timeframe (1h/4h/1d) labels and an indicator summary (RSI, MACD, EMA stack, Bollinger, StochRSI, volume). 50 top coins (GET /v1/coins), computed live from public exchange candles; 1h refreshed about every 13 minutes. " + NOT_CHARGED,
    example: `/v1/signal/${EXAMPLE_COIN}`,
  },
  {
    route: "levels",
    name: "Lumi Market Ideas: support/resistance + 7-day scenario levels",
    method: "GET",
    path: "/v1/levels/{coin}",
    template: "/v1/levels/{coin}",
    summary:
      MARKET_IDEAS_LABEL + " " +
      "Use this when you need to know where price may stall or turn for one coin: support/resistance levels, bias, rule-based 7-day bull/base/bear scenario levels (not forecasts), commentary, catalysts and cited sources. " + NOT_CHARGED,
    example: `/v1/levels/${EXAMPLE_COIN}`,
  },
  {
    route: "scan",
    name: "Lumi Market Ideas: all-coins scan (50 signals in one call)",
    method: "GET",
    path: "/v1/scan",
    template: "/v1/scan",
    summary:
      MARKET_IDEAS_LABEL + " " +
      "Use this when you need to screen the whole market in one call instead of 50: label, score, 1h/4h/1d labels, 1h RSI, price and 24h change for every coin in the live 50-coin universe (GET /v1/coins lists all 51 covered coins), strongest first, plus label counts and breadth. Computed live; 1h refreshed about every 13 minutes; freshness fields reflect the oldest coin included. Not sold when fewer than 40 coins are fresh. " + NOT_CHARGED,
    example: "/v1/scan",
  },
  {
    route: "lite",
    name: "Lumi Market Ideas: lite coin signal (label, score, price)",
    method: "GET",
    path: "/v1/lite/{coin}",
    template: "/v1/lite/{coin}",
    summary:
      MARKET_IDEAS_LABEL + " " +
      "Use this when you only need the headline read on one coin, cheaply: overall label and score, 1h/4h/1d labels and price with 24h change. Same live computation as /v1/signal/{coin}, which adds the full indicator breakdown. " + NOT_CHARGED,
    example: `/v1/lite/${EXAMPLE_COIN}`,
  },
  {
    route: "slate",
    name: "Lumi Market Ideas: paper-trade slate (current ideas)",
    method: "GET",
    path: "/v1/slate",
    template: "/v1/slate",
    summary:
      MARKET_IDEAS_LABEL + " " +
      "Use this when you need current, concrete trade setups to evaluate (paper trades, not advice): direction, entry/entry zone, stop, targets, leverage, conviction, plus 'no setup' notes. " + NOT_CHARGED,
    example: "/v1/slate",
  },
  {
    route: "market",
    name: "Lumi BTC + macro market backdrop",
    method: "GET",
    path: "/v1/market",
    template: "/v1/market",
    summary:
      "Use this when you need the whole crypto backdrop in one call: BTC levels/scenario levels/signal, macro (USD/JPY note, total cap, dominance, Fear & Greed, BTC perp funding/OI) and breadth across tracked coins. " + NOT_CHARGED,
    example: "/v1/market",
  },
  {
    route: "brief",
    name: "Lumi daily crypto market brief",
    method: "GET",
    path: "/v1/brief",
    template: "/v1/brief",
    summary:
      "Use this when you need a ready-to-read daily crypto brief (the same read as Lumi's newsletter): BTC price/levels/signal, Fear & Greed, funding, " +
      "top/bottom movers, key levels, yen watch, events in the next 48h, current paper-trade ideas (pending/open only, no outcomes or P/L) and sourced news. JSON with a " +
      "ready-to-use `markdown` field; add ?format=md (or Accept: text/markdown) for text/markdown. " + NOT_CHARGED,
    example: "/v1/brief",
  },
  {
    route: "yen",
    name: "Lumi yen carry-trade watch (USD/JPY, Nikkei)",
    method: "GET",
    path: "/v1/macro/yen",
    template: "/v1/macro/yen",
    summary:
      "Use this when you need to check whether yen carry-trade stress could spill into crypto: USD/JPY and Nikkei 225 (price, 1d/5d change, ranges), " +
      "a rule-based carry-trade risk level (low/watch/elevated) around the 155 USD/JPY line with reasons, BTC context, upcoming Japan events (BOJ, CPI) and sources. " + NOT_CHARGED,
    example: "/v1/macro/yen",
  },
  {
    route: "sentiment",
    name: "Lumi crypto sentiment (Fear & Greed, funding)",
    method: "GET",
    path: "/v1/sentiment",
    template: "/v1/sentiment",
    summary:
      "Use this when you need a quick read of crowd positioning: Fear & Greed (value, band, day-over-day change), BTC perp funding rate with a plain-English " +
      "read + open interest, total market cap/volume/dominance, and breadth/signal-label counts across tracked coins. " + NOT_CHARGED,
    example: "/v1/sentiment",
  },
  {
    route: "events",
    name: "Lumi macro + crypto events calendar",
    method: "GET",
    path: "/v1/events",
    template: "/v1/events",
    summary:
      "Use this when you need to know what scheduled events could move crypto soon: timed releases/decisions (UTC + US Central, with why it matters) and dated " +
      "per-coin catalysts (Fed, BOJ, CPI, network upgrades, conferences). Every row is sourced. " + NOT_CHARGED,
    example: "/v1/events",
  },
  {
    route: "funding",
    name: "Lumi perpetual funding rates (OKX perps)",
    method: "GET",
    path: "/v1/funding",
    template: "/v1/funding",
    summary:
      "Use this when you need derivatives positioning: the current perpetual funding rate for every Lumi coin listed on OKX (rate, 8h-normalised, annualised, next funding time, plain-English read), BTC read, median and the most positive/negative. Refreshed every 15 minutes; positive = longs pay shorts. " + NOT_CHARGED,
    example: "/v1/funding",
  },
  {
    route: "fear_greed",
    name: "Lumi Fear & Greed (CoinMarketCap, with history)",
    method: "GET",
    path: "/v1/fear-greed",
    template: "/v1/fear-greed",
    summary:
      "Use this when you need crypto sentiment: the CoinMarketCap Fear & Greed index now, yesterday, last week and last month, the change vs each, yearly high/low and a 30-day daily series. Refreshed every 30 minutes. " + NOT_CHARGED,
    example: "/v1/fear-greed",
  },
  {
    route: "events_48h",
    name: "Lumi events in the next 48 hours",
    method: "GET",
    path: "/v1/events/next48h",
    template: "/v1/events/next48h",
    summary:
      "Use this when you need to know what could move crypto in the next 48 hours: scheduled macro releases and decisions with exact UTC and US Central times, why each matters and its source, plus dated per-coin catalysts. An empty window is a valid answer. " + NOT_CHARGED,
    example: "/v1/events/next48h",
  },
  {
    route: "institutional",
    name: "Lumi Institutional & Policy Brief (daily)",
    method: "GET",
    path: "/v1/institutional",
    template: "/v1/institutional",
    summary:
      "Use this when you need a sourced daily summary of what central banks, standard-setters, regulators, banks and tokenization firms are doing in " +
      "digital assets and stablecoins, and which tracked networks each move touches. Every item has a source URL, date, why-it-matters, impact and " +
      "confidence, and a link_type that separates confirmed links from indirect-alignment analysis. Also: big picture, per-coin map, cross-item " +
      "connections, no-news notes and dated what-to-watch. JSON with a `markdown` field; ?format=md returns text/markdown. Neutral and apolitical; " +
      "not financial advice. " + NOT_CHARGED,
    example: "/v1/institutional",
  },
  {
    route: "trust_check",
    name: "Lumi x402 pay check (allow / warn / block)",
    method: "GET",
    path: "/v1/trust/check",
    template: "/v1/trust/check",
    summary:
      "Use this before your agent pays an unfamiliar x402 URL: allow / warn / block with coded reasons, from Lumi's daily CDP Bazaar index, free 402-quote checks and Lumi's own test-buys (Base USDC for Bazaar listings; XRPL only for a small curated vendor list, counted separately). Query: url (required), payTo and amount (optional: the payTo address and USD price you were quoted, to catch address or price mismatches). block = a concrete mismatch or a paid call that returned nothing; warn = not enough evidence; allow = listing and recent checks agree. Links the free lookup and, for curated vendors, the $0.02 full report. Observations, not a guarantee. Not charged on bad input.",
    example: "/v1/trust/check?url=https://api.example.com/v1/data",
  },
  {
    route: "vendor_report",
    name: "Lumi x402 vendor report (full observation history)",
    method: "GET",
    path: "/v1/trust/vendors/{id}/report",
    template: "/v1/trust/vendors/{id}/report",
    summary:
      "Use this when you need evidence before paying an x402 vendor on Lumi's trust list: the full observation history. Every free 402-quote check (90-day retention) " +
      "with status, quoted price and latency; every paid test-buy with amount, ledger tx hash, explorer link and delivered yes/no; latency stats " +
      "(min/p50/p90/p95/max) and the 7-day trend; uptime % over 24h/7d/30d/90d and a daily series; per-endpoint quoted-price history; verified " +
      "agent reports; vendor replies; score components, sample sizes and confidence labels. Automated observations, not a rating. " +
      "Not sold (503, not charged) when the vendor has no observation in the last 48 h. The free summary is GET /v1/trust/vendors/{id}.",
    example: "/v1/trust/vendors/printmoneylab/report",
  },
];

export function priceTable(cfg: Config) {
  return PAID_ENDPOINTS.map((e) => ({
    method: e.method,
    path: e.path,
    name: e.name,
    product_line: LINE_LABEL[productLine(e.route)],
    price_xrp: dropsToXrp(cfg.pricesDrops[e.route]),
    price_drops: cfg.pricesDrops[e.route],
    price_rlusd: cfg.ious.find((o) => o.symbol === "RLUSD")?.prices[e.route] ?? null,
    price_usdc: cfg.ious.find((o) => o.symbol === "USDC")?.prices[e.route] ?? null,
    price_base_usdc: cfg.evm?.prices[e.route] ?? null,
    prices: [
      ...(cfg.evm
        ? [{ asset: "USDC", amount: cfg.evm.prices[e.route], network: cfg.evm.network, chain: cfg.evm.networkName, token: cfg.evm.asset, amount_atomic: cfg.evm.amounts[e.route] }]
        : []),
      { asset: "XRP", amount: dropsToXrp(cfg.pricesDrops[e.route]), network: cfg.network },
      ...cfg.ious.map((o) => ({ asset: o.symbol, amount: o.prices[e.route], currency: o.currency, issuer: o.issuer, network: cfg.network })),
      ...(cfg.stellar
        ? [{ asset: "USDC", amount: cfg.stellar.prices[e.route], network: cfg.stellar.network, chain: cfg.stellar.networkName, token: cfg.stellar.asset, amount_atomic: cfg.stellar.amounts[e.route] }]
        : []),
    ],
    summary: e.summary,
    example: e.example,
  }));
}
