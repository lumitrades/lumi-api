/**
 * Product lines. Everything is sold under one brand, Lumi Trades. The paid routes fall into three groups: market
 * readings (signal, lite, scan, levels, slate: mechanical momentum/trend readings, no trade plans), market data (market,
 * brief, sentiment, Fear & Greed, events, funding, yen, institutional) and seller checks (pay-check, verdict, vendor
 * reports, badges, monitoring, feed).
 *
 * Market-readings responses carry `product_line` and `notice` (JSON) and the X-Lumi-Product-Line / X-Lumi-Notice
 * headers. Prices are unchanged.
 */
import type { PaidRoute } from "./config";

export const BRAND = "Lumi Trades";
/** Name of the market-readings group (kept as MARKET_IDEAS_* for code compatibility). */
export const MARKET_IDEAS_NAME = "Lumi Trades market readings";
export const MARKET_IDEAS_NOTICE =
  "Rule-based readings, not investment advice. Lumi does not trade real money.";
/** One-line label used at the start of descriptions. */
export const MARKET_IDEAS_LABEL = `${MARKET_IDEAS_NAME}: ${MARKET_IDEAS_NOTICE}`;

/** Paid routes in the market-readings group (signal, lite, scan, slate and levels). */
export const MARKET_IDEAS_ROUTES: PaidRoute[] = ["signal", "lite", "scan", "slate", "levels"];
/** Response `kind` values of the market-readings routes. */
export const MARKET_IDEAS_KINDS = ["signal", "signal_lite", "scan", "slate", "levels"];
/** MCP tools of the market-readings routes. */
export const MARKET_IDEAS_TOOLS = ["lumi_signal", "lumi_lite", "lumi_scan", "lumi_slate", "lumi_levels"];
/** Seller-check paid routes. */
export const TRUST_LINE_ROUTES: PaidRoute[] = ["trust_check", "vendor_report", "verdict"];

export type ProductLine = "market_ideas" | "market_data" | "trust";
export const LINE_LABEL: Record<ProductLine, string> = {
  market_ideas: MARKET_IDEAS_NAME,
  market_data: "Lumi Trades market data",
  trust: "Lumi Trades seller checks",
};

export function productLine(route: PaidRoute): ProductLine {
  return MARKET_IDEAS_ROUTES.includes(route) ? "market_ideas" : TRUST_LINE_ROUTES.includes(route) ? "trust" : "market_data";
}
export const isMarketIdeas = (route: PaidRoute) => MARKET_IDEAS_ROUTES.includes(route);

/** OpenAPI tag names (one per product line, plus the free badge and plan groups). */
export const OPENAPI_TAG: Record<ProductLine, string> = {
  market_ideas: MARKET_IDEAS_NAME,
  market_data: "market data",
  trust: "trust",
};
export const OPENAPI_TAGS = [
  { name: "trust", description: "Lumi Trades seller checks: should I pay this x402 URL?, vendor observations and reports, signed receipts. Observations, not ratings or advice." },
  { name: "badge", description: "Lumi Trades seller checks: free 'Tested by Lumi' badges and public result pages." },
  { name: "market data", description: "Lumi Trades market data: BTC/macro backdrop, daily brief, sentiment, Fear & Greed, funding, events, yen watch and the daily policy brief." },
  { name: MARKET_IDEAS_NAME, description: `${MARKET_IDEAS_NAME}: per-coin momentum/trend bias with score, lite reads, the all-coins scan, support/resistance levels and the watchlist slate. ${MARKET_IDEAS_NOTICE}` },
];

/** Paths served by the market-readings routes (concrete or template). */
export const MARKET_IDEAS_PATH_RE = /^\/v1\/(?:(?:signal|lite|levels)\/[^/]+|scan|slate)$/;
export const HEADER_PRODUCT_LINE = "X-Lumi-Product-Line";
export const HEADER_NOTICE = "X-Lumi-Notice";
export const MARKET_IDEAS_HEADERS: Record<string, string> = { [HEADER_PRODUCT_LINE]: MARKET_IDEAS_NAME, [HEADER_NOTICE]: MARKET_IDEAS_NOTICE };

/** Disclaimer on trust responses (no trading wording). */
export const TRUST_DISCLAIMER =
  "Automated observations by Lumi, not a rating, endorsement or guarantee. Not financial advice.";
