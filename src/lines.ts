/**
 * Product lines. Everything is sold under one brand, Lumi Trades. The paid routes fall into two groups: seller checks
 * (pay-check, verdict, vendor reports, badges, monitoring, feed) and market data (market backdrop, sentiment, Fear & Greed,
 * events, funding, yen watch, institutional policy brief). The per-coin readings group (signal, lite, scan, levels, slate)
 * and the daily market brief were retired on 2026-10-25 and answer 410 Gone (src/retired.ts).
 */
import type { PaidRoute } from "./config";

export const BRAND = "Lumi Trades";

/** Seller-check paid routes. */
export const TRUST_LINE_ROUTES: PaidRoute[] = ["trust_check", "vendor_report", "verdict"];

export type ProductLine = "market_data" | "trust";
export const LINE_LABEL: Record<ProductLine, string> = {
  market_data: "Lumi Trades market data",
  trust: "Lumi Trades seller checks",
};

export function productLine(route: PaidRoute): ProductLine {
  return TRUST_LINE_ROUTES.includes(route) ? "trust" : "market_data";
}

/** OpenAPI tag names (one per product line, plus the free badge and plan groups). */
export const OPENAPI_TAG: Record<ProductLine, string> = {
  market_data: "market data",
  trust: "trust",
};
export const OPENAPI_TAGS = [
  { name: "trust", description: "Lumi Trades seller checks: should I pay this x402 URL?, vendor observations and reports, signed receipts. Observations, not ratings or advice." },
  { name: "badge", description: "Lumi Trades seller checks: free 'Tested by Lumi' badges and public result pages." },
  { name: "market data", description: "Lumi Trades market data: BTC/macro backdrop, sentiment, Fear & Greed, funding, events, yen watch and the daily policy brief. Neutral data, no trade calls." },
];

/** Disclaimer on trust responses (no trading wording). */
export const TRUST_DISCLAIMER =
  "Automated observations by Lumi, not a rating, endorsement or guarantee. Not financial advice.";
