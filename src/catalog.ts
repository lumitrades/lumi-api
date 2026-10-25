/** Single source of truth for endpoints, prices and descriptions (used by docs, discovery and the paywall). */

import type { Config, PaidRoute } from "./config";
import { dropsToXrp } from "./config";
import { LINE_LABEL, productLine } from "./lines";

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

export const PAID_ENDPOINTS: PaidEndpoint[] = [
  {
    route: "market",
    name: "Lumi Trades: BTC + macro market backdrop",
    method: "GET",
    path: "/v1/market",
    template: "/v1/market",
    summary:
      "Use this when you need the whole crypto backdrop in one call: BTC price and 24h change, macro (USD/JPY note, total cap, dominance, Fear & Greed, BTC perp funding/OI), dated catalysts with sources and 24h up/down breadth across tracked coins. " + NOT_CHARGED,
    example: "/v1/market",
  },
  {
    route: "yen",
    name: "Lumi Trades: yen macro watch (USD/JPY, Nikkei)",
    method: "GET",
    path: "/v1/macro/yen",
    template: "/v1/macro/yen",
    summary:
      "Use this when you need to check whether a fast yen move could spill into crypto: USD/JPY and Nikkei 225 (price, 1d/5d change, ranges), " +
      "a rule-based macro risk level (low/watch/elevated) against a 155 USD/JPY reference with reasons, BTC context, upcoming Japan events (BOJ, CPI) and sources. " + NOT_CHARGED,
    example: "/v1/macro/yen",
  },
  {
    route: "sentiment",
    name: "Lumi Trades: crypto sentiment (Fear & Greed, funding)",
    method: "GET",
    path: "/v1/sentiment",
    template: "/v1/sentiment",
    summary:
      "Use this when you need a quick market-mood snapshot: Fear & Greed (value, band, day-over-day change), the BTC perp funding rate (sign and size) " +
      "+ open interest, total market cap/volume/dominance, and 24h up/down breadth across tracked coins. " + NOT_CHARGED,
    example: "/v1/sentiment",
  },
  {
    route: "events",
    name: "Lumi Trades: macro + crypto events calendar",
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
    name: "Lumi Trades: perpetual funding rates (OKX perps)",
    method: "GET",
    path: "/v1/funding",
    template: "/v1/funding",
    summary:
      "Use this when you need perpetual funding data: the current perpetual funding rate for every tracked coin listed on OKX (rate, 8h-normalised, annualised, next funding time, size band), the BTC rate, the median and the most positive/negative. Refreshed every 15 minutes; a positive rate means the perpetual price is above its index. " + NOT_CHARGED,
    example: "/v1/funding",
  },
  {
    route: "fear_greed",
    name: "Lumi Trades: Fear & Greed (CoinMarketCap, with history)",
    method: "GET",
    path: "/v1/fear-greed",
    template: "/v1/fear-greed",
    summary:
      "Use this when you need crypto sentiment: the CoinMarketCap Fear & Greed index now, yesterday, last week and last month, the change vs each, yearly high/low and a 30-day daily series. Refreshed every 30 minutes. " + NOT_CHARGED,
    example: "/v1/fear-greed",
  },
  {
    route: "events_48h",
    name: "Lumi Trades: events in the next 48 hours",
    method: "GET",
    path: "/v1/events/next48h",
    template: "/v1/events/next48h",
    summary:
      "Use this when you need to know what could move crypto in the next 48 hours: scheduled macro releases and decisions with exact UTC and US Central times, why each matters and its source, plus dated per-coin catalysts. An empty window is a valid answer. " + NOT_CHARGED,
    example: "/v1/events/next48h",
  },
  {
    route: "institutional",
    name: "Lumi Trades: Institutional & Policy Brief (daily)",
    method: "GET",
    path: "/v1/institutional",
    template: "/v1/institutional",
    summary:
      "Use this when you need a sourced daily summary of what central banks, standard-setters, regulators, banks and tokenization firms are doing in " +
      "digital assets and stablecoins, and which tracked networks each move touches. Every item has a source URL, date, why-it-matters and " +
      "confidence, and a link_type that separates confirmed links from indirect-alignment analysis. Also: big picture, per-coin map, cross-item " +
      "connections, no-news notes and dated what-to-watch. JSON with a `markdown` field; ?format=md returns text/markdown. Neutral and apolitical; " +
      "not financial advice. " + NOT_CHARGED,
    example: "/v1/institutional",
  },
  {
    route: "trust_check",
    name: "Lumi Trades: check before paying an x402 URL (allow / warn / block)",
    method: "GET",
    path: "/v1/trust/check",
    template: "/v1/trust/check",
    summary:
      "Use this before your agent pays an unfamiliar x402 URL: allow / warn / block with coded reasons, from Lumi's daily CDP Bazaar index, free 402-quote checks and Lumi's own test-buys (Base USDC for Bazaar listings; XRPL only for a small curated vendor list, counted separately). Query: url (required), payTo and amount (optional: the payTo address and USD price you were quoted, to catch address or price mismatches). block = a concrete mismatch or a paid call that returned nothing; warn = not enough evidence; allow = listing and recent checks agree. Links the free lookup and, for curated vendors, the $0.02 full report. Observations, not a guarantee. Not charged on bad input.",
    example: "/v1/trust/check?url=https://api.example.com/v1/data",
  },
  {
    route: "vendor_report",
    name: "Lumi Trades: x402 seller reputation report (full observation history)",
    method: "GET",
    path: "/v1/trust/vendors/{id}/report",
    template: "/v1/trust/vendors/{id}/report",
    summary:
      "Use this when you need evidence before paying an x402 vendor on Lumi's trust list: the full observation history. Every free 402-quote check (90-day retention) " +
      "with status, quoted price and latency; every paid test-buy with amount, ledger tx hash, explorer link and delivered yes/no; latency stats " +
      "(min/p50/p90/p95/max) and the 7-day trend; uptime % over 24h/7d/30d/90d and a daily series; per-endpoint quoted-price history; " +
      "agent reports; vendor replies; score components, sample sizes and confidence labels. Automated observations, not a rating. " +
      "Not sold (503, not charged) when the vendor has no observation in the last 48 h. The free summary is GET /v1/trust/vendors/{id}.",
    example: "/v1/trust/vendors/printmoneylab/report",
  },
];

/**
 * GET /v1/verdict, listed as a paid resource only when the owner switches VERDICT_PRICING to "paid" (legal review M3).
 * In the default free mode it is a free, rate-limited alias of /v1/check and appears under free endpoints instead.
 */
export const VERDICT_ENDPOINT: PaidEndpoint = {
  route: "verdict",
  name: "Lumi Trades: check before paying, one label (checks_passed / check_first / checks_failed / no_data)",
  method: "GET",
  path: "/v1/verdict",
  template: "/v1/verdict",
  summary:
    "Use this before your agent pays an x402 URL or seller domain: one label from the same data and signing key as the free /v1/check: checks_passed (Delivered in recent checks), check_first (Check first), checks_failed (Recent checks failed) or no_data (Not enough data), with as_of, evidence window, conclusive test-buy count, last delivered/failed dates, reason codes, evidence and appeal links, and observed on-chain payments as ranges only. Paying Lumi never changes a result. Observations, not a guarantee. Not charged on bad input.",
  example: "/v1/verdict?url=https://api.example.com/v1/data",
};

/** Every endpoint sold over x402 under this config (adds /v1/verdict only in paid mode). */
export function paidEndpoints(cfg: Pick<Config, "verdictPaid">): PaidEndpoint[] {
  return cfg.verdictPaid ? [...PAID_ENDPOINTS, VERDICT_ENDPOINT] : PAID_ENDPOINTS;
}

/** Catalog entry for a paid route, including /v1/verdict (whether or not it is currently priced). */
export function endpointFor(route: PaidRoute): PaidEndpoint {
  const e = route === "verdict" ? VERDICT_ENDPOINT : PAID_ENDPOINTS.find((x) => x.route === route);
  if (!e) throw new Error(`no catalog entry for paid route ${route}`);
  return e;
}

export function priceTable(cfg: Config) {
  return paidEndpoints(cfg).map((e) => ({
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
