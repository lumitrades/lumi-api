/**
 * Product lines. Lumi's trading-signal style endpoints are grouped as "Lumi Market Ideas" (paper-trade analysis) and
 * kept apart from the trust layer (Lumi Trust: pay-check, vendor reports, badges, monitoring, feed) and from neutral
 * market data (market, brief, sentiment, Fear & Greed, events, funding, yen, institutional).
 *
 * Market Ideas responses keep every existing field and price; they only gain `product_line` and `notice` (JSON) and the
 * X-Lumi-Product-Line / X-Lumi-Notice headers, so the change is backward compatible.
 */
import type { PaidRoute } from "./config";

export const MARKET_IDEAS_NAME = "Lumi Market Ideas";
export const MARKET_IDEAS_NOTICE = "Paper-trade analysis, not investment advice. Lumi does not trade real money.";
/** One-line label used at the start of descriptions. */
export const MARKET_IDEAS_LABEL = `${MARKET_IDEAS_NAME}: ${MARKET_IDEAS_NOTICE}`;

/** Paid routes in Lumi Market Ideas (signal, lite, scan, slate, trades and levels). */
export const MARKET_IDEAS_ROUTES: PaidRoute[] = ["signal", "lite", "scan", "slate", "trades", "levels"];
/** Response `kind` values of the Market Ideas routes. */
export const MARKET_IDEAS_KINDS = ["signal", "signal_lite", "scan", "slate", "trades", "levels"];
/** MCP tools of the Market Ideas routes. */
export const MARKET_IDEAS_TOOLS = ["lumi_signal", "lumi_lite", "lumi_scan", "lumi_slate", "lumi_trades", "lumi_levels"];
/** Trust-branded paid routes (Lumi Trust). */
export const TRUST_LINE_ROUTES: PaidRoute[] = ["trust_check", "vendor_report"];

export type ProductLine = "market_ideas" | "market_data" | "trust";
export const LINE_LABEL: Record<ProductLine, string> = {
  market_ideas: MARKET_IDEAS_NAME,
  market_data: "Market data",
  trust: "Lumi Trust",
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
  { name: "trust", description: "Lumi Trust: should I pay this x402 URL?, vendor observations and reports, signed receipts. Observations, not ratings or advice." },
  { name: "badge", description: "Lumi Trust: free 'Tested by Lumi' badges and public result pages." },
  { name: "market data", description: "Neutral crypto market data: BTC/macro backdrop, daily brief, sentiment, Fear & Greed, funding, events, yen watch and the daily policy brief." },
  { name: MARKET_IDEAS_NAME, description: `${MARKET_IDEAS_NAME}: per-coin signals, lite reads, the all-coins scan, levels, the paper-trade slate and history. ${MARKET_IDEAS_NOTICE}` },
];

/** Paths served by the Market Ideas routes (concrete or template). */
export const MARKET_IDEAS_PATH_RE = /^\/v1\/(?:(?:signal|lite|levels)\/[^/]+|scan|slate|trades)$/;
export const HEADER_PRODUCT_LINE = "X-Lumi-Product-Line";
export const HEADER_NOTICE = "X-Lumi-Notice";
export const MARKET_IDEAS_HEADERS: Record<string, string> = { [HEADER_PRODUCT_LINE]: MARKET_IDEAS_NAME, [HEADER_NOTICE]: MARKET_IDEAS_NOTICE };

/** Disclaimer on trust responses (no trading or paper-trade wording). */
export const TRUST_DISCLAIMER =
  "Automated observations by Lumi, not a rating, endorsement or guarantee. Not financial advice.";
