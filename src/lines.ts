/**
 * Product lines. Everything is sold under one brand, Lumi Trades, and every paid route is a seller check (pay-check,
 * verdict, vendor reports, badges, monitoring, feed). All other data routes were retired on 2026-10-25 and answer
 * 410 Gone (src/retired.ts).
 */
import type { PaidRoute } from "./config";

export const BRAND = "Lumi Trades";

/** Seller-check paid routes (all paid routes). */
export const TRUST_LINE_ROUTES: PaidRoute[] = ["trust_check", "vendor_report", "verdict", "receipts", "batch_check"];

export type ProductLine = "trust";
export const LINE_LABEL: Record<ProductLine, string> = {
  trust: "Lumi Trades seller checks",
};

export function productLine(_route: PaidRoute): ProductLine {
  return "trust";
}

/** OpenAPI tag names (one per product line, plus the free badge and plan groups). */
export const OPENAPI_TAG: Record<ProductLine, string> = {
  trust: "trust",
};
export const OPENAPI_TAGS = [
  { name: "trust", description: "Lumi Trades seller checks: should I pay this x402 URL?, vendor observations and reports, signed receipts. Observations, not ratings or advice." },
  { name: "badge", description: "Lumi Trades seller checks: free 'Tested by Lumi' badges and public result pages." },
];

/** Disclaimer on trust responses. */
export const TRUST_DISCLAIMER =
  "Automated observations by Lumi, not a rating, endorsement or guarantee. Not financial advice.";
